package signing

import (
	"crypto/ecdsa"
	"encoding/hex"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

var updateTypeHash = crypto.Keccak256Hash(
	[]byte("ProofUpdate(address hub,uint256 chainId,bytes32 payloadHash,uint256 bidId,bool autoFlow)"),
)

type UpdatePayload struct {
	Client           common.Address
	CallbackData     []byte
	QueryHash        common.Hash
	ShapeHash        common.Hash
	ModelHash        common.Hash
	ClientVersion    uint64
	RequestTimestamp uint64
	Expiry           uint64
	Nonce            *big.Int
	Fulfiller        common.Address
}

type SignRequest struct {
	HubAddress common.Address
	ChainID    *big.Int
	BidID      *big.Int
	AutoFlow   bool
	Payload    UpdatePayload
}

type SignResult struct {
	Digest    common.Hash
	Signature []byte
}

type Signer struct {
	privateKey *ecdsa.PrivateKey
	address    common.Address
}

func NewSigner(privateKeyHex string) (*Signer, error) {
	privateKeyHex = strings.TrimSpace(privateKeyHex)
	privateKeyHex = strings.TrimPrefix(privateKeyHex, "0x")
	privateKeyHex = strings.TrimPrefix(privateKeyHex, "0X")
	if privateKeyHex == "" {
		return nil, fmt.Errorf("private key is empty")
	}

	_, err := hex.DecodeString(privateKeyHex)
	if err != nil {
		return nil, fmt.Errorf("private key must be hex: %w", err)
	}

	privateKey, err := crypto.HexToECDSA(privateKeyHex)
	if err != nil {
		return nil, fmt.Errorf("parse private key: %w", err)
	}

	address := crypto.PubkeyToAddress(privateKey.PublicKey)
	return &Signer{privateKey: privateKey, address: address}, nil
}

func (s *Signer) Address() common.Address {
	return s.address
}

func (s *Signer) PrivateKey() *ecdsa.PrivateKey {
	return s.privateKey
}

func (s *Signer) SignUpdate(request SignRequest) (SignResult, error) {
	digest, err := ComputeDigest(request)
	if err != nil {
		return SignResult{}, err
	}

	sig, err := crypto.Sign(accounts.TextHash(digest.Bytes()), s.privateKey)
	if err != nil {
		return SignResult{}, fmt.Errorf("sign digest: %w", err)
	}

	// OpenZeppelin ECDSA expects v in {27, 28}.
	sig[64] += 27

	return SignResult{
		Digest:    digest,
		Signature: sig,
	}, nil
}

func ComputeDigest(request SignRequest) (common.Hash, error) {
	if request.ChainID == nil {
		return common.Hash{}, fmt.Errorf("chainID is required")
	}
	if request.BidID == nil {
		return common.Hash{}, fmt.Errorf("bidID is required")
	}
	if request.Payload.Nonce == nil {
		return common.Hash{}, fmt.Errorf("payload nonce is required")
	}

	payloadArgs, err := newArguments(
		"address",
		"bytes32",
		"bytes32",
		"bytes32",
		"bytes32",
		"uint64",
		"uint64",
		"uint64",
		"uint256",
		"address",
	)
	if err != nil {
		return common.Hash{}, err
	}

	callbackHash := crypto.Keccak256Hash(request.Payload.CallbackData)
	packedPayload, err := payloadArgs.Pack(
		request.Payload.Client,
		callbackHash,
		request.Payload.QueryHash,
		request.Payload.ShapeHash,
		request.Payload.ModelHash,
		request.Payload.ClientVersion,
		request.Payload.RequestTimestamp,
		request.Payload.Expiry,
		request.Payload.Nonce,
		request.Payload.Fulfiller,
	)
	if err != nil {
		return common.Hash{}, fmt.Errorf("pack payload: %w", err)
	}
	payloadHash := crypto.Keccak256Hash(packedPayload)

	digestArgs, err := newArguments("bytes32", "address", "uint256", "bytes32", "uint256", "bool")
	if err != nil {
		return common.Hash{}, err
	}

	packedDigest, err := digestArgs.Pack(
		updateTypeHash,
		request.HubAddress,
		request.ChainID,
		payloadHash,
		request.BidID,
		request.AutoFlow,
	)
	if err != nil {
		return common.Hash{}, fmt.Errorf("pack digest: %w", err)
	}

	return crypto.Keccak256Hash(packedDigest), nil
}

func newArguments(typeNames ...string) (abi.Arguments, error) {
	args := make(abi.Arguments, 0, len(typeNames))
	for _, typeName := range typeNames {
		argType, err := abi.NewType(typeName, "", nil)
		if err != nil {
			return nil, fmt.Errorf("create ABI type %q: %w", typeName, err)
		}
		args = append(args, abi.Argument{Type: argType})
	}
	return args, nil
}
