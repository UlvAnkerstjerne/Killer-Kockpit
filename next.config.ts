import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Paid Strategy and Organic Strategy read their vendored skill files at runtime
  // (lib/ai/skills/mesper.ts, lib/ai/skills/claude-ig.ts).
  outputFileTracingIncludes: {
    '/marketing/brain': ['./lib/ai/skills/mesper-meta-ads/**/*', './lib/ai/skills/claude-ig/**/*'],
  },
};

export default nextConfig;
