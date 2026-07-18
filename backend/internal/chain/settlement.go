package chain

import (
	"context"
	"log"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"github.com/pjol/THASSA/backend/internal/bus"
	"github.com/pjol/THASSA/backend/internal/leader"
	"github.com/pjol/THASSA/backend/internal/store"
)

// SettlementRunner executes settle requests: it collects the 5-cent fee via
// the requesting user's relayed EIP-3009 auth (paying the relayer, which
// fronts the contract's transferFrom pull), then calls settleMarket. The
// indexer flips the market SETTLING on SettlementRequested and SETTLED (+
// notifications) on MarketSettled. Fleet-singleton via advisory lock.
type SettlementRunner struct {
	db      *store.Store
	client  *Client
	gate    *Gate
	nonces  *NonceManager
	elector *leader.Elector
	fanout  *bus.Fanout
}

func NewSettlementRunner(db *store.Store, client *Client, gate *Gate, fanout *bus.Fanout) *SettlementRunner {
	return &SettlementRunner{
		db:      db,
		client:  client,
		gate:    gate,
		nonces:  NewNonceManager(db, client),
		elector: leader.New(db.Pool(), "settlement"),
		fanout:  fanout,
	}
}

// Run polls for claimed settle requests every 3s while leader.
func (s *SettlementRunner) Run(ctx context.Context) {
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	defer s.elector.Release()
	wasLeader := false
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		isLeader, err := s.elector.TryAcquire(ctx)
		if err != nil || !isLeader {
			wasLeader = false
			continue
		}
		if !wasLeader {
			s.nonces.Reset()
			wasLeader = true
		}
		s.tick(ctx)
	}
}

func (s *SettlementRunner) tick(ctx context.Context) {
	pending, err := s.db.PendingSettlements(ctx, 5)
	if err != nil {
		log.Printf("settlement: claim: %v", err)
		return
	}
	for _, p := range pending {
		if err := s.settle(ctx, p); err != nil {
			log.Printf("settlement: market %s: %v", p.MarketID, err)
			_ = s.db.ReleaseSettlementClaim(ctx, p.MarketID)
		}
	}
	s.expireDue(ctx)
}

// expireDue auto-resolves past-due, unsettled markets 50/50 (spec: markets
// carry an expiration date; reaching it before settlement splits every
// matched share 50¢/50¢). The DB is the read-model source of truth; the
// on-chain expireMarket path mirrors it for live markets via the contract's
// expiry mappings.
func (s *SettlementRunner) expireDue(ctx context.Context) {
	expired, err := s.db.ExpireDueMarkets(ctx)
	if err != nil {
		log.Printf("settlement: expire sweep: %v", err)
		return
	}
	for _, m := range expired {
		log.Printf("settlement: market %s (%q) expired — resolved 50/50", m.ID, m.Title)
		// Realtime: flip open cards to SETTLED 50/50.
		s.fanout.Publish("book:"+m.ID.String(), "market.update", map[string]any{
			"status": "SETTLED", "direction": nil, "resolved_fifty": true,
		})
		// Creator notification (in-app; same kind the settle path uses).
		if n, err := s.db.InsertNotification(ctx, m.CreatorID, "market.settled", map[string]any{
			"market_id": m.ID.String(), "title": m.Title, "fifty_fifty": true,
		}); err == nil {
			s.fanout.SendToUser(m.CreatorID, "market.settled", n)
		}
	}
}

func (s *SettlementRunner) settle(ctx context.Context, p store.PendingSettlement) error {
	auth, err := UnmarshalAuth(p.Auth)
	if err != nil {
		// Unfundable request: drop it so it doesn't loop forever.
		_ = s.db.ClearSettlementRequest(ctx, p.MarketID)
		return err
	}
	// §8.1: the fee must come from the wallet of the authenticated user who
	// requested settlement, and pay the relayer.
	requesterWallet, err := s.db.UserWallet(ctx, p.RequestedBy)
	if err != nil || requesterWallet == "" {
		_ = s.db.ClearSettlementRequest(ctx, p.MarketID)
		return ErrBadAuthSender
	}
	if err := s.gate.CheckAuth(auth, PurposeSettlement, common.HexToAddress(requesterWallet), s.gate.Relayer, time.Now()); err != nil {
		_ = s.db.ClearSettlementRequest(ctx, p.MarketID)
		return err
	}
	if auth.Value < SettlementFee(s.client.Unit) {
		_ = s.db.ClearSettlementRequest(ctx, p.MarketID)
		return ErrAuthValue
	}

	// Single call: settleMarketWithAuth pulls the 5¢ fee from the payer via
	// the attached receiveWithAuthorization (random nonce, recipient = the
	// markets contract) and places the hub bid with inputData =
	// (marketId, settlementQuery).
	if !s.gate.AllowCall(s.gate.Markets, "settleMarketWithAuth") {
		return ErrMethodNotAllowed
	}
	callData, err := s.client.MarketsABI.Pack("settleMarketWithAuth",
		big.NewInt(p.ChainMarketID), common.HexToAddress(requesterWallet), auth.ABI())
	if err != nil {
		return err
	}
	if err := s.submitAndWait(ctx, "settle", s.gate.Markets, callData); err != nil {
		return err
	}
	// Leave the request row; the indexer clears it + flips SETTLING when the
	// SettlementRequested event lands (re-triggerable if the bid expires).
	s.fanout.SendToUser(p.RequestedBy, "market.settling", map[string]any{
		"market_id": p.MarketID, "status": "SETTLING",
	})
	return nil
}

func (s *SettlementRunner) submitAndWait(ctx context.Context, kind string, addr common.Address, data []byte) error {
	nonce, err := s.nonces.Next(ctx, kind)
	if err != nil {
		return err
	}
	txHash, err := s.client.SubmitTx(ctx, nonce, addr, data)
	if err != nil {
		s.nonces.Record(ctx, nonce, "", "failed")
		s.nonces.Reset()
		return err
	}
	s.nonces.Record(ctx, nonce, txHash.Hex(), "pending")
	rcpt, err := s.client.WaitReceipt(ctx, txHash, 60*time.Second)
	if err != nil {
		return err
	}
	status := "confirmed"
	if rcpt.Status != 1 {
		status = "failed"
	}
	s.nonces.Record(ctx, nonce, txHash.Hex(), status)
	if rcpt.Status != 1 {
		return ErrMethodNotAllowed
	}
	return nil
}
