package chain

import (
	"context"
	"log"
	"math/big"
	"time"

	ethereum "github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/google/uuid"

	"github.com/pjol/THASSA/backend/internal/bus"
	"github.com/pjol/THASSA/backend/internal/notify"
	"github.com/pjol/THASSA/backend/internal/store"
	"github.com/pjol/THASSA/backend/internal/structs"
)

// Indexer polls contract logs (with a DB-stored backfill cursor) and mirrors
// them into orders/fills/positions/markets, pushing WS deltas + notifications.
// It is safe to run on every instance: each log is recorded exactly once in
// chain_events (unique tx_hash+log_index), so re-scans and overlap are
// harmless (spec §6.7).
type Indexer struct {
	db     *store.Store
	client *Client
	fanout *bus.Fanout
	notif  *notify.Service
}

func NewIndexer(db *store.Store, client *Client, fanout *bus.Fanout, notif *notify.Service) *Indexer {
	return &Indexer{db: db, client: client, fanout: fanout, notif: notif}
}

const cursorName = "markets_indexer"
const maxScanChunk = 2000

// Run polls every 2s.
func (ix *Indexer) Run(ctx context.Context) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := ix.scan(ctx); err != nil && ctx.Err() == nil {
				log.Printf("indexer: %v", err)
			}
		}
	}
}

func (ix *Indexer) scan(ctx context.Context) error {
	latest, err := ix.client.Eth.BlockNumber(ctx)
	if err != nil {
		return err
	}
	from, err := ix.db.ChainCursor(ctx, cursorName)
	if err != nil {
		return err
	}
	for int64(latest) > from {
		to := from + maxScanChunk
		if to > int64(latest) {
			to = int64(latest)
		}
		logs, err := ix.client.Eth.FilterLogs(ctx, ethereum.FilterQuery{
			FromBlock: big.NewInt(from + 1),
			ToBlock:   big.NewInt(to),
			Addresses: []common.Address{ix.client.Markets, ix.client.Token},
		})
		if err != nil {
			return err
		}
		for _, lg := range logs {
			ix.handleLog(ctx, lg)
		}
		if err := ix.db.SetChainCursor(ctx, cursorName, to); err != nil {
			return err
		}
		from = to
	}
	return nil
}

func (ix *Indexer) handleLog(ctx context.Context, lg types.Log) {
	if len(lg.Topics) == 0 {
		return
	}
	var name string
	var parsed map[string]any
	var err error
	switch lg.Address {
	case ix.client.Token:
		ev, e := ix.client.TokenABI.EventByID(lg.Topics[0])
		if e != nil {
			return
		}
		name = ev.Name
		parsed, err = unpackLog(ix.client, lg, true)
	case ix.client.Markets:
		ev, e := ix.client.MarketsABI.EventByID(lg.Topics[0])
		if e != nil {
			return
		}
		name = ev.Name
		parsed, err = unpackLog(ix.client, lg, false)
	default:
		return
	}
	if err != nil {
		log.Printf("indexer: unpack %s: %v", name, err)
		return
	}

	// Exactly-once side effects across re-scans / N instances.
	first, err := ix.db.RecordChainEvent(ctx, lg.TxHash.Hex(), int(lg.Index), name, int64(lg.BlockNumber))
	if err != nil || !first {
		return
	}

	switch name {
	case "Transfer":
		ix.onTransfer(ctx, lg, parsed)
	case "MarketCreated":
		ix.onMarketCreated(ctx, parsed)
	case "OrderPlaced":
		ix.onOrderPlaced(ctx, parsed)
	case "OrderMatched":
		ix.onOrderMatched(ctx, lg, parsed)
	case "OrderCancelled":
		ix.onOrderCancelled(ctx, parsed)
	case "OrderRejected":
		ix.onOrderRejected(ctx, parsed)
	case "MarketMatched":
		ix.onMarketMatched(ctx, parsed)
	case "SettlementRequested":
		ix.onSettlementRequested(ctx, parsed)
	case "MarketSettled":
		ix.onMarketSettled(ctx, parsed)
	case "Redeemed", "Withdrawn", "CreatorFeesClaimed", "AffiliateFeesClaimed":
		// Balance-affecting only; covered by Transfer rows for activity.
	}
}

