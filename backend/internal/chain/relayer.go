package chain

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/google/uuid"

	"github.com/pjol/THASSA/backend/internal/bus"
	"github.com/pjol/THASSA/backend/internal/leader"
	"github.com/pjol/THASSA/backend/internal/store"
)

// Relayer batches signed orders into placeOrdersBatch, submits createMarket
// for new markets, executes cancels and generic relayed jobs (wallet sends,
// redeems). Exactly one batcher runs fleet-wide (Postgres advisory-lock
// leader election, spec §6.7); the rest are hot standbys.
type Relayer struct {
	db      *store.Store
	client  *Client
	gate    *Gate
	nonces  *NonceManager
	elector *leader.Elector
	fanout  *bus.Fanout

	batchMS  int
	batchMax int
}

func NewRelayer(db *store.Store, client *Client, gate *Gate, fanout *bus.Fanout, batchMS, batchMax int) *Relayer {
	return &Relayer{
		db:       db,
		client:   client,
		gate:     gate,
		nonces:   NewNonceManager(db, client),
		elector:  leader.New(db.Pool(), "relayer"),
		fanout:   fanout,
		batchMS:  batchMS,
		batchMax: batchMax,
	}
}

// Run ticks every RELAYER_BATCH_MS until ctx ends.
func (r *Relayer) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Duration(r.batchMS) * time.Millisecond)
	defer ticker.Stop()
	defer r.elector.Release()
	wasLeader := false
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		isLeader, err := r.elector.TryAcquire(ctx)
		if err != nil || !isLeader {
			wasLeader = false
			continue
		}
		if !wasLeader {
			// Fresh leadership: rebuild the nonce position from chain + the
			// durable ledger, never from memory.
			r.nonces.Reset()
			wasLeader = true
		}
		r.tick(ctx)
	}
}

func (r *Relayer) tick(ctx context.Context) {
	r.processQueuedOrders(ctx)
	r.processCancels(ctx)
	r.processJobs(ctx)
}

// processQueuedOrders claims the next batch and submits createMarket calls
// (market-create orders) plus one placeOrdersBatch for the rest.
func (r *Relayer) processQueuedOrders(ctx context.Context) {
	batchID, orders, err := r.db.ClaimQueuedOrders(ctx, r.batchMax)
	if err != nil {
		log.Printf("relayer: claim: %v", err)
		return
	}
	if len(orders) == 0 {
		return
	}

	var batchOrders []ABIOrder
	var batchAuths []ABIAuth

	for _, q := range orders {
		order, auth, err := r.buildOrder(q)
		if err != nil {
			log.Printf("relayer: order %s invalid, cancelling: %v", q.ID, err)
			_ = r.failOrder(ctx, q)
			continue
		}
		// Re-check the gate at submission time (defense in depth).
		if err := r.gate.CheckOrder(order, auth, r.client.Unit, time.Now()); err != nil {
			log.Printf("relayer: gate rejected order %s: %v", q.ID, err)
			_ = r.failOrder(ctx, q)
			continue
		}
		// Affiliate routing: register the post payee before relaying orders
		// that carry an affiliatePostId (idempotent; contract overwrites).
		if q.AffiliatePostID != nil {
			r.ensureAffiliateRegistered(ctx, *q.AffiliatePostID)
		}

		switch {
		case q.IsMarketCreate:
			r.submitCreateMarket(ctx, q, order, auth)
		case q.ChainMarketID == nil:
			// Market not yet onchain — release just this order for a later
			// tick (never the whole batch: those rows are being submitted).
			r.requeueOrder(ctx, q.ID)
		default:
			order.MarketID = big.NewInt(*q.ChainMarketID)
			batchOrders = append(batchOrders, order.ABI())
			batchAuths = append(batchAuths, auth.ABI())
		}
	}

	if len(batchOrders) == 0 {
		_ = r.db.MarkBatch(ctx, batchID, "confirmed", "", "")
		return
	}
	if !r.gate.AllowCall(r.gate.Markets, "placeOrdersBatch") {
		_ = r.db.MarkBatch(ctx, batchID, "failed", "", "gate: method not allowed")
		return
	}
	data, err := r.client.MarketsABI.Pack("placeOrdersBatch", batchOrders, batchAuths)
	if err != nil {
		_ = r.db.MarkBatch(ctx, batchID, "failed", "", "pack: "+err.Error())
		return
	}
	txHash, err := r.submit(ctx, "batch", r.gate.Markets, data)
	if err != nil {
		log.Printf("relayer: batch submit: %v", err)
		_ = r.db.MarkBatch(ctx, batchID, "failed", "", err.Error())
		return
	}
	_ = r.db.MarkBatch(ctx, batchID, "submitting", txHash.Hex(), "")
	if rcpt, err := r.client.WaitReceipt(ctx, txHash, 60*time.Second); err != nil || rcpt.Status != 1 {
		_ = r.db.MarkBatch(ctx, batchID, "failed", txHash.Hex(), "tx reverted or timed out")
		return
	}
	_ = r.db.MarkBatch(ctx, batchID, "confirmed", txHash.Hex(), "")
}

