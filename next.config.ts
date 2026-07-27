import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No `output: "standalone"` — Vercel uses its own optimized Next.js output.
  // (Next.js 16 removed the `eslint` config key; lint runs via `bun run lint`.)
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