// unpackLog flattens indexed + data fields into a name→value map.
func unpackLog(c *Client, lg types.Log, token bool) (map[string]any, error) {
	a := c.MarketsABI
	if token {
		a = c.TokenABI
	}
	ev, err := a.EventByID(lg.Topics[0])
	if err != nil {
		return nil, err
	}
	out := map[string]any{}
	if len(lg.Data) > 0 {
		if err := a.UnpackIntoMap(out, ev.Name, lg.Data); err != nil {
			return nil, err
		}
	}
	idx := 1
	for _, arg := range ev.Inputs {
		if !arg.Indexed {
			continue
		}
		if idx >= len(lg.Topics) {
			break
		}
		topic := lg.Topics[idx]
		idx++
		switch arg.Type.String() {
		case "address":
			out[arg.Name] = common.BytesToAddress(topic.Bytes())
		case "uint256", "uint80", "uint64", "uint8":
			out[arg.Name] = new(big.Int).SetBytes(topic.Bytes())
		case "bool":
			out[arg.Name] = topic.Big().Sign() > 0
		default:
			out[arg.Name] = topic
		}
	}
	return out, nil
}

func asBig(v any) *big.Int {
	switch t := v.(type) {
	case *big.Int:
		return t
	case uint8:
		return big.NewInt(int64(t))
	case uint64:
		return new(big.Int).SetUint64(t)
	case bool:
		if t {
			return big.NewInt(1)
		}
		return big.NewInt(0)
	}
	return big.NewInt(0)
}

func asAddr(v any) common.Address {
	if a, ok := v.(common.Address); ok {
		return a
	}
	return common.Address{}
}

func (ix *Indexer) onTransfer(ctx context.Context, lg types.Log, p map[string]any) {
	from := asAddr(p["from"])
	to := asAddr(p["to"])
	amount := asBig(p["value"]).Int64()
	_ = ix.db.InsertTransfer(ctx, lg.TxHash.Hex(), int(lg.Index), from.Hex(), to.Hex(), amount, int64(lg.BlockNumber))
	// Credit inbound deposits against pending crypto onramp sessions.
	_ = ix.db.CompleteCryptoDeposit(ctx, to.Hex(), amount, lg.TxHash.Hex())
	// Wallet activity push for both parties, if they are platform users.
	for _, addr := range []common.Address{from, to} {
		if uid, err := ix.db.UserIDByWallet(ctx, addr.Hex()); err == nil && uid != uuid.Nil {
			ix.fanout.SendToUser(uid, "wallet.transfer", map[string]any{
				"tx_hash": lg.TxHash.Hex(), "from": from.Hex(), "to": to.Hex(), "amount": amount,
			})
		}
	}
}

func (ix *Indexer) onMarketCreated(ctx context.Context, p map[string]any) {
	chainID := asBig(p["marketId"]).Int64()
	creator := asAddr(p["creator"])
	question, _ := p["question"].(string)
	marketID, err := ix.db.BindMarketCreated(ctx, chainID, creator.Hex(), question)
	if err != nil || marketID == uuid.Nil {
		return
	}
	if creatorID, err := ix.db.UserIDByWallet(ctx, creator.Hex()); err == nil && creatorID != uuid.Nil {
		ix.notif.Notify(ctx, creatorID, "market.open", map[string]any{
			"market_id": marketID,
			"message":   "You're committed. Waiting for someone to take your bet.",
		})
	}
}

func (ix *Indexer) sideFromCode(v any) string {
	if asBig(v).Int64() == 1 {
		return "no"
	}
	return "yes"
}

func (ix *Indexer) onOrderPlaced(ctx context.Context, p map[string]any) {
	chainMarketID := asBig(p["marketId"]).Int64()
	marketID, err := ix.db.MarketByChainID(ctx, chainMarketID)
	if err != nil || marketID == uuid.Nil {
		return
	}
	side := ix.sideFromCode(p["side"])
	price := int(asBig(p["price"]).Int64())
	shares := asBig(p["shares"]).Int64()
	maker := asAddr(p["maker"])
	orderID, userID, err := ix.db.BindOrderPlaced(ctx, marketID, asBig(p["orderId"]).Int64(), maker.Hex(), side, price, shares)
	if err == nil && userID != uuid.Nil {
		ix.fanout.SendToUser(userID, "order.resting", map[string]any{
			"order_id": orderID, "market_id": marketID, "status": "RESTING",
		})
	}
	ix.refreshBook(ctx, marketID, chainMarketID, 0)
}

