// Custom entry point.
//
// Polyfills (crypto.getRandomValues, TextEncoder, ethers shims) MUST be
// installed before ANY route module is evaluated. expo-router loads all routes
// through a require.context, so a polyfill import inside app/_layout.tsx is not
// guaranteed to run first — a sibling route (e.g. (tabs)/_layout → session →
// auth → Privy) can be evaluated before the root layout, and Privy touches
// global.crypto at import time ("Property 'crypto' doesn't exist"). Importing
// the polyfills here, before expo-router/entry, guarantees correct ordering.
import "./lib/polyfills";
import "expo-router/entry";
