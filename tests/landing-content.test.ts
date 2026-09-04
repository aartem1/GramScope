import { describe, expect, it } from "vitest";
import {
  GITHUB_URL,
  OPERATIONS_URL,
  deploymentSteps,
  requestPath,
  trustBoundaries,
  workflows,
} from "../app/_components/landing/content";

describe("landing content", () => {
  it("links to the public source and authoritative runbook", () => {
    expect(GITHUB_URL).toBe("https://github.com/aartem1/GramScope");
    expect(OPERATIONS_URL).toBe(
      "https://github.com/aartem1/GramScope/blob/main/docs/operations.md",
    );
  });

  it("presents the approved request path in order", () => {
    expect(requestPath.map(({ id }) => id)).toEqual([
      "client",
      "vercel",
      "boundary",
      "worker",
      "telegram",
    ]);
  });

  it("offers exactly the five implemented workflows", () => {
    expect(workflows.map(({ id }) => id)).toEqual([
      "catch-up",
      "research",
      "discover",
      "organize",
      "media",
    ]);
    expect(workflows.every(({ prompt, outcome }) => prompt && outcome)).toBe(
      true,
    );
  });

  it("keeps unique fact copy in one data location", () => {
    const claims = [
      ...requestPath.map(({ detail }) => detail),
      ...trustBoundaries.map(({ body }) => body),
      ...deploymentSteps.map(({ body }) => body),
    ];
    expect(new Set(claims).size).toBe(claims.length);
  });
});
