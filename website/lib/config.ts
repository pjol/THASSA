// Build-time public configuration for the static site.
// Every value is env-configurable; defaults match the dev environment.

export const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL || "https://app.thassa.xyz";

/** Backend base URL used in every docs example. Dev backend: localhost:8080. */
export const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

export const WS_URL = API_URL.replace(/^http/, "ws");

export const APPSTORE_URL = process.env.NEXT_PUBLIC_APPSTORE_URL || "";
export const PLAYSTORE_URL = process.env.NEXT_PUBLIC_PLAYSTORE_URL || "";

export const SITE_NAME = "Thassa";
export const SITE_TAGLINE = "Social. Markets. Settled.";
export const SITE_DESCRIPTION =
  "Thassa is a social platform where any post can carry a prediction market — YES/NO shares priced in cents, one-signature trading with no gas fees, and every market settled in the open against publicly named sources.";
