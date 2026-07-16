package chain

import (
	"errors"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
)

var (
	gMarkets = common.HexToAddress("0x2222222222222222222222222222222222222222")
	gToken   = common.HexToAddress("0x4444444444444444444444444444444444444444")
	gHub     = common.HexToAddress("0x5555555555555555555555555555555555555555")
	gRelayer = common.HexToAddress("0x6666666666666666666666666666666666666666")
	gMaker   = common.HexToAddress("0x1111111111111111111111111111111111111111")
	gNow     = time.Unix(1_760_000_000, 0)
)

func testGate() *Gate {
	return NewGate(gMarkets, gToken, gHub, gRelayer, testChainID, 1_000_000_000) // $1000 cap
}

// validOrderAndAuth builds an order + auth pair that passes every gate check,
// including the §9 signature-carriage binding (auth nonce = order digest).
func validOrderAndAuth(g *Gate) (Order, *Auth3009) {
	o := testOrder
	o.Maker = gMaker
	o.Expiry = gNow.Unix() + 3600
	o.MaxCost = EstimateMaxCost(o.Shares, int(o.Price), unit6)
	a := &Auth3009{
		From:        gMaker,
		To:          g.Markets,
		Value:       o.MaxCost,
		ValidAfter:  0,
		ValidBefore: gNow.Unix() + 3600,
		Nonce:       OrderDigest(o, g.ChainID, g.Markets),
	}
	return o, a
}

func TestGateAllowlist(t *testing.T) {
	g := testGate()
	allowed := []struct {
		to     common.Address
		method string
	}{
		{gMarkets, "placeOrdersBatch"},
		{gMarkets, "createMarket"},
		{gMarkets, "cancelOrder"},
		{gMarkets, "settleMarketWithAuth"},
		{gMarkets, "redeem"},
		{gMarkets, "registerAffiliatePost"},
		{gToken, "transferWithAuthorization"},
	}
	for _, a := range allowed {
		if !g.AllowCall(a.to, a.method) {
			t.Fatalf("expected %s.%s allowed", a.to, a.method)
		}
	}
	denied := []struct {
		to     common.Address
		method string
	}{
		{gMarkets, "withdraw"},                   // never relayed
		{gMarkets, "settleMarket"},               // only the WithAuth variant
		{gToken, "transfer"},                     // arbitrary ERC-20 moves
		{gToken, "approve"},                      // never
		{gToken, "receiveWithAuthorization"},     // only via markets contract
		{gHub, "placeBidWithInputData"},          // hub is called by markets, not us
		{common.HexToAddress("0xdead"), "anything"}, // unknown contract
	}
	for _, d := range denied {
		if g.AllowCall(d.to, d.method) {
			t.Fatalf("expected %s.%s DENIED", d.to, d.method)
		}
	}
}

func TestGateCheckOrderHappyPath(t *testing.T) {
	g := testGate()
	o, a := validOrderAndAuth(g)
	if err := g.CheckOrder(o, a, unit6, gNow); err != nil {
		t.Fatalf("valid order rejected: %v", err)
	}
}

