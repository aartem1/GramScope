import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["ffmpeg-static", "sharp"],
  outputFileTracingIncludes: {
    "/api/media/view/\\[token\\]": [
      "./node_modules/ffmpeg-static/ffmpeg",
      "./src/media/contact-sheet-worker.mjs",
    ],
  },
};

export default nextConfig;
