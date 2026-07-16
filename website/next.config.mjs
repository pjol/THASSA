/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export — deploy the `out/` directory to any static host.
  output: "export",
  images: { unoptimized: true },
  trailingSlash: false,
};

export default nextConfig;