func TestGateCheckOrderRejections(t *testing.T) {
	g := testGate()

	t.Run("auth pays wrong recipient", func(t *testing.T) {
		o, a := validOrderAndAuth(g)
		a.To = gRelayer
		if err := g.CheckOrder(o, a, unit6, gNow); !errors.Is(err, ErrBadAuthRecipient) {
			t.Fatalf("want ErrBadAuthRecipient, got %v", err)
		}
	})
	t.Run("auth from someone else", func(t *testing.T) {
		o, a := validOrderAndAuth(g)
		a.From = gRelayer
		if err := g.CheckOrder(o, a, unit6, gNow); !errors.Is(err, ErrBadAuthSender) {
			t.Fatalf("want ErrBadAuthSender, got %v", err)
		}
	})
	t.Run("auth nonce not the order digest", func(t *testing.T) {
		o, a := validOrderAndAuth(g)
		a.Nonce[0] ^= 0xff
		if err := g.CheckOrder(o, a, unit6, gNow); !errors.Is(err, ErrDigestMismatch) {
			t.Fatalf("want ErrDigestMismatch, got %v", err)
		}
	})
	t.Run("underfunded auth", func(t *testing.T) {
		o, a := validOrderAndAuth(g)
		a.Value = Escrow(o.Shares, int(o.Price), unit6) - 1
		if err := g.CheckOrder(o, a, unit6, gNow); !errors.Is(err, ErrAuthValue) {
			t.Fatalf("want ErrAuthValue, got %v", err)
		}
	})
	t.Run("order too large", func(t *testing.T) {
		o, a := validOrderAndAuth(g)
		o.Shares = 2_000_000 // ≫ $1000 cap
		o.MaxCost = EstimateMaxCost(o.Shares, int(o.Price), unit6)
		a.Value = o.MaxCost
		a.Nonce = OrderDigest(o, g.ChainID, g.Markets)
		if err := g.CheckOrder(o, a, unit6, gNow); !errors.Is(err, ErrOrderTooLarge) {
			t.Fatalf("want ErrOrderTooLarge, got %v", err)
		}
	})
	t.Run("expired order", func(t *testing.T) {
		o, a := validOrderAndAuth(g)
		o.Expiry = gNow.Unix() - 1
		if err := g.CheckOrder(o, a, unit6, gNow); !errors.Is(err, ErrOrderExpired) {
			t.Fatalf("want ErrOrderExpired, got %v", err)
		}
	})
	t.Run("expired auth window", func(t *testing.T) {
		o, a := validOrderAndAuth(g)
		a.ValidBefore = gNow.Unix() - 1
		if err := g.CheckOrder(o, a, unit6, gNow); !errors.Is(err, ErrAuthWindow) {
			t.Fatalf("want ErrAuthWindow, got %v", err)
		}
	})
	t.Run("bad price", func(t *testing.T) {
		o, a := validOrderAndAuth(g)
		o.Price = 0
		if err := g.CheckOrder(o, a, unit6, gNow); !errors.Is(err, ErrBadPrice) {
			t.Fatalf("want ErrBadPrice, got %v", err)
		}
		o.Price = 100
		if err := g.CheckOrder(o, a, unit6, gNow); !errors.Is(err, ErrBadPrice) {
			t.Fatalf("want ErrBadPrice, got %v", err)
		}
	})
	t.Run("maxCost below escrow+fee", func(t *testing.T) {
		o, a := validOrderAndAuth(g)
		o.MaxCost = Escrow(o.Shares, int(o.Price), unit6) // no fee headroom
		if err := g.CheckOrder(o, a, unit6, gNow); err == nil {
			t.Fatal("expected rejection for insufficient maxCost")
		}
	})
}

func TestGateCheckAuthPurposes(t *testing.T) {
	g := testGate()
	base := Auth3009{From: gMaker, Value: 50_000, ValidBefore: gNow.Unix() + 60}

	t.Run("settlement must pay the markets contract", func(t *testing.T) {
		a := base
		a.To = g.Markets
		if err := g.CheckAuth(&a, PurposeSettlement, gMaker, common.Address{}, gNow); err != nil {
			t.Fatalf("valid settlement auth rejected: %v", err)
		}
		a.To = gRelayer
		if err := g.CheckAuth(&a, PurposeSettlement, gMaker, common.Address{}, gNow); !errors.Is(err, ErrBadAuthRecipient) {
			t.Fatalf("want ErrBadAuthRecipient, got %v", err)
		}
	})
	t.Run("wallet send must pay the declared recipient", func(t *testing.T) {
		recipient := common.HexToAddress("0x7777777777777777777777777777777777777777")
		a := base
		a.To = recipient
		if err := g.CheckAuth(&a, PurposeWalletSend, gMaker, recipient, gNow); err != nil {
			t.Fatalf("valid send auth rejected: %v", err)
		}
		a.To = gRelayer // attacker redirects funds to the relayer
		if err := g.CheckAuth(&a, PurposeWalletSend, gMaker, recipient, gNow); !errors.Is(err, ErrBadAuthRecipient) {
			t.Fatalf("want ErrBadAuthRecipient, got %v", err)
		}
	})
	t.Run("unknown purpose rejected", func(t *testing.T) {
		a := base
		a.To = g.Markets
		if err := g.CheckAuth(&a, "arbitrary", gMaker, common.Address{}, gNow); err == nil {
			t.Fatal("unknown purpose must be rejected")
		}
	})
	t.Run("nil auth rejected", func(t *testing.T) {
		if err := g.CheckAuth(nil, PurposeOrder, gMaker, common.Address{}, gNow); err == nil {
			t.Fatal("nil auth must be rejected")
		}
	})
}
