// On-chain market deployment for the seeder (spec §9). When chain config and
// funded signer keys are available, a subset of the seeded markets (the live
// OPEN/MATCHED ones) are created for real on the local ThassaMarkets contract:
// the creator signs the opening order (EIP-712) plus its EIP-3009 payment
// authorization (authNonce == order digest, exactly as the relayer builds it),
// the contract assigns a real chain_market_id, and a couple of orders from
// OTHER funded wallets add live, takeable depth. The resulting chain state is
// mirrored into the DB, replacing that market's placeholder fake-chain book.
//
// Robustness: every on-chain step for a market is best-effort. Any failure logs
// and leaves the market's already-seeded fake-chain row/book in place (a clean
// fallback) rather than aborting the seed. DB mirroring is collision-safe with
// the running indexer — every mirrored log is claimed in chain_events (the
// indexer's exactly-once gate), so the indexer never re-applies it.
package main

import (
	"context"
	"crypto/ecdsa"
	"fmt"
	"log"
	"math/big"
	"os"
	"strings"
	"time"

	ethereum "github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pjol/THASSA/backend/internal/chain"
	"github.com/pjol/THASSA/backend/internal/config"
)

// fundedKey is a dev signer key with its derived address.
type fundedKey struct {
	key  *ecdsa.PrivateKey
	addr common.Address
}

// fundedUsernames is the priority order in which parsed funded keys are bound
// to seed users. The mix (creators + order makers interleaved) lets markets
// still form when only a few keys are supplied: a market goes live only when
// its creator and at least one of its OTHER order makers are both funded.
var fundedUsernames = []string{"kai", "petra", "sasha", "maren", "rafe", "diego"}

// parseFundedKeys reads SEED_FUNDED_KEYS (comma-separated hex private keys),
// falling back to RELAYER_PRIVATE_KEY. Invalid entries are skipped with a log.
func parseFundedKeys(cfg *config.Config) []fundedKey {
	raw := os.Getenv("SEED_FUNDED_KEYS")
	if strings.TrimSpace(raw) == "" {
		raw = cfg.RelayerPrivateKey
	}
	var out []fundedKey
	seen := map[common.Address]bool{}
	for _, part := range strings.Split(raw, ",") {
		h := strings.TrimSpace(part)
		if h == "" {
			continue
		}
		key, err := crypto.HexToECDSA(strings.TrimPrefix(h, "0x"))
		if err != nil {
			log.Printf("seed: skipping invalid funded key: %v", err)
			continue
		}
		addr := crypto.PubkeyToAddress(key.PublicKey)
		if seen[addr] {
			continue
		}
		seen[addr] = true
		out = append(out, fundedKey{key: key, addr: addr})
	}
	return out
}

// liveOrderSpec is one order placed against a live market by a funded seed user.
type liveOrderSpec struct {
	makerUser string
	side      string // "yes" | "no"
	price     int    // cents 1..99
	shares    int64
}

// liveMarketPlan is a seeded market queued for real on-chain creation.
type liveMarketPlan struct {
	marketID   uuid.UUID
	creatorID  uuid.UUID
	creator    string // username
	question   string
	settlement string // settlement_query JSON string (goes on-chain verbatim)
	opening    liveOrderSpec
	takers     []liveOrderSpec
	matched    bool // opening order is fully taken → market ends MATCHED
}

// liveDeployer owns the chain client, funded keys, and the token EIP-712 domain
// needed to sign EIP-3009 payment authorizations.
type liveDeployer struct {
	ctx     context.Context
	pool    *pgxpool.Pool
	client  *chain.Client
	byUser  map[string]fundedKey // username → funded key (only funded users)
	tokenDS common.Hash          // payment-token EIP-712 domain separator
	cent    int64
}

// receive3009TypeHash is the EIP-3009 ReceiveWithAuthorization struct type hash
// (the MockUSD/Tempo payment token type, spec §9).
var receive3009TypeHash = crypto.Keccak256Hash(
	[]byte("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"))