func (ix *Indexer) onOrderMatched(ctx context.Context, lg types.Log, p map[string]any) {
	chainMarketID := asBig(p["marketId"]).Int64()
	marketID, err := ix.db.MarketByChainID(ctx, chainMarketID)
	if err != nil || marketID == uuid.Nil {
		return
	}
	takerChain := asBig(p["takerOrderId"]).Int64()
	makerChain := asBig(p["makerOrderId"]).Int64()
	price := int(asBig(p["price"]).Int64())
	shares := asBig(p["shares"]).Int64()
	fee := asBig(p["fee"]).Int64()

	takerID, takerUser, takerSide, _ := ix.db.OrderByChainID(ctx, marketID, takerChain)
	makerID, makerUser, makerSide, _ := ix.db.OrderByChainID(ctx, marketID, makerChain)
	var takerPtr, makerPtr *uuid.UUID
	if takerID != uuid.Nil {
		takerPtr = &takerID
	}
	if makerID != uuid.Nil {
		makerPtr = &makerID
	}
	inserted, err := ix.db.InsertFill(ctx, structs.BookTrade{PriceCents: price, Shares: shares},
		marketID, takerPtr, makerPtr, takerChain, makerChain, fee, lg.TxHash.Hex(), int(lg.Index))
	if err != nil || !inserted {
		return
	}

	// Positions: execution at the maker's price; the taker's effective price
	// on the opposite side is 100 − p for its escrow accounting, but both
	// sides record their own limit-side average using the execution price of
	// their side of the pair.
	if takerUser != uuid.Nil {
		takerPrice := price
		if takerSide != "" && makerSide != "" && takerSide != makerSide {
			takerPrice = 100 - price
		}
		_ = ix.db.ApplyFillToPosition(ctx, marketID, takerUser, orSide(takerSide, "yes"), takerPrice, shares)
	}
	if makerUser != uuid.Nil {
		_ = ix.db.ApplyFillToPosition(ctx, marketID, makerUser, orSide(makerSide, "no"), price, shares)
	}

	// Volume: each matched pair collateralizes $1/share.
	ix.refreshBook(ctx, marketID, chainMarketID, shares*ix.client.Unit)

	// WS: trade tape + order state for both parties.
	ix.fanout.Publish("book:"+marketID.String(), "trade", map[string]any{
		"market_id": marketID, "price_cents": price, "shares": shares,
	})
	for _, u := range []uuid.UUID{takerUser, makerUser} {
		if u == uuid.Nil {
			continue
		}
		ix.notif.Notify(ctx, u, notify.KindOrderFilled, map[string]any{
			"market_id": marketID, "price_cents": price, "shares": shares,
		})
	}
}

