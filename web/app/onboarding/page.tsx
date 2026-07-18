"use client";

// Onboarding: username, avatar, bio, links → PATCH /v1/me.

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useAuth } from "@/providers/AuthProvider";
import { useSession } from "@/providers/SessionProvider";
import { useApi, errorMessage } from "@/lib/api";
import { useToast } from "@/providers/ToastProvider";
import { Avatar } from "@/components/Avatar";
import { CameraIcon, ChevronLeftIcon, Spinner } from "@/components/icons";
import { LogoSpinner } from "@/components/LogoSpinner";

// Validate a profile link. A missing scheme defaults to https; requires an
// http(s) URL with a real host (dot in it).
function isValidUrl(raw: string): boolean {
  const s = raw.includes("://") ? raw : `https://${raw}`;
  try {
    const u = new URL(s);
    return (
      (u.protocol === "http:" || u.protocol === "https:") &&
      u.hostname.includes(".")
    );
  } catch {
    return false;
  }
}

export default function OnboardingPage() {
  const { ready, authenticated, logout } = useAuth();
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const { me, loading, refresh } = useSession();
  const api = useApi();
  const toast = useToast();
  const router = useRouter();

  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [links, setLinks] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (ready && !authenticated) router.replace("/login");
    if (me?.onboarded) router.replace("/");
  }, [ready, authenticated, me, router]);

  useEffect(() => {
    if (me) {
      setUsername((u) => u || me.username || "");
      setDisplayName((d) => d || me.display_name || "");
      setBio((b) => b || me.bio || "");
      setAvatarUrl((a) => a || me.avatar_url);
      setLinks((l) => l || me.links?.[0] || "");
    }
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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^[a-z0-9_.]{3,30}$/.test(username)) {
      toast.error(
        "Pick a valid username",
        "3–30 characters: lowercase letters, numbers, dots, underscores.",
      );
      return;
    }
    const link = links.trim();
    if (link && !isValidUrl(link)) {
      toast.error("Invalid link", "Enter a valid URL, e.g. https://example.com");
      return;
    }
    setSaving(true);
    try {
      await api.patch("/v1/me", {
        username,
        display_name: displayName || null,
        bio: bio || null,
        avatar_url: avatarUrl,
        links: link ? [link] : [],
        onboarded: true,
      });
      await refresh();
      router.replace("/");
    } catch (err) {
      toast.error("Couldn't save your profile", errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (!ready || loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <LogoSpinner size={48} />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4 py-10">
      <form onSubmit={submit} className="card w-full max-w-md p-7 shadow-soft">
        <div className="mb-6 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setCancelConfirm(true)}
            aria-label="Cancel signup and log out"
            className="-ml-1.5 rounded-full p-1.5 text-muted transition hover:bg-surface hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
          >
            <ChevronLeftIcon size={22} />
          </button>
          <Image src="/thassa-logo.svg" alt="" width={36} height={36} />
          <div>
            <h1 className="text-xl font-extrabold text-fg">Set up your profile</h1>
            <p className="text-sm text-muted">How you&apos;ll appear on Thassa.</p>
          </div>
        </div>

        <div className="mb-6 flex justify-center">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            aria-label="Choose profile photo"
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
          placeholder="yourname"
          autoComplete="off"
          required
        />

        <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-muted">
          Display name
        </label>
        <input
          className="input mb-4"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Your Name"
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
          placeholder="Say something about yourself"
        />

        <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-muted">
          Link
        </label>
        <input
          className="input mb-6"
          type="url"
          inputMode="url"
          autoCapitalize="none"
          value={links}
          onChange={(e) => setLinks(e.target.value)}
          placeholder="https://example.com"
        />

        <button type="submit" disabled={saving || uploading} className="btn-brand w-full !py-3">
          {saving ? <Spinner size={16} /> : "Enter Thassa"}
        </button>
      </form>

      {cancelConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => !loggingOut && setCancelConfirm(false)}
        >
          <div
            className="card w-full max-w-sm p-6 shadow-soft"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-extrabold text-fg">Cancel your signup?</h2>
            <p className="mt-2 text-sm text-muted">
              Are you sure you want to cancel your signup? You&apos;ll be logged
              out and your profile won&apos;t be saved.
            </p>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setCancelConfirm(false)}
                disabled={loggingOut}
                className="btn-ghost"
              >
                Keep going
              </button>
              <button
                type="button"
                onClick={async () => {
                  setLoggingOut(true);
                  try {
                    await logout();
                    router.replace("/login");
                  } catch {
                    setLoggingOut(false);
                  }
                }}
                disabled={loggingOut}
                className="btn bg-no text-white hover:bg-no/90"
              >
                {loggingOut ? <Spinner size={16} /> : "Log out"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