var eip712DomainTypeHash = crypto.Keccak256Hash(
	[]byte("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"))

// newLiveDeployer dials the chain and reads the payment token's EIP-712 domain.
// Returns nil (no error) when on-chain deployment is not possible/desired.
func newLiveDeployer(ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, keys []fundedKey) *liveDeployer {
	if cfg.ChainRPCURL == "" || cfg.MarketsContractAddr == "" || cfg.PaymentTokenAddress == "" || len(keys) == 0 {
		log.Printf("seed: on-chain deploy disabled (missing chain config or funded keys) — using fake-chain markets")
		return nil
	}
	client, err := chain.Dial(ctx, cfg)
	if err != nil {
		log.Printf("seed: on-chain deploy disabled (chain dial failed: %v) — using fake-chain markets", err)
		return nil
	}
	d := &liveDeployer{
		ctx:    ctx,
		pool:   pool,
		client: client,
		byUser: map[string]fundedKey{},
		cent:   client.Unit / 100,
	}
	for i, k := range keys {
		if i >= len(fundedUsernames) {
			break
		}
		d.byUser[fundedUsernames[i]] = k
	}
	ds, err := d.readTokenDomainSeparator()
	if err != nil {
		log.Printf("seed: on-chain deploy disabled (token EIP-712 domain read failed: %v) — using fake-chain markets", err)
		return nil
	}
	d.tokenDS = ds
	log.Printf("seed: on-chain deploy enabled (markets=%s token=%s funded_users=%d)",
		client.Markets.Hex(), client.Token.Hex(), len(d.byUser))
	return d
}

// addrForUser returns the funded address for a seed username, if any.
func (d *liveDeployer) addrForUser(username string) (common.Address, bool) {
	k, ok := d.byUser[username]
	return k.addr, ok
}

// isFunded reports whether a seed username is backed by a funded key.
func (d *liveDeployer) isFunded(username string) bool {
	_, ok := d.byUser[username]
	return ok
}

// readTokenDomainSeparator reads the payment token's EIP-712 domain via
// eip712Domain() (EIP-5267) and computes its domain separator — the token's own
// name/version, read from chain, so the EIP-3009 signature is authoritative.
func (d *liveDeployer) readTokenDomainSeparator() (common.Hash, error) {
	data, err := d.client.TokenABI.Pack("eip712Domain")
	if err != nil {
		return common.Hash{}, err
	}
	res, err := d.client.Eth.CallContract(d.ctx, ethereum.CallMsg{To: &d.client.Token, Data: data}, nil)
	if err != nil {
		return common.Hash{}, err
	}
	out, err := d.client.TokenABI.Unpack("eip712Domain", res)
	if err != nil || len(out) < 5 {
		return common.Hash{}, fmt.Errorf("eip712Domain unpack: %w", err)
	}
	name, _ := out[1].(string)
	version, _ := out[2].(string)
	chainID, _ := out[3].(*big.Int)
	vc, _ := out[4].(common.Address)
	if chainID == nil {
		chainID = big.NewInt(d.client.ChainID)
	}
	return crypto.Keccak256Hash(
		eip712DomainTypeHash.Bytes(),
		crypto.Keccak256([]byte(name)),
		crypto.Keccak256([]byte(version)),
		uint256Word(chainID),
		addressWord(vc),
	), nil
}

// signReceiveAuth signs an EIP-3009 ReceiveWithAuthorization (from → markets
// contract) with the maker's key. nonce is the order's EIP-712 digest, binding
// the funding signature to exactly one order (spec §9 signature carriage).
func (d *liveDeployer) signReceiveAuth(key *ecdsa.PrivateKey, from, to common.Address, value, validAfter, validBefore int64, nonce common.Hash) (uint8, [32]byte, [32]byte, error) {
	structHash := crypto.Keccak256Hash(
		receive3009TypeHash.Bytes(),
		addressWord(from),
		addressWord(to),
		uint256Word(big.NewInt(value)),
		uint256Word(big.NewInt(validAfter)),
		uint256Word(big.NewInt(validBefore)),
		nonce.Bytes(),
	)
	digest := crypto.Keccak256Hash([]byte{0x19, 0x01}, d.tokenDS.Bytes(), structHash.Bytes())
	sig, err := crypto.Sign(digest.Bytes(), key)
	if err != nil {
		return 0, [32]byte{}, [32]byte{}, err
	}
	var r, s [32]byte
	copy(r[:], sig[0:32])
	copy(s[:], sig[32:64])
	return sig[64] + 27, r, s, nil // contract's ECDSA.recover expects v ∈ {27,28}
}