// buildOrder converts a queued row into the typed order + auth. Signature
// carriage (spec §9): the order itself is unsigned; the gate verifies that
// the EIP-3009 auth nonce equals the order's EIP-712 digest, binding the
// maker's funding signature to exactly this order.
func (r *Relayer) buildOrder(q store.QueuedOrder) (Order, *Auth3009, error) {
	side := uint8(0)
	if q.Side == "no" {
		side = 1
	}
	marketID := big.NewInt(0) // market-create orders sign marketId = 0
	if !q.IsMarketCreate && q.ChainMarketID != nil {
		marketID = big.NewInt(*q.ChainMarketID)
	}
	var affiliate = big.NewInt(0)
	if q.AffiliatePostID != nil {
		affiliate = new(big.Int).SetBytes(q.AffiliatePostID[:])
	}
	order := Order{
		MarketID:        marketID,
		Side:            side,
		Price:           uint8(q.PriceCents),
		Shares:          q.Shares,
		MaxCost:         q.MaxCost,
		AffiliatePostID: affiliate,
		Expiry:          q.Expiry,
		Nonce:           q.Nonce,
		Maker:           common.HexToAddress(q.MakerAddress),
	}
	auth, err := UnmarshalAuth(q.Auth3009)
	if err != nil {
		return order, nil, err
	}
	// Consistency: the stored digest must match a recomputation (defense
	// against row tampering between API validation and relay).
	if q.OrderDigest != "" && !strings.EqualFold(q.OrderDigest, OrderDigest(order, r.client.ChainID, r.gate.Markets).Hex()) {
		return order, nil, fmt.Errorf("stored order digest mismatch")
	}
	return order, auth, nil
}

func (r *Relayer) submitCreateMarket(ctx context.Context, q store.QueuedOrder, order Order, auth *Auth3009) {
	if !r.gate.AllowCall(r.gate.Markets, "createMarket") {
		_ = r.failOrder(ctx, q)
		return
	}
	data, err := r.client.MarketsABI.Pack("createMarket", q.Question, q.SettlementQuery, order.ABI(), auth.ABI())
	if err != nil {
		log.Printf("relayer: createMarket pack: %v", err)
		_ = r.failOrder(ctx, q)
		return
	}
	txHash, err := r.submit(ctx, "create_market", r.gate.Markets, data)
	if err != nil {
		log.Printf("relayer: createMarket submit: %v", err)
		r.requeueOrder(ctx, q.ID)
		return
	}
	if rcpt, err := r.client.WaitReceipt(ctx, txHash, 60*time.Second); err != nil || rcpt.Status != 1 {
		log.Printf("relayer: createMarket tx failed for order %s", q.ID)
		r.requeueOrder(ctx, q.ID)
		return
	}
	// The indexer binds chain_market_id + flips the market OPEN on
	// MarketCreated and the order RESTING on OrderPlaced.
}

