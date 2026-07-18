import React, { createContext, useCallback, useContext, useMemo, useRef } from "react";
import {
  PrivyProvider,
  usePrivy,
  useEmbeddedEthereumWallet,
  type ConnectedEthereumWallet,
} from "@privy-io/expo";
import { runBeforeLogout } from "./push";

// Thin auth abstraction over Privy (spec §6.1/§7): the rest of the app talks to
// useAuth()/useWallet() only, so Privy can be swapped for Signet later by
// reimplementing this one module. Privy persists tokens via expo-secure-store
// (its default storage adapter).

const PRIVY_APP_ID = process.env.EXPO_PUBLIC_PRIVY_APP_ID || "";
const PRIVY_CLIENT_ID = process.env.EXPO_PUBLIC_PRIVY_CLIENT_ID || undefined;

export interface AuthState {
  // Whether the auth SDK has initialized.
  isReady: boolean;
  isSignedIn: boolean;
  userId: string | null;
  email: string | null;
  // Wallet address of the user's embedded wallet, when it exists.
  walletAddress: string | null;
  getAccessToken: () => Promise<string | null>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  return (
    <PrivyProvider appId={PRIVY_APP_ID} clientId={PRIVY_CLIENT_ID}>
      <AuthBridge>{children}</AuthBridge>
    </PrivyProvider>
  );
}

function AuthBridge({ children }: { children: React.ReactNode }) {
  const { user, isReady, logout, getAccessToken } = usePrivy();
  const { wallets } = useEmbeddedEthereumWallet();

  const email = useMemo(() => {
    const acct = user?.linked_accounts?.find((a: { type: string }) => a.type === "email") as
      | { address?: string }
      | undefined;
    return acct?.address ?? null;
  }, [user]);

  // Run pre-logout hooks (push-token cleanup) while the auth token is still
  // valid, then clear the Privy session.
  const wrappedLogout = useCallback(async () => {
    await runBeforeLogout();
    await logout();
  }, [logout]);

  const value = useMemo<AuthState>(
    () => ({
      isReady,
      isSignedIn: !!user,
      userId: user?.id ?? null,
      email,
      walletAddress: wallets[0]?.address ?? null,
      getAccessToken,
      logout: wrappedLogout,
    }),
    [isReady, user, email, wallets, getAccessToken, wrappedLogout]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

// An EIP-1193-ish provider for the embedded wallet (signTypedData etc).
export interface WalletProvider {
  request: (args: { method: string; params?: unknown[] }) => Promise<any>;
}

export interface WalletHandle {
  address: string;
  provider: WalletProvider;
}

// Access to the embedded Ethereum wallet, creating it on first use. Signing
// flows call ensureWallet() right before building typed data.
export function useWallet(): {
  address: string | null;
  ensureWallet: () => Promise<WalletHandle>;
} {
  const { wallets, create } = useEmbeddedEthereumWallet();
  const walletsRef = useRef<ConnectedEthereumWallet[]>(wallets);
  walletsRef.current = wallets;

  const ensureWallet = useCallback(async (): Promise<WalletHandle> => {
    let w = walletsRef.current[0];
    if (!w) {
      await create();
      // The hook's wallet list refreshes asynchronously after create().
      for (let i = 0; i < 20 && !walletsRef.current[0]; i++) {
        await new Promise((r) => setTimeout(r, 250));
      }
      w = walletsRef.current[0];
      if (!w) throw new Error("wallet creation did not complete");
    }
    const provider = await w.getProvider();
    return { address: w.address, provider: provider as unknown as WalletProvider };
  }, [create]);

  return { address: wallets[0]?.address ?? null, ensureWallet };
}
