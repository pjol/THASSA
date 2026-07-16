package chain

import (
	"context"
	"fmt"
	"sync"

	"github.com/pjol/THASSA/backend/internal/store"
)

// RecoverNonce computes the next usable relayer nonce after (re)gaining
// leadership: the max of the chain's pending account nonce and the highest
// nonce ever recorded in the durable relayer_txs ledger + 1. This survives
// failover: a new leader on another instance never reuses a nonce the old
// leader may have broadcast but not yet mined (spec §6.7).
func RecoverNonce(chainPending uint64, dbMax int64, dbHasRows bool) uint64 {
	next := chainPending
	if dbHasRows && uint64(dbMax+1) > next {
		next = uint64(dbMax + 1)
	}
	return next
}

// NonceManager hands out sequential relayer nonces, persisting every
// reservation before broadcast. Memory is only a cache; the source of truth
// is chain state + the relayer_txs table.
type NonceManager struct {
	mu     sync.Mutex
	db     *store.Store
	client *Client
	next   uint64
	primed bool
}

func NewNonceManager(db *store.Store, client *Client) *NonceManager {
	return &NonceManager{db: db, client: client}
}

// Reset drops the cached position (called on leadership changes).
func (n *NonceManager) Reset() {
	n.mu.Lock()
	n.primed = false
	n.mu.Unlock()
}

// Next reserves the next nonce durably and returns it.
func (n *NonceManager) Next(ctx context.Context, kind string) (uint64, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if !n.primed {
		pending, err := n.client.Eth.PendingNonceAt(ctx, n.client.Relayer)
		if err != nil {
			return 0, fmt.Errorf("pending nonce: %w", err)
		}
		dbMax, has, err := n.db.MaxRelayerNonce(ctx)
		if err != nil {
			return 0, err
		}
		n.next = RecoverNonce(pending, dbMax, has)
		n.primed = true
	}
	// Reserve; skip forward over any nonce another (former) leader reserved.
	for {
		ok, err := n.db.ReserveRelayerNonce(ctx, int64(n.next), kind)
		if err != nil {
			return 0, err
		}
		nonce := n.next
		n.next++
		if ok {
			return nonce, nil
		}
	}
}

// Record stores the broadcast hash / status for a reserved nonce.
func (n *NonceManager) Record(ctx context.Context, nonce uint64, txHash, status string) {
	_ = n.db.RecordRelayerTx(ctx, int64(nonce), txHash, status)
}
