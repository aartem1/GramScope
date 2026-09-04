import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("landing isolation", () => {
  it("does not depend on runtime secrets or production modules", () => {
    const paths = [
      "app/page.tsx",
      "app/layout.tsx",
      "app/opengraph-image.tsx",
      "app/_components/landing/content.ts",
      "app/_components/landing/brand-mark.tsx",
      "app/_components/landing/header.tsx",
      "app/_components/landing/hero.tsx",
      "app/_components/landing/request-path.tsx",
      "app/_components/landing/workflow-explorer.tsx",
      "app/_components/landing/trust-boundaries.tsx",
      "app/_components/landing/deployment-guide.tsx",
      "app/_components/landing/footer.tsx",
    ];
    const source = paths.map((path) => readFileSync(path, "utf8")).join("\n");
    for (const forbidden of [
      "process.env",
      "fetch(",
      "/api/mcp",
      "@/mcp",
      "@/ops",
      "@/media",
      "@/telegram",
      "@/worker",
      "src/mcp",
      "src/ops",
      "src/media",
      "src/telegram",
      "src/worker",
      "TELEGRAM_SESSION",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
