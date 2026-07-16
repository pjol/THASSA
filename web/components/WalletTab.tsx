"use client";

// Wallet tab on MY profile (spec §7): balance card (payment token only),
// Receive (address + QR), Send (EIP-3009 transferWithAuthorization → relayed),
// Fund (fiat onramp checkout / cross-chain crypto deposit), activity list,
// and positions summary with PnL.

import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi, errorMessage, newIdempotencyKey } from "@/lib/api";
import { useWalletSigner } from "@/providers/AuthProvider";
import { useToast } from "@/providers/ToastProvider";
import { QRCode } from "@/components/QRCode";
import { Sheet } from "@/components/Sheet";
import { StateChip } from "@/components/StateChip";
import { RowSkeleton, Skeleton } from "@/components/Skeleton";
import { EmptyState } from "@/components/EmptyState";
import { CheckIcon, CopyIcon, Spinner, WalletIcon } from "@/components/icons";
import {
  buildTransferAuthTypedData,
  dollarsToUnits,
  randomAuthNonce,
  serializeAuth,
  type Auth3009Fields,
} from "@/lib/signing";
import {
  fmtCents,
  fmtSignedUnits,
  fmtUnits,
  shortAddress,
  timeAgo,
} from "@/lib/format";
import type {
  ActivityPage,
  OnrampSession,
  Position,
  Wallet,
} from "@/lib/types";

type SheetKind = "receive" | "send" | "fund" | null;

export function WalletTab() {
  const api = useApi();
  const [sheet, setSheet] = useState<SheetKind>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["wallet"],
    queryFn: () => api.get<{ wallet: Wallet }>("/v1/wallet"),
  });
  const wallet = data?.wallet;

  return (
    <div className="space-y-4 pb-8">
      {/* balance card */}
      <div className="card overflow-hidden">
        <div className="bg-gradient-to-br from-brand to-brand/70 p-5 text-white">
          <p className="text-xs font-bold uppercase tracking-wider text-white/80">
            Balance
          </p>
          {isLoading || !wallet ? (
            <Skeleton className="mt-1 h-9 w-36 bg-white/20" />
          ) : (
            <p className="font-mono text-3xl font-extrabold tabular-nums">
              {fmtUnits(wallet.balance)}
            </p>
          )}
          <p className="mt-1 text-xs text-white/80">
            {wallet?.symbol ?? "USD"} · {shortAddress(wallet?.address)}
          </p>
        </div>
        <div className="grid grid-cols-3 divide-x divide-edge">
          {(
            [
              ["receive", "Receive"],
              ["send", "Send"],
              ["fund", "Fund"],
            ] as [SheetKind, string][]
          ).map(([k, label]) => (
            <button
              key={label}
              onClick={() => setSheet(k)}
              className="py-3 text-sm font-bold text-brand transition hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <PositionsSummary />
      <Activity />

      {sheet === "receive" && wallet && (
        <ReceiveSheet wallet={wallet} onClose={() => setSheet(null)} />
      )}
      {sheet === "send" && wallet && (
        <SendSheet wallet={wallet} onClose={() => setSheet(null)} />
      )}
      {sheet === "fund" && <FundSheet onClose={() => setSheet(null)} />}
    </div>
  );
}

function ReceiveSheet({ wallet, onClose }: { wallet: Wallet; onClose: () => void }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy address");
    }
  };
  return (
    <Sheet title="Receive" onClose={onClose}>
      <div className="flex flex-col items-center gap-4 py-2">
        <QRCode value={wallet.address} />
        <button
          onClick={copy}
          className="btn-ghost w-full justify-between font-mono text-xs"
          aria-label="Copy wallet address"
        >
          <span className="truncate">{wallet.address}</span>
          {copied ? <CheckIcon size={14} className="text-yes" /> : <CopyIcon size={14} />}
        </button>
        <p className="text-center text-xs leading-relaxed text-muted">
          Send only the payment token ({wallet.symbol}) on Tempo to this
          address. Use <strong>Fund</strong> for cards or other chains.
        </p>
      </div>
    </Sheet>
  );
}

