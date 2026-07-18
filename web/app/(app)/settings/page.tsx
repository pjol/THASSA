"use client";

// Settings: edit profile (PATCH /v1/me), privacy toggles (PATCH
// /v1/me/settings — private account + trades visibility), theme, logout.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi, errorMessage } from "@/lib/api";
import { useAuth } from "@/providers/AuthProvider";
import { useSession } from "@/providers/SessionProvider";
import { useTheme, type ThemePref } from "@/providers/ThemeProvider";
import { useToast } from "@/providers/ToastProvider";
import { useWarp } from "@/providers/WarpProvider";
import { Avatar } from "@/components/Avatar";
import { DeveloperKeys } from "@/components/DeveloperKeys";
import { AdminWarp } from "@/components/AdminWarp";
import { AdminReservations } from "@/components/AdminReservations";
import { CameraIcon, Spinner } from "@/components/icons";

export default function SettingsPage() {
  const api = useApi();
  const toast = useToast();
  const router = useRouter();
  const { logout } = useAuth();
  const { me, refresh } = useSession();
  const { active: warped } = useWarp();
  const { pref, setPref } = useTheme();

  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [links, setLinks] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // privacy
  const [isPrivate, setIsPrivate] = useState(false);
  const [tradesPublic, setTradesPublic] = useState(true);

  useEffect(() => {
    if (!me) return;
    setUsername(me.username ?? "");
    setDisplayName(me.display_name ?? "");
    setBio(me.bio ?? "");
    setLinks((me.links ?? []).join("\n"));
    setAvatarUrl(me.avatar_url);
    setIsPrivate(me.private);
    setTradesPublic(me.trades_public);
  }, [me]);

  const pickAvatar = async (file: File) => {
    setUploading(true);
    try {
      const media = await api.uploadMedia(file);
      setAvatarUrl(media.url);
    } catch (err) {
      toast.error("Avatar upload failed", errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.patch("/v1/me", {
        username,
        display_name: displayName || null,
        bio: bio || null,
        avatar_url: avatarUrl,
        links: links
          .split(/[\n,]/)
          .map((l) => l.trim())
          .filter(Boolean),
      });
      await refresh();
      toast.success("Profile saved");
    } catch (err) {
      toast.error("Couldn't save profile", errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  // Privacy toggles save immediately with optimistic flip.
  const savePrivacy = async (patch: {
    private?: boolean;
    trades_visibility?: "public" | "private";
  }) => {
    try {
      await api.patch("/v1/me/settings", patch);
      await refresh();
    } catch (err) {
      toast.error("Couldn't update privacy", errorMessage(err));
      // revert
      if (me) {
        setIsPrivate(me.private);
        setTradesPublic(me.trades_public);
      }
    }
  };

  return (
    <div className="mx-auto w-full max-w-xl px-4 pb-12 pt-4 md:pt-8">
      <h1 className="mb-5 text-xl font-extrabold tracking-tight text-fg">Settings</h1>

      {/* profile */}
      <form onSubmit={saveProfile} className="card p-5">
        <h2 className="mb-4 text-sm font-bold text-fg">Profile</h2>
        <div className="mb-5 flex justify-center">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            aria-label="Change profile photo"
            className="group relative rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
          >
            <Avatar
              user={{ username, display_name: displayName, avatar_url: avatarUrl }}
              size="xl"
            />
            <span className="absolute -bottom-1 -right-1 rounded-full bg-brand p-2 text-white shadow-soft transition group-hover:scale-105">
              {uploading ? <Spinner size={14} /> : <CameraIcon size={14} />}
            </span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            aria-hidden
            onChange={(e) => e.target.files?.[0] && pickAvatar(e.target.files[0])}
          />
        </div>

        <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-muted">
          Username
        </label>
        <input
          className="input mb-4"
          value={username}
          onChange={(e) => setUsername(e.target.value.toLowerCase())}
        />
        <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-muted">
          Display name
        </label>
        <input
          className="input mb-4"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-muted">
          Bio
        </label>
        <textarea
          className="input mb-4 resize-none"
          rows={3}
          maxLength={160}
          value={bio}
          onChange={(e) => setBio(e.target.value)}
        />
        <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-muted">
          Links
        </label>
        <textarea
          className="input mb-5 resize-none"
          rows={2}
          value={links}
          onChange={(e) => setLinks(e.target.value)}
          placeholder="https://…"
        />
        <button type="submit" disabled={saving || uploading} className="btn-brand w-full">
          {saving ? <Spinner size={16} /> : "Save profile"}
        </button>
      </form>

      {/* privacy */}
      <section className="card mt-4 p-5" aria-label="Privacy">
        <h2 className="mb-1 text-sm font-bold text-fg">Privacy</h2>
        <Toggle
          label="Private account"
          description="Only approved followers see your posts, reels and trades. New followers must request."
          checked={isPrivate}
          onChange={(v) => {
            setIsPrivate(v);
            savePrivacy({ private: v });
          }}
        />
        <Toggle
          label="Public trades"
          description="Show your Trades tab and position badges on your posts. Turn off to keep your betting history to yourself."
          checked={tradesPublic}
          onChange={(v) => {
            setTradesPublic(v);
            savePrivacy({ trades_visibility: v ? "public" : "private" });
          }}
        />
      </section>

      {/* appearance */}
      <section className="card mt-4 p-5" aria-label="Appearance">
        <h2 className="mb-3 text-sm font-bold text-fg">Appearance</h2>
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
          {(["light", "system", "dark"] as ThemePref[]).map((p) => (
            <button
              key={p}
              role="radio"
              aria-checked={pref === p}
              onClick={() => setPref(p)}
              className={`rounded-xl border-2 py-2.5 text-sm font-bold capitalize transition ${
                pref === p
                  ? "border-accent bg-accent text-accent-fg"
                  : "border-edge text-muted hover:bg-surface"
              }`}
            >
              {p}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">
          Dark mode inverts black and white — Thassa blue stays Thassa blue.
        </p>
      </section>

      {/* developer: API keys (spec §6.9) */}
      <DeveloperKeys />

      {/* admin: warp / impersonation (spec §7c) — real admins only, and hidden
          while already warped (warp can't escalate into another admin). */}
      {me?.is_admin && !warped && (
        <>
          <AdminWarp />
          <AdminReservations />
        </>
      )}

      <button
        onClick={async () => {
          await logout();
          router.replace("/login");
        }}
        className="btn-ghost mt-6 w-full !text-no"
      >
        Log out
      </button>
    </div>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-edge">
      <div>
        <p className="text-sm font-semibold text-fg">{label}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">{description}</p>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
          checked ? "bg-brand" : "bg-edge"
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
            checked ? "left-[22px]" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}
