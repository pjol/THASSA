// Polyfills required by Privy's embedded wallets + viem in React Native.
// MUST be the first import of the app (see app/_layout.tsx).
import "fast-text-encoding";
import "react-native-get-random-values";
import "@ethersproject/shims";