func (r *Relayer) processCancels(ctx context.Context) {
	cancels, err := r.db.CancelRequests(ctx, 10)
	if err != nil {
		return
	}
	for _, cq := range cancels {
		if !r.gate.AllowCall(r.gate.Markets, "cancelOrder") || cq.ChainMarketID == nil {
			continue
		}
		data, err := r.client.MarketsABI.Pack("cancelOrder", big.NewInt(*cq.ChainMarketID), big.NewInt(cq.Nonce))
		if err != nil {
			continue
		}
		if _, err := r.submit(ctx, "cancel", r.gate.Markets, data); err != nil {
			log.Printf("relayer: cancel submit: %v", err)
			continue
		}
		_ = r.db.ClearCancelRequest(ctx, cq.ID)
	}
}

// processJobs executes generic relayed calls: wallet sends (EIP-3009
// transferWithAuthorization on the payment token, recipient re-verified by
// the gate) and redeems (markets.redeem for a settled market).
func (r *Relayer) processJobs(ctx context.Context) {
	jobs, err := r.db.ClaimRelayerJobs(ctx, 10)
	if err != nil {
		return
	}
	for _, j := range jobs {
		switch j.Kind {
		case "send":
			r.processSend(ctx, j)
		case "redeem":
			r.processRedeem(ctx, j)
		default:
			_ = r.db.FinishRelayerJob(ctx, j.ID, "failed", "", "unknown job kind")
		}
	}
}

type sendJobPayload struct {
	Recipient string   `json:"recipient"`
	Amount    int64    `json:"amount"`
	Auth      Auth3009 `json:"auth"`
}

func (r *Relayer) processSend(ctx context.Context, j store.RelayerJob) {
	var p sendJobPayload
	if err := json.Unmarshal(j.Payload, &p); err != nil {
		_ = r.db.FinishRelayerJob(ctx, j.ID, "failed", "", "bad payload")
		return
	}
	recipient := common.HexToAddress(p.Recipient)
	if err := r.gate.CheckAuth(&p.Auth, PurposeWalletSend, p.Auth.From, recipient, time.Now()); err != nil {
		_ = r.db.FinishRelayerJob(ctx, j.ID, "failed", "", err.Error())
		return
	}
	if !r.gate.AllowCall(r.gate.Token, "transferWithAuthorization") {
		_ = r.db.FinishRelayerJob(ctx, j.ID, "failed", "", "gate: method not allowed")
		return
	}
	data, err := r.client.TokenABI.Pack("transferWithAuthorization",
		p.Auth.From, p.Auth.To, big.NewInt(p.Auth.Value),
		big.NewInt(p.Auth.ValidAfter), big.NewInt(p.Auth.ValidBefore),
		[32]byte(p.Auth.Nonce), p.Auth.V, [32]byte(p.Auth.R), [32]byte(p.Auth.S))
	if err != nil {
		_ = r.db.FinishRelayerJob(ctx, j.ID, "failed", "", "pack: "+err.Error())
		return
	}
	txHash, err := r.submit(ctx, "send", r.gate.Token, data)
	if err != nil {
		_ = r.db.FinishRelayerJob(ctx, j.ID, "failed", "", err.Error())
		return
	}
	status := "confirmed"
	if rcpt, err := r.client.WaitReceipt(ctx, txHash, 60*time.Second); err != nil || rcpt.Status != 1 {
		status = "failed"
	}
	_ = r.db.FinishRelayerJob(ctx, j.ID, status, txHash.Hex(), "")
	r.fanout.SendToUser(j.UserID, "wallet.send."+status, map[string]any{
		"job_id": j.ID, "tx_hash": txHash.Hex(), "amount": p.Amount, "recipient": p.Recipient,
	})
}

type redeemJobPayload struct {
	MarketID      uuid.UUID `json:"market_id"`
	ChainMarketID int64     `json:"chain_market_id"`
}

