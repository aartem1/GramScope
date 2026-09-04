import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "GramScope — Your Telegram inside your AI",
  description:
    "A self-hosted MCP bridge for reading, researching, and organizing Telegram with compatible AI clients.",
  openGraph: {
    title: "GramScope — Your Telegram inside your AI",
    description:
      "A private MCP bridge. The Telegram session stays on your VPS.",
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
