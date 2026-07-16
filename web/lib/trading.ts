"use client";

// Order placement pipeline (spec §3 gasless UX): build the EIP-712 Order,
// sign it with the Privy embedded wallet, sign a matching EIP-3009
// receiveWithAuthorization funding the markets contract, then hand both to
// the relayer via POST /v1/orders. Also market creation and settlement.

import { useMemo } from "react";
import { useApi } from "@/lib/api";
import { useWalletSigner } from "@/providers/AuthProvider";
import { MARKETS_CONTRACT_ADDRESS, PAYMENT_TOKEN_DECIMALS } from "@/lib/config";
import {
  buildReceiveAuthTypedData,
  maxCostUnits,
  orderDigest,
  randomAuthNonce,
  serializeAuth,
  serializeOrder,
  type Auth3009Fields,
  type OrderFields,
  type SideNum,
} from "@/lib/signing";
import type { Market, MarketCandidate, Order, Side, Wallet } from "@/lib/types";

const HOUR = 3600n;

export interface PlaceOrderParams {
  market: Market;
  side: Side;
  priceCents: number; // limit price (maker price)
  shares: bigint;
  affiliateId?: number | null; // onchain affiliate id of the routing post
  affiliatePostId?: string | null; // backend post uuid, for attribution
  // Stable per-logical-order key so user retries can't double-place.
  idempotencyKey?: string;
}

export interface CreateMarketParams {
  candidate: MarketCandidate;
  side: Side;
  priceCents: number; // sliding-scale maker price
  shares: bigint;
}

export function useTrading() {
  const api = useApi();
  const signer = useWalletSigner();

  return useMemo(() => {
    const sideNum = (s: Side): SideNum => (s === "yes" ? 0 : 1);

    async function signOrderAndFunding(params: {
      chainMarketId: bigint;
      side: Side;
      priceCents: number;
      shares: bigint;
      affiliateId: bigint;
    }) {
      if (!signer.address) throw new Error("wallet not ready");
      // The wallet endpoint reports the maker's next order nonce.
      const { wallet } = await api.get<{ wallet: Wallet }>("/v1/wallet");
      const now = BigInt(Math.floor(Date.now() / 1000));
      const maxCost = maxCostUnits(params.shares, params.priceCents);

      const order: OrderFields = {
        marketId: params.chainMarketId,
        side: sideNum(params.side),
        price: params.priceCents,
        shares: params.shares,
        maxCost,
        affiliatePostId: params.affiliateId,
        expiry: now + 24n * HOUR,
        nonce: BigInt(wallet.order_nonce),
        maker: signer.address,
      };

      // Signature carriage (spec §9): the order itself is NOT separately
      // signed. Its EIP-712 digest becomes the 3009 auth nonce, and the user
      // signs ONE thing — the ReceiveWithAuthorization — binding funding and
      // order together in a single wallet prompt.
      const auth: Auth3009Fields = {
        from: signer.address,
        to: MARKETS_CONTRACT_ADDRESS,
        value: maxCost,
        validAfter: 0n,
        validBefore: now + 24n * HOUR,
        nonce: orderDigest(order),
      };
      const authSig = await signer.signTypedData(buildReceiveAuthTypedData(auth));

      return {
        order: serializeOrder(order),
        auth: serializeAuth(auth, authSig),
      };
    }

    return {
      // Quick-buy / advanced order from a market widget or detail page.
      async placeOrder(p: PlaceOrderParams): Promise<Order> {
        const signed = await signOrderAndFunding({
          chainMarketId: BigInt(p.market.chain_market_id),
          side: p.side,
          priceCents: p.priceCents,
          shares: p.shares,
          affiliateId: BigInt(p.affiliateId ?? 0),
        });
        const res = await api.post<{ order: Order }>(
          "/v1/orders",
          {
            market_id: p.market.id,
            affiliate_post_id: p.affiliatePostId ?? null,
            ...signed,
          },
          { idempotencyKey: p.idempotencyKey },
        );
        return res.order;
      },

      // Sign an order against an existing market WITHOUT submitting it —
      // used by the create-post flow so post + order land atomically.
      async signAttachOrder(p: PlaceOrderParams) {
        const signed = await signOrderAndFunding({
          chainMarketId: BigInt(p.market.chain_market_id),
          side: p.side,
          priceCents: p.priceCents,
          shares: p.shares,
          affiliateId: BigInt(p.affiliateId ?? 0),
        });
        return { market_id: p.market.id, ...signed };
      },

      // Sign the creator's initial order for a brand-new market (chain id not
      // yet known → marketId 0 per relayer createMarket convention). Returned
      // payload is submitted with the post, atomically (spec §7).
      async signCreateMarket(p: CreateMarketParams) {
        const signed = await signOrderAndFunding({
          chainMarketId: 0n,
          side: p.side,
          priceCents: p.priceCents,
          shares: p.shares,
          affiliateId: 0n,
        });
        return {
          question: p.candidate.question,
          settlement_query: p.candidate.settlement_query,
          title: p.candidate.title,
          initial_order: signed.order,
          auth: signed.auth,
        };
      },

      async cancelOrder(orderId: string): Promise<void> {
        await api.del(`/v1/orders/${orderId}`);
      },

      // Settle market — pays the 5¢ settlement fee via a signed EIP-3009 auth.
      async settleMarket(market: Market): Promise<void> {
        if (!signer.address) throw new Error("wallet not ready");
        const now = BigInt(Math.floor(Date.now() / 1000));
        const fiveCents = 10n ** BigInt(PAYMENT_TOKEN_DECIMALS) / 20n;
        const auth: Auth3009Fields = {
          from: signer.address,
          to: MARKETS_CONTRACT_ADDRESS,
          value: fiveCents,
          validAfter: 0n,
          validBefore: now + HOUR,
          nonce: randomAuthNonce(),
        };
        const sig = await signer.signTypedData(buildReceiveAuthTypedData(auth));
        await api.post(`/v1/markets/${market.id}/settle`, {
          auth: serializeAuth(auth, sig),
        });
      },
    };
  }, [api, signer]);
}