function SendSheet({ wallet, onClose }: { wallet: Wallet; onClose: () => void }) {
  const api = useApi();
  const toast = useToast();
  const signer = useWalletSigner();
  const queryClient = useQueryClient();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  const send = async () => {
    const dollars = parseFloat(amount) || 0;
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
      toast.error("Invalid address", "Recipient must be a 0x… address.");
      return;
    }
    if (dollars <= 0) {
      toast.error("Enter an amount");
      return;
    }
    setBusy(true);
    try {
      if (!signer.address) throw new Error("wallet not ready");
      const now = BigInt(Math.floor(Date.now() / 1000));
      const auth: Auth3009Fields = {
        from: signer.address,
        to: to as `0x${string}`,
        value: dollarsToUnits(dollars),
        validAfter: 0n,
        validBefore: now + 3600n,
        nonce: randomAuthNonce(),
      };
      const sig = await signer.signTypedData(buildTransferAuthTypedData(auth));
      await api.post(
        "/v1/wallet/send",
        { auth: serializeAuth(auth, sig) },
        { idempotencyKey: newIdempotencyKey() },
      );
      toast.success("Sent", `${fmtUnits(auth.value)} to ${shortAddress(to)}`);
      queryClient.invalidateQueries({ queryKey: ["wallet"] });
      queryClient.invalidateQueries({ queryKey: ["wallet-activity"] });
      onClose();
    } catch (err) {
      toast.error("Send failed", errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title="Send" onClose={onClose}>
      <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-muted">
        Recipient address
      </label>
      <input
        className="input mb-4 font-mono text-xs"
        placeholder="0x…"
        value={to}
        onChange={(e) => setTo(e.target.value.trim())}
        aria-label="Recipient address"
      />
      <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-muted">
        Amount ({wallet.symbol})
      </label>
      <div className="relative mb-2">
        <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm font-semibold text-muted">
          $
        </span>
        <input
          className="input !pl-7 font-mono tabular-nums"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          aria-label="Amount in dollars"
        />
      </div>
      <p className="mb-4 text-xs text-muted">
        Available {fmtUnits(wallet.balance)} · gasless, relayed by Thassa.
      </p>
      <button onClick={send} disabled={busy} className="btn-brand w-full !py-3">
        {busy ? <Spinner size={16} /> : "Sign & send"}
      </button>
    </Sheet>
  );
}

function FundSheet({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const toast = useToast();
  const [busy, setBusy] = useState<"fiat" | "crypto" | null>(null);
  const [crypto, setCrypto] = useState<OnrampSession | null>(null);

  const start = async (kind: "fiat" | "crypto") => {
    setBusy(kind);
    try {
      const res = await api.post<{ session: OnrampSession }>(
        "/v1/onramp/sessions",
        { kind },
        { idempotencyKey: newIdempotencyKey() },
      );
      if (kind === "fiat" && res.session.checkout_url) {
        window.open(res.session.checkout_url, "_blank", "noopener");
        onClose();
      } else {
        setCrypto(res.session);
      }
    } catch (err) {
      toast.error("Couldn't start funding", errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet title="Fund your wallet" onClose={onClose}>
      {!crypto ? (
        <div className="space-y-3">
          <button
            onClick={() => start("fiat")}
            disabled={busy !== null}
            className="card flex w-full items-center gap-3 p-4 text-left transition hover:border-brand hover:bg-brand-soft/30"
          >
            <span className="rounded-xl bg-brand-soft p-2.5 text-brand">
              {busy === "fiat" ? <Spinner size={20} /> : <WalletIcon size={20} />}
            </span>
            <span>
              <span className="block text-sm font-bold text-fg">Card / bank</span>
              <span className="block text-xs text-muted">
                Checkout with our payment partner — funds land as {`the payment token`}.
              </span>
            </span>
          </button>
          <button
            onClick={() => start("crypto")}
            disabled={busy !== null}
            className="card flex w-full items-center gap-3 p-4 text-left transition hover:border-brand hover:bg-brand-soft/30"
          >
            <span className="rounded-xl bg-brand-soft p-2.5 text-brand">
              {busy === "crypto" ? <Spinner size={20} /> : <CopyIcon size={20} />}
            </span>
            <span>
              <span className="block text-sm font-bold text-fg">Crypto deposit</span>
              <span className="block text-xs text-muted">
                Cross-chain deposit address — we convert and credit you.
              </span>
            </span>
          </button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4 py-2">
          {crypto.deposit_address && <QRCode value={crypto.deposit_address} />}
          <p className="w-full break-all rounded-xl bg-surface p-3 text-center font-mono text-xs">
            {crypto.deposit_address}
          </p>
          {crypto.instructions && (
            <p className="text-center text-xs leading-relaxed text-muted">
              {crypto.instructions}
            </p>
          )}
        </div>
      )}
    </Sheet>
  );
}

function PositionsSummary() {
  const api = useApi();
  const { data, isLoading } = useQuery({
    queryKey: ["positions"],
    queryFn: () => api.get<{ positions: Position[] }>("/v1/positions"),
  });
  const positions = data?.positions ?? [];

  return (
    <section className="card p-4" aria-label="Positions">
      <h3 className="mb-3 text-sm font-bold text-fg">Positions</h3>
      {isLoading ? (
        <RowSkeleton rows={2} />
      ) : positions.length === 0 ? (
        <p className="text-sm text-muted">No open positions. Find a market you have an opinion on.</p>
      ) : (
        <ul className="space-y-2.5">
          {positions.map((p) => (
            <li key={`${p.market_id}-${p.side}`}>
              <Link
                href={`/markets/${p.market_id}`}
                className="flex items-center justify-between gap-3 text-sm hover:opacity-80"
              >
                <span className="min-w-0 flex-1 truncate text-fg">
                  {p.market?.question ?? p.market_id}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {p.market && (
                    <StateChip state={p.market.status} direction={p.market.direction} size="xs" />
                  )}
                  <strong className={p.side === "yes" ? "text-yes" : "text-no"}>
                    {p.shares} {p.side.toUpperCase()}
                  </strong>
                  <span className="text-xs text-muted">@ {fmtCents(p.avg_price_cents)}</span>
                  <span
                    className={`font-mono text-xs font-bold tabular-nums ${
                      (p.unrealized_pnl ?? p.realized_pnl ?? "0").startsWith("-")
                        ? "text-no"
                        : "text-yes"
                    }`}
                  >
                    {fmtSignedUnits(p.unrealized_pnl ?? p.realized_pnl ?? "0")}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Activity() {
  const api = useApi();
  const { data, isLoading } = useQuery({
    queryKey: ["wallet-activity"],
    queryFn: () => api.get<ActivityPage>("/v1/wallet/activity?limit=20"),
  });
  const items = data?.activity ?? [];

  return (
    <section className="card p-4" aria-label="Activity">
      <h3 className="mb-3 text-sm font-bold text-fg">Activity</h3>
      {isLoading ? (
        <RowSkeleton rows={4} />
      ) : items.length === 0 ? (
        <EmptyState title="No activity yet" body="Deposits, trades and sends show up here." />
      ) : (
        <ul className="divide-y divide-edge">
          {items.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <span className="min-w-0">
                <span className="block font-semibold capitalize text-fg">{a.kind}</span>
                <span className="block truncate text-xs text-muted">
                  {a.description ?? (a.counterparty ? shortAddress(a.counterparty) : "")} ·{" "}
                  {timeAgo(a.created_at)}
                </span>
              </span>
              <span
                className={`shrink-0 font-mono font-bold tabular-nums ${
                  a.amount.startsWith("-") ? "text-fg" : "text-yes"
                }`}
              >
                {fmtSignedUnits(a.amount)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
