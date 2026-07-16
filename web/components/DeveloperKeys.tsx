"use client";

// Settings → Developer (spec §6.9): API-key management. Creating a key shows
// the full secret exactly ONCE in a copy-once modal; the list shows only the
// prefix; deletion requires confirmation.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi, errorMessage } from "@/lib/api";
import { useToast } from "@/providers/ToastProvider";
import { DOCS_URL } from "@/lib/config";
import { Sheet } from "@/components/Sheet";
import { RowSkeleton } from "@/components/Skeleton";
import { CheckIcon, CopyIcon, LinkIcon, Spinner } from "@/components/icons";
import { timeAgo } from "@/lib/format";
import type { ApiKey, ApiKeyCreated, ApiKeyScope } from "@/lib/types";

export function DeveloperKeys() {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const [deleting, setDeleting] = useState<ApiKey | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["developer-keys"],
    queryFn: () => api.get<{ keys: ApiKey[] }>("/v1/developer/keys"),
  });
  const keys = data?.keys ?? [];

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/v1/developer/keys/${id}`),
    onSuccess: () => {
      toast.success("Key revoked");
      setDeleting(null);
      queryClient.invalidateQueries({ queryKey: ["developer-keys"] });
    },
    onError: (err) => toast.error("Couldn't revoke key", errorMessage(err)),
  });

  return (
    <section className="card mt-4 p-5" aria-label="Developer">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-bold text-fg">Developer</h2>
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="flex items-center gap-1 text-xs font-semibold text-brand hover:underline"
        >
          <LinkIcon size={12} />
          API docs
        </a>
      </div>
      <p className="mb-4 text-xs leading-relaxed text-muted">
        API keys let your scripts and bots use the Thassa API.{" "}
        <strong>read</strong> keys can query; <strong>trade</strong> keys can
        also place and cancel orders.
      </p>

      {isLoading ? (
        <RowSkeleton rows={2} />
      ) : keys.length === 0 ? (
        <p className="mb-4 rounded-xl bg-surface/60 p-3 text-sm text-muted">
          No API keys yet.
        </p>
      ) : (
        <ul className="mb-4 divide-y divide-edge rounded-xl border border-edge">
          {keys.map((k) => (
            <li key={k.id} className="flex items-center gap-3 px-3.5 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-semibold text-fg">
                  <span className="truncate">{k.name}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                      k.scope === "trade"
                        ? "bg-brand-soft text-brand"
                        : "bg-surface text-muted"
                    }`}
                  >
                    {k.scope}
                  </span>
                </p>
                <p className="mt-0.5 font-mono text-xs text-muted">
                  {k.prefix}…{" "}
                  <span className="font-sans">
                    · created {timeAgo(k.created_at)} ago
                    {k.last_used_at
                      ? ` · last used ${timeAgo(k.last_used_at)} ago`
                      : " · never used"}
                  </span>
                </p>
              </div>
              <button
                onClick={() => setDeleting(k)}
                className="shrink-0 text-xs font-bold text-no hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}

      <button onClick={() => setCreating(true)} className="btn-ghost w-full">
        Create API key
      </button>

      {creating && (
        <CreateKeySheet
          onClose={() => setCreating(false)}
          onCreated={(k) => {
            setCreating(false);
            setCreated(k);
            queryClient.invalidateQueries({ queryKey: ["developer-keys"] });
          }}
        />
      )}

      {created && (
        <SecretOnceSheet apiKey={created} onClose={() => setCreated(null)} />
      )}

      {deleting && (
        <Sheet title="Revoke API key" onClose={() => setDeleting(null)}>
          <p className="text-sm leading-relaxed text-fg/90">
            Revoke <strong>{deleting.name}</strong> ({deleting.prefix}…)?
            Anything using this key stops working immediately. This can&apos;t
            be undone.
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button onClick={() => setDeleting(null)} className="btn-ghost">
              Cancel
            </button>
            <button
              onClick={() => remove.mutate(deleting.id)}
              disabled={remove.isPending}
              className="btn bg-no text-white hover:bg-no/90"
            >
              {remove.isPending ? <Spinner size={16} /> : "Revoke key"}
            </button>
          </div>
        </Sheet>
      )}
    </section>
  );
}

function CreateKeySheet({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (k: ApiKeyCreated) => void;
}) {
  const api = useApi();
  const toast = useToast();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<ApiKeyScope>("read");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!name.trim()) {
      toast.error("Name your key", "e.g. “trading bot” or “analytics”.");
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<{ key: ApiKeyCreated }>("/v1/developer/keys", {
        name: name.trim(),
        scope,
      });
      onCreated(res.key);
    } catch (err) {
      toast.error("Couldn't create key", errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title="Create API key" onClose={onClose}>
      <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-muted">
        Name
      </label>
      <input
        className="input mb-4"
        placeholder="My trading bot"
        value={name}
        maxLength={60}
        onChange={(e) => setName(e.target.value)}
        aria-label="Key name"
      />

      <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-muted">
        Scope
      </label>
      <div className="mb-5 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Key scope">
        {(
          [
            ["read", "Read", "Query markets, feeds and your data."],
            ["trade", "Trade", "Everything in read, plus placing and canceling orders."],
          ] as [ApiKeyScope, string, string][]
        ).map(([s, label, desc]) => (
          <button
            key={s}
            role="radio"
            aria-checked={scope === s}
            onClick={() => setScope(s)}
            className={`rounded-xl border-2 p-3 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand ${
              scope === s
                ? "border-brand bg-brand-soft/40"
                : "border-edge hover:bg-surface"
            }`}
          >
            <span className="block text-sm font-bold text-fg">{label}</span>
            <span className="mt-0.5 block text-xs leading-snug text-muted">{desc}</span>
          </button>
        ))}
      </div>

      <button onClick={create} disabled={busy} className="btn-brand w-full !py-3">
        {busy ? <Spinner size={16} /> : "Create key"}
      </button>
    </Sheet>
  );
}

function SecretOnceSheet({
  apiKey,
  onClose,
}: {
  apiKey: ApiKeyCreated;
  onClose: () => void;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(apiKey.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy — select and copy manually.");
    }
  };

  return (
    <Sheet title="Your new API key" onClose={onClose}>
      <p className="rounded-xl bg-settling/10 p-3 text-xs font-semibold leading-relaxed text-settling">
        Copy this secret now — you won&apos;t see it again. If you lose it,
        revoke the key and create a new one.
      </p>
      <p className="mt-3 text-sm text-fg">
        <strong>{apiKey.name}</strong>{" "}
        <span className="text-xs uppercase text-muted">({apiKey.scope})</span>
      </p>
      <button
        onClick={copy}
        aria-label="Copy API key secret"
        className="btn-ghost mt-2 w-full justify-between gap-3 font-mono text-xs"
      >
        <span className="truncate">{apiKey.secret}</span>
        {copied ? (
          <CheckIcon size={14} className="shrink-0 text-yes" />
        ) : (
          <CopyIcon size={14} className="shrink-0" />
        )}
      </button>
      <button onClick={onClose} className="btn-brand mt-4 w-full">
        I&apos;ve saved it
      </button>
    </Sheet>
  );
}
