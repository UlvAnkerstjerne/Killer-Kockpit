import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Paid Strategy reads the vendored MESPER skill files at runtime (lib/ai/skills/mesper.ts).
  outputFileTracingIncludes: {
    '/marketing/brain': ['./lib/ai/skills/mesper-meta-ads/**/*'],
  },
};

export default nextConfig;
