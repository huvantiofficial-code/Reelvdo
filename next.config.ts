import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No `output: "standalone"` — Vercel uses its own optimized Next.js output.
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    // Lint is run separately in CI; don't block Vercel builds on lint warnings.
    ignoreDuringBuilds: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