// mint credits amount payment-token base units to addr (MockUSD open faucet).
func (d *liveDeployer) mint(from *ecdsa.PrivateKey, to common.Address, amount int64) error {
	data, err := d.client.TokenABI.Pack("mint", to, big.NewInt(amount))
	if err != nil {
		return err
	}
	hash, err := d.sendTx(from, d.client.Token, data)
	if err != nil {
		return err
	}
	rcpt, err := d.client.WaitReceipt(d.ctx, hash, 60*time.Second)
	if err != nil || rcpt.Status != 1 {
		return fmt.Errorf("mint tx failed: %v", err)
	}
	return nil
}

// sendTx signs and broadcasts a legacy tx from an arbitrary funded key (its own
// nonce space — never the relayer's, so it can't collide with the live relayer).
func (d *liveDeployer) sendTx(key *ecdsa.PrivateKey, to common.Address, data []byte) (common.Hash, error) {
	from := crypto.PubkeyToAddress(key.PublicKey)
	nonce, err := d.client.Eth.PendingNonceAt(d.ctx, from)
	if err != nil {
		return common.Hash{}, fmt.Errorf("nonce: %w", err)
	}
	gasPrice, err := d.client.Eth.SuggestGasPrice(d.ctx)
	if err != nil {
		return common.Hash{}, fmt.Errorf("gas price: %w", err)
	}
	gas, err := d.client.Eth.EstimateGas(d.ctx, ethereum.CallMsg{From: from, To: &to, Data: data})
	if err != nil {
		return common.Hash{}, fmt.Errorf("estimate gas (likely revert): %w", err)
	}
	tx := types.NewTx(&types.LegacyTx{
		Nonce:    nonce,
		To:       &to,
		Gas:      gas + gas/4,
		GasPrice: gasPrice,
		Data:     data,
	})
	signed, err := types.SignTx(tx, types.LatestSignerForChainID(big.NewInt(d.client.ChainID)), key)
	if err != nil {
		return common.Hash{}, fmt.Errorf("sign: %w", err)
	}
	if err := d.client.Eth.SendTransaction(d.ctx, signed); err != nil {
		return common.Hash{}, fmt.Errorf("send: %w", err)
	}
	return signed.Hash(), nil
}

// signedOrder builds a maker's typed order (bound to chainMarketID — 0 for the
// opening order of a not-yet-created market) plus the EIP-3009 auth funding it.
// maxCost/authValue cover the contract's worst-case bound (escrow + taker fee +
// share headroom) so both createMarket and placeOrdersBatch accept the order.
func (d *liveDeployer) signedOrder(spec liveOrderSpec, maker fundedKey, nonce, chainMarketID int64) (chain.ABIOrder, chain.ABIAuth, common.Hash, int64, error) {
	side := uint8(0)
	if spec.side == "no" {
		side = 1
	}
	unit := d.client.Unit
	worst := chain.Escrow(spec.shares, spec.price, unit) + chain.TakerFee(spec.shares, spec.price, unit) + spec.shares + unit
	now := time.Now().Unix()
	order := chain.Order{
		MarketID:        big.NewInt(chainMarketID),
		Side:            side,
		Price:           uint8(spec.price),
		Shares:          spec.shares,
		MaxCost:         worst,
		AffiliatePostID: big.NewInt(0),
		Expiry:          now + 24*3600,
		Nonce:           nonce,
		Maker:           maker.addr,
	}
	return d.finishOrder(order, maker, worst, now)
}

