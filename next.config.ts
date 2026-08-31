import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["ffmpeg-static", "sharp"],
  outputFileTracingIncludes: {
    "/api/mcp": ["./node_modules/ffmpeg-static/ffmpeg"],
  },
};

export default nextConfig;
