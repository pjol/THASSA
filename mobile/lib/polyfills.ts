// Polyfills required by Privy's embedded wallets + viem in React Native.
// Installed from index.js BEFORE expo-router loads any route module, so
// global.crypto exists by the time Privy is imported.
import "fast-text-encoding";
import "react-native-get-random-values";
import "@ethersproject/shims";
import * as ExpoCrypto from "expo-crypto";

// Belt-and-suspenders. react-native-get-random-values defines
// global.crypto.getRandomValues; some Privy/viem paths also reach for
// crypto.randomUUID, which it does not provide.
const g = globalThis as unknown as {
  crypto?: { randomUUID?: () => string };
};
if (g.crypto && typeof g.crypto.randomUUID !== "function") {
  g.crypto.randomUUID = () => ExpoCrypto.randomUUID();
}