func orSide(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func (ix *Indexer) onOrderCancelled(ctx context.Context, p map[string]any) {
	chainMarketID := asBig(p["marketId"]).Int64()
	marketID, err := ix.db.MarketByChainID(ctx, chainMarketID)
	if err != nil || marketID == uuid.Nil {
		return
	}
	userID, _ := ix.db.MarkOrderCancelled(ctx, marketID, asBig(p["orderId"]).Int64())
	if userID != uuid.Nil {
		ix.fanout.SendToUser(userID, "order.canceled", map[string]any{
			"market_id": marketID, "status": "CANCELED",
		})
	}
	ix.refreshBook(ctx, marketID, chainMarketID, 0)
}

// onOrderRejected surfaces contract-side rejections (bad auth, expiry, …) as
// order failures: the maker's oldest submitted-but-unbound order for the
// market is cancelled and the maker notified with the contract's reason.
func (ix *Indexer) onOrderRejected(ctx context.Context, p map[string]any) {
	chainMarketID := asBig(p["marketId"]).Int64()
	maker := asAddr(p["maker"])
	reason, _ := p["reason"].(string)
	marketID, err := ix.db.MarketByChainID(ctx, chainMarketID)
	if err != nil || marketID == uuid.Nil {
		return
	}
	userID, err := ix.db.UserIDByWallet(ctx, maker.Hex())
	if err != nil || userID == uuid.Nil {
		return
	}
	// Cancel the oldest in-flight order of this maker on this market that
	// never received a chain order id.
	_, _ = ix.db.Pool().Exec(ctx, `
		UPDATE orders SET status='CANCELED', updated_at=now()
		WHERE id = (
			SELECT id FROM orders
			WHERE market_id=$1 AND user_id=$2 AND chain_order_id IS NULL AND status='QUEUED'
			ORDER BY created_at LIMIT 1)`, marketID, userID)
	ix.notif.Notify(ctx, userID, "order.rejected", map[string]any{
		"market_id": marketID, "reason": reason, "status": "CANCELED",
	})
}

func (ix *Indexer) onMarketMatched(ctx context.Context, p map[string]any) {
	marketID, err := ix.db.MarketByChainID(ctx, asBig(p["marketId"]).Int64())
	if err != nil || marketID == uuid.Nil {
		return
	}
	creator, err := ix.db.SetMarketStatus(ctx, marketID, "MATCHED")
	if err != nil || creator == uuid.Nil {
		return
	}
	// §5 creator microcopy: MATCHED → "Your bet was taken."
	ix.notif.Notify(ctx, creator, notify.KindMarketMatched, map[string]any{
		"market_id": marketID,
		"message":   "Your bet was taken.",
	})
	ix.fanout.Publish("book:"+marketID.String(), "market.status", map[string]any{
		"market_id": marketID, "status": "MATCHED",
	})
}

func (ix *Indexer) onSettlementRequested(ctx context.Context, p map[string]any) {
	marketID, err := ix.db.MarketByChainID(ctx, asBig(p["marketId"]).Int64())
	if err != nil || marketID == uuid.Nil {
		return
	}
	_, _ = ix.db.SetMarketStatus(ctx, marketID, "SETTLING")
	_ = ix.db.ClearSettlementRequest(ctx, marketID)
	ix.fanout.Publish("book:"+marketID.String(), "market.status", map[string]any{
		"market_id": marketID, "status": "SETTLING",
	})
}

func (ix *Indexer) onMarketSettled(ctx context.Context, p map[string]any) {
	marketID, err := ix.db.MarketByChainID(ctx, asBig(p["marketId"]).Int64())
	if err != nil || marketID == uuid.Nil {
		return
	}
	direction := false
	switch d := p["direction"].(type) {
	case bool:
		direction = d
	case *big.Int:
		direction = d.Sign() > 0
	}
	creator, err := ix.db.SettleMarketRow(ctx, marketID, direction)
	if err != nil {
		return
	}
	holders, _ := ix.db.SettlePositions(ctx, marketID, direction, ix.client.Unit)
	outcome := "NO"
	if direction {
		outcome = "YES"
	}
	payload := map[string]any{"market_id": marketID, "direction": direction, "outcome": outcome, "status": "SETTLED"}
	ix.notif.NotifyMany(ctx, append(holders, creator), notify.KindMarketSettled, payload)
	ix.fanout.Publish("book:"+marketID.String(), "market.status", payload)
}

// refreshBook recomputes the best-price mirror (chain view first, DB
// aggregate fallback) and pushes a book delta.
func (ix *Indexer) refreshBook(ctx context.Context, marketID uuid.UUID, chainMarketID int64, volumeDelta int64) {
	var bestYes, bestNo *int
	if y, n, err := ix.client.BestPrices(ctx, chainMarketID); err == nil {
		if y > 0 {
			v := int(y)
			bestYes = &v
		}
		if n > 0 {
			v := int(n)
			bestNo = &v
		}
	} else {
		book, err := ix.db.MarketBook(ctx, marketID)
		if err == nil {
			if len(book.Yes) > 0 {
				bestYes = &book.Yes[0].PriceCents
			}
			if len(book.No) > 0 {
				bestNo = &book.No[0].PriceCents
			}
		}
	}
	_ = ix.db.UpdateMarketPrices(ctx, marketID, bestYes, bestNo, volumeDelta)
	ix.fanout.Publish("book:"+marketID.String(), "book.delta", map[string]any{
		"market_id":       marketID,
		"yes_price_cents": bestYes,
		"no_price_cents":  bestNo,
	})
}
