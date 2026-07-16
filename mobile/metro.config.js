// Metro config (standard Expo default + the resolver tweak Privy's Expo SDK
// requires): resolve package `exports` with the browser condition first so
// dependencies like `jose` pick their browser builds instead of Node builds
// that import node core modules (util/zlib).
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

config.resolver.unstable_enablePackageExports = true;
// react-native first (keeps RN/Expo internals on their native builds), then
// browser so isomorphic packages prefer their browser bundles over node ones.
config.resolver.unstable_conditionNames = ["react-native", "browser", "require"];

module.exports = config;
