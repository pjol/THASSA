package chain

import (
	"context"
	"crypto/ecdsa"
	"fmt"
	"math/big"
	"strings"
	"time"

	ethabi "github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	ethereum "github.com/ethereum/go-ethereum"

	abijson "github.com/pjol/THASSA/backend/abi"
	"github.com/pjol/THASSA/backend/internal/config"
)

// Client wraps the RPC connection, parsed ABIs, and the relayer key.
type Client struct {
	Eth     *ethclient.Client
	ChainID int64

	Markets common.Address
	Token   common.Address
	Hub     common.Address

	MarketsABI ethabi.ABI
	TokenABI   ethabi.ABI

	// Relayer signing key (nil when chain services are disabled).
	Key     *ecdsa.PrivateKey
	Relayer common.Address

	// Payment-token decimals, read from chain (falls back to 6).
	Decimals int
	Unit     int64
}

// Dial connects and loads ABIs + token decimals.
func Dial(ctx context.Context, cfg *config.Config) (*Client, error) {
	eth, err := ethclient.DialContext(ctx, cfg.ChainRPCURL)
	if err != nil {
		return nil, fmt.Errorf("chain dial: %w", err)
	}
	marketsABI, err := ethabi.JSON(strings.NewReader(abijson.ThassaMarkets))
	if err != nil {
		return nil, fmt.Errorf("markets abi: %w", err)
	}
	tokenABI, err := ethabi.JSON(strings.NewReader(abijson.PaymentToken))
	if err != nil {
		return nil, fmt.Errorf("token abi: %w", err)
	}
	c := &Client{
		Eth:        eth,
		ChainID:    cfg.ChainID,
		Markets:    common.HexToAddress(cfg.MarketsContractAddr),
		Token:      common.HexToAddress(cfg.PaymentTokenAddress),
		Hub:        common.HexToAddress(cfg.HubAddress),
		MarketsABI: marketsABI,
		TokenABI:   tokenABI,
		Decimals:   6,
	}
	if cfg.RelayerPrivateKey != "" {
		key, err := crypto.HexToECDSA(strings.TrimPrefix(cfg.RelayerPrivateKey, "0x"))
		if err != nil {
			return nil, fmt.Errorf("relayer key: %w", err)
		}
		c.Key = key
		c.Relayer = crypto.PubkeyToAddress(key.PublicKey)
	}
	if d, err := c.readDecimals(ctx); err == nil {
		c.Decimals = d
	}
	c.Unit = TokenUnit(c.Decimals)
	return c, nil
}

func (c *Client) readDecimals(ctx context.Context) (int, error) {
	out, err := c.callView(ctx, c.Token, c.TokenABI, "decimals")
	if err != nil || len(out) == 0 {
		return 0, fmt.Errorf("decimals: %w", err)
	}
	d, ok := out[0].(uint8)
	if !ok {
		return 0, fmt.Errorf("decimals: bad type")
	}
	return int(d), nil
}

// BalanceOf reads the payment-token balance of an address (token units).
func (c *Client) BalanceOf(ctx context.Context, addr common.Address) (*big.Int, error) {
	out, err := c.callView(ctx, c.Token, c.TokenABI, "balanceOf", addr)
	if err != nil || len(out) == 0 {
		return nil, fmt.Errorf("balanceOf: %w", err)
	}
	b, ok := out[0].(*big.Int)
	if !ok {
		return nil, fmt.Errorf("balanceOf: bad type")
	}
	return b, nil
}

// MakerNonce reads the contract's per-maker order nonce.
func (c *Client) MakerNonce(ctx context.Context, maker common.Address) (int64, error) {
	out, err := c.callView(ctx, c.Markets, c.MarketsABI, "nonces", maker)
	if err != nil || len(out) == 0 {
		return 0, fmt.Errorf("nonces: %w", err)
	}
	n, ok := out[0].(*big.Int)
	if !ok {
		return 0, fmt.Errorf("nonces: bad type")
	}
	return n.Int64(), nil
}

// BestPrices reads the contract's best bid per side.
func (c *Client) BestPrices(ctx context.Context, chainMarketID int64) (bestYes, bestNo uint8, err error) {
	out, err := c.callView(ctx, c.Markets, c.MarketsABI, "bestPrices", big.NewInt(chainMarketID))
	if err != nil || len(out) < 2 {
		return 0, 0, fmt.Errorf("bestPrices: %w", err)
	}
	y, _ := out[0].(uint8)
	n, _ := out[1].(uint8)
	return y, n, nil
}

func (c *Client) callView(ctx context.Context, to common.Address, a ethabi.ABI, method string, args ...any) ([]any, error) {
	data, err := a.Pack(method, args...)
	if err != nil {
		return nil, err
	}
	res, err := c.Eth.CallContract(ctx, ethereum.CallMsg{To: &to, Data: data}, nil)
	if err != nil {
		return nil, err
	}
	return a.Unpack(method, res)
}

// SubmitTx signs and broadcasts calldata to an allowlisted target using a
// pre-reserved nonce (durable in relayer_txs). Returns the tx hash.
func (c *Client) SubmitTx(ctx context.Context, nonce uint64, to common.Address, data []byte) (common.Hash, error) {
	if c.Key == nil {
		return common.Hash{}, fmt.Errorf("relayer key not configured")
	}
	gasPrice, err := c.Eth.SuggestGasPrice(ctx)
	if err != nil {
		return common.Hash{}, fmt.Errorf("gas price: %w", err)
	}
	gas, err := c.Eth.EstimateGas(ctx, ethereum.CallMsg{From: c.Relayer, To: &to, Data: data})
	if err != nil {
		return common.Hash{}, fmt.Errorf("estimate gas: %w", err)
	}
	tx := types.NewTx(&types.LegacyTx{
		Nonce:    nonce,
		To:       &to,
		Gas:      gas + gas/5, // 20% headroom
		GasPrice: gasPrice,
		Data:     data,
	})
	signed, err := types.SignTx(tx, types.LatestSignerForChainID(big.NewInt(c.ChainID)), c.Key)
	if err != nil {
		return common.Hash{}, fmt.Errorf("sign tx: %w", err)
	}
	if err := c.Eth.SendTransaction(ctx, signed); err != nil {
		return common.Hash{}, fmt.Errorf("send tx: %w", err)
	}
	return signed.Hash(), nil
}

// WaitReceipt polls for the receipt (bounded).
func (c *Client) WaitReceipt(ctx context.Context, hash common.Hash, timeout time.Duration) (*types.Receipt, error) {
	deadline := time.Now().Add(timeout)
	for {
		r, err := c.Eth.TransactionReceipt(ctx, hash)
		if err == nil && r != nil {
			return r, nil
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("receipt timeout for %s", hash)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
}