func (d *liveDeployer) finishOrder(order chain.Order, maker fundedKey, worst, now int64) (chain.ABIOrder, chain.ABIAuth, common.Hash, int64, error) {
	digest := chain.OrderDigest(order, d.client.ChainID, d.client.Markets)
	v, r, s, err := d.signReceiveAuth(maker.key, maker.addr, d.client.Markets, worst, now-3600, now+24*3600, digest)
	if err != nil {
		return chain.ABIOrder{}, chain.ABIAuth{}, common.Hash{}, 0, err
	}
	auth := chain.ABIAuth{
		Value:       big.NewInt(worst),
		ValidAfter:  big.NewInt(now - 3600),
		ValidBefore: big.NewInt(now + 24*3600),
		AuthNonce:   digest,
		V:           v,
		R:           r,
		S:           s,
	}
	return order.ABI(), auth, digest, worst, nil
}

// placedLog / matchedLog are the parsed events we mirror.
type placedLog struct {
	chainOrderID int64
	maker        common.Address
	side         string
	price        int
	shares       int64
	txHash       string
	logIndex     int
	block        int64
}

type matchedLog struct {
	takerChain int64
	makerChain int64
	price      int
	shares     int64
	fee        int64
	txHash     string
	logIndex   int
	block      int64
}

// claimRef identifies a single markets-contract log to fence off in chain_events.
type claimRef struct {
	txHash   string
	logIndex int
	name     string
	block    int64
}

// parseReceipt extracts the market/order/match events emitted to the markets
// contract by a confirmed tx. events lists every markets-contract log (claimed
// in chain_events so the indexer treats them as already-processed).
func (d *liveDeployer) parseReceipt(rcpt *types.Receipt) (marketCreated int64, placed []placedLog, matched []matchedLog, marketMatched bool, rejected []string, events []claimRef) {
	a := d.client.MarketsABI
	for _, lg := range rcpt.Logs {
		if lg.Address != d.client.Markets || len(lg.Topics) == 0 {
			continue
		}
		ev, err := a.EventByID(lg.Topics[0])
		if err != nil {
			continue
		}
		events = append(events, claimRef{txHash: lg.TxHash.Hex(), logIndex: int(lg.Index), name: ev.Name, block: int64(lg.BlockNumber)})
		data := map[string]any{}
		if len(lg.Data) > 0 {
			_ = a.UnpackIntoMap(data, ev.Name, lg.Data)
		}
		switch ev.Name {
		case "MarketCreated":
			if len(lg.Topics) > 1 {
				marketCreated = new(big.Int).SetBytes(lg.Topics[1].Bytes()).Int64()
			}
		case "OrderPlaced":
			p := placedLog{txHash: lg.TxHash.Hex(), logIndex: int(lg.Index), block: int64(lg.BlockNumber)}
			if len(lg.Topics) > 2 {
				p.chainOrderID = new(big.Int).SetBytes(lg.Topics[2].Bytes()).Int64()
			}
			if len(lg.Topics) > 3 {
				p.maker = common.BytesToAddress(lg.Topics[3].Bytes())
			}
			p.side = "yes"
			if bi, ok := data["side"].(uint8); ok && bi == 1 {
				p.side = "no"
			}
			p.price = int(toUint8(data["price"]))
			p.shares = toInt64(data["shares"])
			placed = append(placed, p)
		case "OrderMatched":
			m := matchedLog{txHash: lg.TxHash.Hex(), logIndex: int(lg.Index), block: int64(lg.BlockNumber)}
			m.takerChain = toInt64(data["takerOrderId"])
			m.makerChain = toInt64(data["makerOrderId"])
			m.price = int(toUint8(data["price"]))
			m.shares = toInt64(data["shares"])
			m.fee = toInt64(data["fee"])
			matched = append(matched, m)
		case "MarketMatched":
			marketMatched = true
		case "OrderRejected":
			reason, _ := data["reason"].(string)
			rejected = append(rejected, reason)
		}
	}
	return
}

