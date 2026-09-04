import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "GramScope — Your Telegram inside your AI",
  description:
    "A self-hosted MCP bridge for reading Telegram channels, posts, and news with compatible AI clients — not a messaging bot.",
  openGraph: {
    title: "GramScope — Your Telegram inside your AI",
    description:
      "Read channels and posts through your AI. The Telegram session stays on your VPS.",
    type: "website",
  },
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
