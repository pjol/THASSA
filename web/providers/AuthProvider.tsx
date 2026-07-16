"use client";

// Thin auth wrapper around Privy (spec §7): the rest of the app only touches
// useAuth()/useAuthToken()/useWalletSigner(), so swapping Privy for Signet
// later means reimplementing this one file.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PrivyProvider,
  usePrivy,
  useWallets,
  getAccessToken,
} from "@privy-io/react-auth";
import { createWalletClient, custom, type Address, type Hex } from "viem";
import { PRIVY_APP_ID } from "@/lib/config";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // PrivyProvider validates its app id at render time and cannot run during
  // SSR/prerender, so the whole authed tree mounts client-side only. The
  // server renders the empty shell below (identical on the client's first
  // paint, so hydration stays clean).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) {
    return <div className="min-h-screen bg-bg" aria-busy="true" />;
  }
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ["email", "sms", "google", "apple"],
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" },
        },
        appearance: {
          theme: "light",
          accentColor: "#307CDE",
          logo: "/thassa-logo.svg",
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}

export interface AuthState {
  ready: boolean;
  authenticated: boolean;
  login: () => void;
  logout: () => Promise<void>;
  walletAddress: Address | null;
}

export function useAuth(): AuthState {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const embedded =
    wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
  return {
    ready,
    authenticated,
    login,
    logout,
    walletAddress: (embedded?.address as Address) ?? null,
  };
}

// Access-token getter for the Api class. Stable identity.
export function useAuthToken(): () => Promise<string | null> {
  return useCallback(() => getAccessToken(), []);
}

export interface TypedDataPayload {
  domain: any;
  types: any;
  primaryType: string;
  message: Record<string, any>;
}

export interface WalletSigner {
  address: Address | null;
  signTypedData: (payload: TypedDataPayload) => Promise<Hex>;
}

// EIP-712 signing through the Privy embedded wallet via viem.
export function useWalletSigner(): WalletSigner {
  const { wallets } = useWallets();
  const embedded =
    wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];

  return useMemo(
    () => ({
      address: (embedded?.address as Address) ?? null,
      signTypedData: async (payload: TypedDataPayload) => {
        if (!embedded) throw new Error("no wallet connected");
        const provider = await embedded.getEthereumProvider();
        const client = createWalletClient({
          account: embedded.address as Address,
          transport: custom(provider),
        });
        return client.signTypedData({
          account: embedded.address as Address,
          domain: payload.domain,
          types: payload.types,
          primaryType: payload.primaryType,
          message: payload.message,
        } as any);
      },
    }),
    [embedded],
  );
}
