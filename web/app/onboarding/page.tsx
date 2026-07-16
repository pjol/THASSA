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
import { CameraIcon, Spinner } from "@/components/icons";

export default function OnboardingPage() {
  const { ready, authenticated } = useAuth();
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
        <Spinner className="text-muted" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4 py-10">
      <form onSubmit={submit} className="card w-full max-w-md p-7 shadow-soft">
        <div className="mb-6 flex items-center gap-3">
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
          Links <span className="font-normal normal-case">(comma or newline separated)</span>
        </label>
        <textarea
          className="input mb-6 resize-none"
          rows={2}
          value={links}
          onChange={(e) => setLinks(e.target.value)}
          placeholder="https://…"
        />

        <button type="submit" disabled={saving || uploading} className="btn-brand w-full !py-3">
          {saving ? <Spinner size={16} /> : "Enter Thassa"}
        </button>
      </form>
    </div>
  );
}