func (r *Relayer) processRedeem(ctx context.Context, j store.RelayerJob) {
	var p redeemJobPayload
	if err := json.Unmarshal(j.Payload, &p); err != nil {
		_ = r.db.FinishRelayerJob(ctx, j.ID, "failed", "", "bad payload")
		return
	}
	if !r.gate.AllowCall(r.gate.Markets, "redeem") {
		_ = r.db.FinishRelayerJob(ctx, j.ID, "failed", "", "gate: method not allowed")
		return
	}
	data, err := r.client.MarketsABI.Pack("redeem", big.NewInt(p.ChainMarketID))
	if err != nil {
		_ = r.db.FinishRelayerJob(ctx, j.ID, "failed", "", "pack: "+err.Error())
		return
	}
	txHash, err := r.submit(ctx, "redeem", r.gate.Markets, data)
	if err != nil {
		_ = r.db.FinishRelayerJob(ctx, j.ID, "failed", "", err.Error())
		return
	}
	status := "confirmed"
	if rcpt, err := r.client.WaitReceipt(ctx, txHash, 60*time.Second); err != nil || rcpt.Status != 1 {
		status = "failed"
	}
	_ = r.db.FinishRelayerJob(ctx, j.ID, status, txHash.Hex(), "")
	r.fanout.SendToUser(j.UserID, "market.redeem."+status, map[string]any{
		"job_id": j.ID, "market_id": p.MarketID, "tx_hash": txHash.Hex(),
	})
}

// ensureAffiliateRegistered registers postId → author wallet once.
func (r *Relayer) ensureAffiliateRegistered(ctx context.Context, postID uuid.UUID) {
	_, wallet, registered, err := r.db.PostAffiliateInfo(ctx, postID)
	if err != nil || registered || wallet == "" {
		return
	}
	if !r.gate.AllowCall(r.gate.Markets, "registerAffiliatePost") {
		return
	}
	data, err := r.client.MarketsABI.Pack("registerAffiliatePost",
		new(big.Int).SetBytes(postID[:]), common.HexToAddress(wallet))
	if err != nil {
		return
	}
	if _, err := r.submit(ctx, "register_affiliate", r.gate.Markets, data); err != nil {
		log.Printf("relayer: registerAffiliatePost: %v", err)
		return
	}
	_ = r.db.MarkAffiliateRegistered(ctx, postID)
}

// submit reserves a durable nonce, enforces the gate allowlist one final
// time, and broadcasts.
func (r *Relayer) submit(ctx context.Context, kind string, to common.Address, data []byte) (common.Hash, error) {
	if _, ok := map[common.Address]bool{r.gate.Markets: true, r.gate.Token: true, r.gate.Hub: true}[to]; !ok {
		return common.Hash{}, ErrMethodNotAllowed
	}
	nonce, err := r.nonces.Next(ctx, kind)
	if err != nil {
		return common.Hash{}, err
	}
	txHash, err := r.client.SubmitTx(ctx, nonce, to, data)
	if err != nil {
		r.nonces.Record(ctx, nonce, "", "failed")
		// A send failure leaves a gap; re-prime from chain next time.
		r.nonces.Reset()
		return common.Hash{}, err
	}
	r.nonces.Record(ctx, nonce, txHash.Hex(), "pending")
	return txHash, nil
}

// failOrder cancels an invalid queued order locally and tells the user.
func (r *Relayer) failOrder(ctx context.Context, q store.QueuedOrder) error {
	_, err := r.db.Pool().Exec(ctx,
		`UPDATE orders SET status='CANCELED', updated_at=now() WHERE id=$1 AND status='QUEUED'`, q.ID)
	r.fanout.SendToUser(q.UserID, "order.rejected", map[string]any{"order_id": q.ID})
	return err
}

func (r *Relayer) requeueOrder(ctx context.Context, orderID uuid.UUID) {
	_, _ = r.db.Pool().Exec(ctx,
		`UPDATE orders SET batch_id=NULL, updated_at=now() WHERE id=$1 AND status='QUEUED'`, orderID)
}