// deployAll creates each planned live market on-chain and mirrors it into the
// DB, replacing that market's fake-chain book. Best-effort per market. After
// all markets it recomputes the seed entry-stat aggregates so the on-chain
// orders are reflected exactly once (the indexer is fenced off via chain_events).
func (d *liveDeployer) deployAll(plans []liveMarketPlan) {
	if len(plans) == 0 {
		return
	}
	// Fund every participating wallet with payment tokens up front (open faucet).
	funded := map[common.Address]bool{}
	for _, p := range plans {
		users := append([]liveOrderSpec{p.opening}, p.takers...)
		for _, o := range users {
			if k, ok := d.byUser[o.makerUser]; ok && !funded[k.addr] {
				if err := d.mint(k.key, k.addr, 100_000*d.client.Unit); err != nil {
					log.Printf("seed: mint to %s (%s) failed: %v", o.makerUser, k.addr.Hex(), err)
				}
				funded[k.addr] = true
			}
		}
	}

	deployed := 0
	for _, p := range plans {
		if err := d.deployOne(p); err != nil {
			log.Printf("seed: on-chain deploy of %q failed (%v) — keeping fake-chain book", p.question, err)
			continue
		}
		deployed++
	}
	if deployed > 0 {
		d.recomputeEntryStats()
	}
	log.Printf("seed: on-chain markets deployed=%d/%d", deployed, len(plans))
}

func (d *liveDeployer) deployOne(p liveMarketPlan) error {
	creator, ok := d.byUser[p.creator]
	if !ok {
		return fmt.Errorf("creator %q not funded", p.creator)
	}

	// 1. createMarket — creator signs the opening order + EIP-3009 auth.
	openNonce, err := d.client.MakerNonce(d.ctx, creator.addr)
	if err != nil {
		return fmt.Errorf("maker nonce: %w", err)
	}
	openOrder, openAuth, _, _, err := d.signedOrder(p.opening, creator, openNonce, 0)
	if err != nil {
		return fmt.Errorf("sign opening order: %w", err)
	}
	data, err := d.client.MarketsABI.Pack("createMarket", p.question, p.settlement, openOrder, openAuth)
	if err != nil {
		return fmt.Errorf("pack createMarket: %w", err)
	}
	hash, err := d.sendTx(creator.key, d.client.Markets, data)
	if err != nil {
		return fmt.Errorf("createMarket submit: %w", err)
	}
	rcpt, err := d.client.WaitReceipt(d.ctx, hash, 90*time.Second)
	if err != nil || rcpt.Status != 1 {
		return fmt.Errorf("createMarket tx failed: %v", err)
	}
	chainMarketID, placed, _, _, rej, events := d.parseReceipt(rcpt)
	if chainMarketID == 0 {
		return fmt.Errorf("no MarketCreated event")
	}
	if len(rej) > 0 {
		return fmt.Errorf("opening order rejected: %v", rej)
	}
	allPlaced := placed
	allEvents := events
	var allMatched []matchedLog
	marketMatched := false

	// 2. placeOrdersBatch — OTHER funded makers add live, takeable depth.
	var orders []chain.ABIOrder
	var auths []chain.ABIAuth
	for _, t := range p.takers {
		mk, ok := d.byUser[t.makerUser]
		if !ok {
			continue
		}
		n, err := d.client.MakerNonce(d.ctx, mk.addr)
		if err != nil {
			return fmt.Errorf("taker nonce: %w", err)
		}
		o, au, _, _, err := d.signedOrder(t, mk, n, chainMarketID)
		if err != nil {
			return fmt.Errorf("sign taker order: %w", err)
		}
		orders = append(orders, o)
		auths = append(auths, au)
	}
	if len(orders) > 0 {
		bdata, err := d.client.MarketsABI.Pack("placeOrdersBatch", orders, auths)
		if err != nil {
			return fmt.Errorf("pack placeOrdersBatch: %w", err)
		}
		bhash, err := d.sendTx(creator.key, d.client.Markets, bdata)
		if err != nil {
			return fmt.Errorf("placeOrdersBatch submit: %w", err)
		}
		brcpt, err := d.client.WaitReceipt(d.ctx, bhash, 90*time.Second)
		if err != nil || brcpt.Status != 1 {
			return fmt.Errorf("placeOrdersBatch tx failed: %v", err)
		}
		_, bplaced, bmatched, bMarketMatched, brej, bevents := d.parseReceipt(brcpt)
		allPlaced = append(allPlaced, bplaced...)
		allMatched = append(allMatched, bmatched...)
		allEvents = append(allEvents, bevents...)
		marketMatched = marketMatched || bMarketMatched
		for _, r := range brej {
			log.Printf("seed: %q batch order rejected on-chain: %s", p.question, r)
		}
	}

	status := "OPEN"
	if marketMatched {
		status = "MATCHED"
	}
	bestYes, bestNo, _ := d.client.BestPrices(d.ctx, chainMarketID)

	return d.mirror(p, chainMarketID, status, allPlaced, allMatched, allEvents, int(bestYes), int(bestNo))
}

