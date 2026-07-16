/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    // Media is served from the backend's S3/MinIO via presigned or public
    // URLs whose hosts vary by environment; use plain <img> so we skip the
    // Next image-optimizer host allowlist entirely.
    unoptimized: true,
  },
};

export default nextConfig;