// mirror writes the real chain state into the DB in one transaction, replacing
// the market's placeholder fake-chain book. Every mirrored log is claimed in
// chain_events so the running indexer treats it as already-processed.
func (d *liveDeployer) mirror(p liveMarketPlan, chainMarketID int64, status string, placed []placedLog, matched []matchedLog, events []claimRef, bestYes, bestNo int) error {
	tx, err := d.pool.Begin(d.ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(d.ctx)

	// Fence every markets-contract log this deployment emitted so the indexer's
	// exactly-once gate treats them as processed and never re-applies them
	// (mirroring is done here). Token Transfer events are intentionally left for
	// the indexer to record as normal wallet activity (idempotent).
	for _, e := range events {
		d.claimEvent(tx, e.txHash, e.logIndex, e.name, e.block)
	}

	// Replace the placeholder fake-chain book for this market.
	for _, t := range []string{"fills", "positions", "orders"} {
		if _, err := tx.Exec(d.ctx, "DELETE FROM "+t+" WHERE market_id=$1", p.marketID); err != nil {
			return fmt.Errorf("clear %s: %w", t, err)
		}
	}

	// Insert the real orders; remember chain_order_id → (uuid, side).
	orderUUID := map[int64]uuid.UUID{}
	orderSide := map[int64]string{}
	for i, pl := range placed {
		userID, ok := d.userIDByAddr(pl.maker)
		if !ok {
			// Unknown maker: attribute to the creator so the row is valid.
			userID = p.creatorID
		}
		isCreate := i == 0 // opening order is the first OrderPlaced (createMarket)
		digest := fmt.Sprintf("0x%s-%d-%d", strings.TrimPrefix(pl.txHash, "0x"), pl.logIndex, pl.chainOrderID)
		maxCost := int64(pl.price)*pl.shares*d.cent + pl.shares + d.client.Unit
		var oid uuid.UUID
		err := tx.QueryRow(d.ctx, `
			INSERT INTO orders (market_id, user_id, side, price_cents, shares, filled_shares,
				status, chain_order_id, maker_address, max_cost, nonce, order_digest, is_market_create)
			VALUES ($1,$2,$3,$4,$5,0,'RESTING',$6,$7,$8,0,$9,$10)
			RETURNING id`,
			p.marketID, userID, pl.side, pl.price, pl.shares, pl.chainOrderID,
			strings.ToLower(pl.maker.Hex()), maxCost, digest, isCreate).Scan(&oid)
		if err != nil {
			return fmt.Errorf("insert order: %w", err)
		}
		orderUUID[pl.chainOrderID] = oid
		orderSide[pl.chainOrderID] = pl.side
	}

	// Apply matches: fills + positions, mirroring the indexer exactly.
	volumeDelta := int64(0)
	for _, m := range matched {
		takerID := orderUUID[m.takerChain]
		makerID := orderUUID[m.makerChain]
		var takerPtr, makerPtr *uuid.UUID
		if takerID != uuid.Nil {
			takerPtr = &takerID
		}
		if makerID != uuid.Nil {
			makerPtr = &makerID
		}
		if _, err := tx.Exec(d.ctx, `
			INSERT INTO fills (market_id, taker_order_id, maker_order_id, taker_chain_order_id,
				maker_chain_order_id, price_cents, shares, fee, tx_hash, log_index)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (tx_hash, log_index) DO NOTHING`,
			p.marketID, takerPtr, makerPtr, m.takerChain, m.makerChain,
			m.price, m.shares, m.fee, m.txHash, m.logIndex); err != nil {
			return fmt.Errorf("insert fill: %w", err)
		}
		for _, oid := range []*uuid.UUID{takerPtr, makerPtr} {
			if oid == nil {
				continue
			}
			if _, err := tx.Exec(d.ctx, `
				UPDATE orders SET filled_shares = LEAST(filled_shares+$2, shares),
					status = CASE WHEN filled_shares+$2 >= shares THEN 'FILLED' ELSE 'PARTIAL' END,
					updated_at=now()
				WHERE id=$1`, *oid, m.shares); err != nil {
				return fmt.Errorf("advance order: %w", err)
			}
		}
		takerSide := orderSide[m.takerChain]
		makerSide := orderSide[m.makerChain]
		takerPrice := m.price
		if takerSide != "" && makerSide != "" && takerSide != makerSide {
			takerPrice = 100 - m.price
		}
		if takerID != uuid.Nil {
			if err := d.applyPosition(tx, p.marketID, m.takerChain, orSideDef(takerSide, "yes"), takerPrice, m.shares); err != nil {
				return err
			}
		}
		if makerID != uuid.Nil {
			if err := d.applyPosition(tx, p.marketID, m.makerChain, orSideDef(makerSide, "no"), m.price, m.shares); err != nil {
				return err
			}
		}
		volumeDelta += m.shares * d.client.Unit
	}

	// Bind the market to its real chain id + status + best prices.
	var yesPtr, noPtr *int
	if bestYes > 0 {
		yesPtr = &bestYes
	}
	if bestNo > 0 {
		noPtr = &bestNo
	}
	if _, err := tx.Exec(d.ctx, `
		UPDATE markets SET chain_market_id=$2, status=$3,
			yes_price_cents=COALESCE($4, yes_price_cents),
			no_price_cents=COALESCE($5, no_price_cents),
			volume=volume+$6, updated_at=now()
		WHERE id=$1`, p.marketID, chainMarketID, status, yesPtr, noPtr, volumeDelta); err != nil {
		return fmt.Errorf("bind market: %w", err)
	}

	return tx.Commit(d.ctx)
}

// applyPosition upserts a (market,user,side) position for a matched order, using
// the same volume-weighted average as the indexer.
func (d *liveDeployer) applyPosition(tx pgx.Tx, marketID uuid.UUID, chainOrderID int64, side string, priceCents int, shares int64) error {
	userID, err := d.userIDByChainOrder(tx, marketID, chainOrderID)
	if err != nil || userID == uuid.Nil {
		return err
	}
	_, err = tx.Exec(d.ctx, `
		INSERT INTO positions (market_id, user_id, side, shares, avg_price_cents)
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (market_id, user_id, side) DO UPDATE SET
			avg_price_cents = CASE WHEN positions.shares + EXCLUDED.shares > 0
				THEN (positions.avg_price_cents*positions.shares + EXCLUDED.avg_price_cents*EXCLUDED.shares)
				     / (positions.shares + EXCLUDED.shares)
				ELSE 0 END,
			shares = positions.shares + EXCLUDED.shares,
			updated_at = now()`, marketID, userID, side, shares, priceCents)
	return err
}

func (d *liveDeployer) userIDByChainOrder(tx pgx.Tx, marketID uuid.UUID, chainOrderID int64) (uuid.UUID, error) {
	var id uuid.UUID
	err := tx.QueryRow(d.ctx, `SELECT user_id FROM orders WHERE market_id=$1 AND chain_order_id=$2`,
		marketID, chainOrderID).Scan(&id)
	if err == pgx.ErrNoRows {
		return uuid.Nil, nil
	}
	return id, err
}

// claimEvent records a chain event so the indexer's exactly-once gate skips it.
func (d *liveDeployer) claimEvent(tx pgx.Tx, txHash string, logIndex int, name string, block int64) {
	_, _ = tx.Exec(d.ctx, `
		INSERT INTO chain_events (tx_hash, log_index, name, block_number)
		VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, txHash, logIndex, name, block)
}

// userIDByAddr resolves a funded maker address to its seed user id via the DB.
func (d *liveDeployer) userIDByAddr(addr common.Address) (uuid.UUID, bool) {
	var id uuid.UUID
	err := d.pool.QueryRow(d.ctx,
		`SELECT id FROM users WHERE lower(wallet_address)=lower($1)`, addr.Hex()).Scan(&id)
	if err != nil {
		return uuid.Nil, false
	}
	return id, true
}

// recomputeEntryStats rebuilds the seed entry-stat aggregates from the orders
// table (now including the real on-chain orders) — once, authoritatively. The
// indexer is fenced off from these orders' events, so this is the only writer.
func (d *liveDeployer) recomputeEntryStats() {
	const seedUsers = `(SELECT id FROM users WHERE privy_did LIKE 'seed:%')`
	if _, err := d.pool.Exec(d.ctx, `INSERT INTO user_entry_stats (user_id, entry_count, notional_sum)
		SELECT o.user_id, count(*),
		       COALESCE(SUM(o.shares * (CASE WHEN o.side='yes' THEN o.price_cents ELSE 100 - o.price_cents END)),0)
		FROM orders o WHERE o.user_id IN `+seedUsers+`
		GROUP BY o.user_id
		ON CONFLICT (user_id) DO UPDATE SET entry_count=EXCLUDED.entry_count, notional_sum=EXCLUDED.notional_sum`); err != nil {
		log.Printf("seed: recompute user_entry_stats: %v", err)
	}
	if _, err := d.pool.Exec(d.ctx, `INSERT INTO follow_entry_agg (follower_id, following_notional_sum, following_entry_count)
		SELECT f.follower_id, COALESCE(SUM(ues.notional_sum),0), COALESCE(SUM(ues.entry_count),0)
		FROM follows f
		LEFT JOIN user_entry_stats ues ON ues.user_id=f.followee_id
		WHERE f.status='accepted' AND f.follower_id IN `+seedUsers+`
		GROUP BY f.follower_id
		ON CONFLICT (follower_id) DO UPDATE SET
			following_notional_sum=EXCLUDED.following_notional_sum,
			following_entry_count=EXCLUDED.following_entry_count`); err != nil {
		log.Printf("seed: recompute follow_entry_agg: %v", err)
	}
}

// ---- small helpers ---------------------------------------------------------

func orSideDef(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func toInt64(v any) int64 {
	switch t := v.(type) {
	case *big.Int:
		return t.Int64()
	case uint8:
		return int64(t)
	case uint64:
		return int64(t)
	case int64:
		return t
	}
	return 0
}

func toUint8(v any) uint8 {
	switch t := v.(type) {
	case uint8:
		return t
	case *big.Int:
		return uint8(t.Int64())
	case uint64:
		return uint8(t)
	}
	return 0
}

func uint256Word(n *big.Int) []byte {
	if n == nil {
		n = big.NewInt(0)
	}
	b := make([]byte, 32)
	n.FillBytes(b)
	return b
}

func addressWord(a common.Address) []byte {
	b := make([]byte, 32)
	copy(b[12:], a.Bytes())
	return b
}
