# GramScope Public Landing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an English-only, interactive GramScope landing page at `/`, prepare the repository for public MIT release, and preserve the production MCP contract and single Telegram session without interruption.

**Architecture:** Add one statically rendered App Router page and small landing-specific React/CSS components to the existing Vercel application. Keep every `/api/...` route and all MCP, OAuth, media, worker, and Telegram modules untouched; publish only after local gates, secret/history review, production health checks, and acceptance through the already-connected ChatGPT and Grok Bot clients.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript 5.6, hand-written CSS, inline SVG, Vitest, existing GramScope operations CLI, Gitleaks 8.30.1.

**Spec:** `docs/superpowers/specs/2026-09-04-public-landing-design.md`

## Global Constraints

- Work directly on `main`, as explicitly approved by the owner; do not push until every local acceptance gate passes.
- Keep `/api/mcp`, OAuth metadata, media routes, worker RPC, mTLS, and Telegram code unchanged.
- Keep `tests/fixtures/tools-list.json` byte-identical; if its test fails, restore the implementation rather than updating the fixture.
- Never start a local Telegram client or second worker against the production session.
- Never read, print, copy, or commit Telegram, OAuth, worker, media, or TLS secrets.
- The root page is static, reads no environment variable, and calls no application endpoint.
- Use no new runtime UI, animation, analytics, CMS, database, or AI dependency.
- Reader-facing copy is English and states each fact once.
- ChatGPT and Grok Bot are tested examples, not an exhaustive compatibility list.
- No horizontal page or component scrolling at standard widths from 320 CSS pixels upward.
- Motion respects `prefers-reduced-motion`; required content and navigation work without JavaScript.
- Visual-companion files under `.superpowers/brainstorm/` remain local and uncommitted.
- Tasks 1–6 end with verified local checkpoints but no commit. This follows the approved one-candidate release sequence; Task 7 creates the single implementation commit after every local gate passes.

---

## File map

### New presentation files

- `app/layout.tsx` — root document, global metadata, and global stylesheet import.
- `app/page.tsx` — server-rendered landing composition only.
- `app/globals.css` — global reset, design tokens, layout, responsive rules, motion, and focus states.
- `app/_components/landing/content.ts` — typed, English source of truth for links, workflows, trust facts, deployment steps, and request-path labels.
- `app/_components/landing/brand-mark.tsx` — accessible geometric GramScope mark.
- `app/_components/landing/header.tsx` — compact navigation and GitHub action.
- `app/_components/landing/hero.tsx` — primary message and architecture composition.
- `app/_components/landing/request-path.tsx` — semantic request-path diagram.
- `app/_components/landing/workflow-explorer.tsx` — the only client component; switches workflow examples.
- `app/_components/landing/trust-boundaries.tsx` — the three non-duplicated trust facts.
- `app/_components/landing/deployment-guide.tsx` — concise prerequisites and four-step deployment path.
- `app/_components/landing/footer.tsx` — final repository/documentation action.
- `app/opengraph-image.tsx` — local, generated social preview with no private data.

### New tests

- `tests/landing-content.test.ts` — copy/link integrity, workflow IDs, and single-location assertions.
- `tests/landing-page.test.tsx` — server-rendered HTML, semantic navigation, default no-JavaScript content, and explicit actions.
- `tests/landing-isolation.test.ts` — root page has no environment, MCP, worker, media, or Telegram dependency.

### Development metadata

- `package.json` and `package-lock.json` — add only the React 19 server-rendering type package used by the landing test; no runtime dependency changes.

### Public-release files

- `LICENSE` — MIT License, copyright 2026 Artem Altukhov.
- `SECURITY.md` — private vulnerability reporting and credential-safety rules.
- `.gitignore` — excludes `.superpowers/brainstorm/` while retaining existing secret/build ignores.
- `README.md` — public, self-hosted positioning and MIT license link.
- Six existing historical/test files listed in Task 6 — English translation and neutral Unicode fixtures only.

No file under `app/api/`, `src/mcp/`, `src/ops/`, `src/media/`, `src/telegram/`, `src/worker/`, or `worker/` is modified.

---

### Task 1: Establish the protected baseline and typed landing content

**Files:**
- Create: `app/_components/landing/content.ts`
- Create: `tests/landing-content.test.ts`
- Read only: `docs/operations.md`
- Read only: `tests/fixtures/tools-list.json`

**Interfaces:**
- Consumes: the approved copy boundaries in `docs/superpowers/specs/2026-09-04-public-landing-design.md`.
- Produces: `GITHUB_URL`, `OPERATIONS_URL`, `requestPath`, `workflows`, `trustBoundaries`, and `deploymentSteps`; later components import these exact names.

- [ ] **Step 1: Confirm production is healthy without opening Telegram locally**

Run:

```bash
./scripts/gramscope doctor --json
```

Expected: exit 0 and a healthy existing Vercel/worker topology. Inspect the result locally; do not paste raw output into notes or chat. If it is unhealthy, stop before editing and diagnose only through `./scripts/gramscope`.

- [ ] **Step 2: Record the immutable MCP fixture checksum outside application code**

Run:

```bash
shasum -a 256 tests/fixtures/tools-list.json
```

Expected: one checksum for later comparison. Keep only the checksum, never edit the fixture.

- [ ] **Step 3: Write the failing content-contract test**

Create `tests/landing-content.test.ts`:

```ts
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
```

- [ ] **Step 4: Run the focused test and verify the import fails**

Run:

```bash
npx vitest run tests/landing-content.test.ts
```

Expected: FAIL because `app/_components/landing/content.ts` does not exist.

- [ ] **Step 5: Implement the typed content model**

Create `app/_components/landing/content.ts` with these exported shapes and IDs:

```ts
export const GITHUB_URL = "https://github.com/aartem1/GramScope";
export const OPERATIONS_URL = `${GITHUB_URL}/blob/main/docs/operations.md`;

export type RequestNode = {
  id: "client" | "vercel" | "boundary" | "worker" | "telegram";
  index: string;
  title: string;
  detail: string;
  tone: "cyan" | "violet" | "mint";
};

export type Workflow = {
  id: "catch-up" | "research" | "discover" | "organize" | "media";
  label: string;
  title: string;
  prompt: string;
  outcome: string;
  tools: readonly string[];
};

export type Fact = { title: string; body: string };
export type DeploymentStep = Fact & { index: string };

export const requestPath = [
  {
    id: "client",
    index: "01",
    title: "Any compatible AI client",
    detail: "Tested with ChatGPT and Grok Bot.",
    tone: "cyan",
  },
  {
    id: "vercel",
    index: "02",
    title: "Vercel app",
    detail: "OAuth, MCP schemas, and short-lived media links.",
    tone: "violet",
  },
  {
    id: "boundary",
    index: "",
    title: "Private boundary",
    detail: "Mutual TLS carries bounded operations to your server.",
    tone: "mint",
  },
  {
    id: "worker",
    index: "03",
    title: "Your VPS worker",
    detail: "The only process that holds the Telegram session.",
    tone: "mint",
  },
  {
    id: "telegram",
    index: "04",
    title: "Telegram",
    detail:
      "Messages, folders, memberships, and read state remain the source of truth.",
    tone: "cyan",
  },
] as const satisfies readonly RequestNode[];

export const workflows = [
  {
    id: "catch-up",
    label: "Catch up",
    title: "Turn unread channels into a focused briefing.",
    prompt:
      "Catch me up on unread posts from my Research folder. Prioritize recurring themes and link every conclusion to its source.",
    outcome: "A bounded summary built from your current Telegram read state.",
    tools: ["get_unread_summary", "get_messages"],
  },
  {
    id: "research",
    label: "Research",
    title: "Search across the sources you already trust.",
    prompt:
      "Find recent discussions of local AI models across my joined channels and compare the strongest claims.",
    outcome: "Search results with enough surrounding context to verify the synthesis.",
    tools: ["search_messages", "get_messages"],
  },
  {
    id: "discover",
    label: "Discover",
    title: "Find useful public sources without leaving the conversation.",
    prompt:
      "Find public channels about practical home automation, then show related sources for the two most relevant results.",
    outcome: "Telegram-native discovery results that you choose whether to join.",
    tools: ["search_channels", "get_similar_channels"],
  },
  {
    id: "organize",
    label: "Organize",
    title: "Keep Telegram folders aligned with how you work.",
    prompt:
      "Show my folders, then move the sources I approve into a new Robotics folder.",
    outcome: "Explicit, bounded folder changes after you select the sources.",
    tools: ["list_folders", "manage_folder"],
  },
  {
    id: "media",
    label: "Media",
    title: "Inspect media attached to a message on demand.",
    prompt:
      "Open the image attached to the selected post so we can discuss the chart it contains.",
    outcome: "One bounded representation or short-lived link for the chosen message.",
    tools: ["get_media"],
  },
] as const satisfies readonly Workflow[];

export const trustBoundaries = [
  {
    title: "Owner-scoped OAuth",
    body: "Tokens must match the configured issuer, audience, and owner identity.",
  },
  {
    title: "Bounded operations",
    body: "The worker accepts a fixed domain operation set rather than raw Telegram requests.",
  },
  {
    title: "Untrusted source content",
    body: "Telegram content is treated as material to analyze, never as instruction or verified evidence.",
  },
] as const satisfies readonly Fact[];

export const deploymentSteps = [
  {
    index: "01",
    title: "Prepare",
    body: "Bring a dedicated Telegram account, API credentials, Node.js 20+, a Debian or Ubuntu VPS, Vercel, and WorkOS AuthKit.",
  },
  {
    index: "02",
    title: "Clone",
    body: "Clone GramScope and configure the gramscope-worker SSH alias used by its operations CLI.",
  },
  {
    index: "03",
    title: "Install",
    body: "Use ./scripts/gramscope for setup and complete the interactive Telegram login on the VPS.",
  },
  {
    index: "04",
    title: "Connect",
    body: "Point a compatible AI client at your deployed /api/mcp endpoint and authorize with OAuth.",
  },
] as const satisfies readonly DeploymentStep[];
```

- [ ] **Step 6: Run the content-contract test**

Run:

```bash
npx vitest run tests/landing-content.test.ts
```

Expected: PASS with 4 tests.

- [ ] **Step 7: Checkpoint without committing**

Run:

```bash
git diff --check
git status --short
```

Expected: only the two Task 1 files plus the already-local visual-companion directory are new; no protected production file is changed.

---

### Task 2: Build the static shell, hero, and request-path visual

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `app/layout.tsx`
- Create: `app/page.tsx`
- Create: `app/globals.css`
- Create: `app/_components/landing/brand-mark.tsx`
- Create: `app/_components/landing/header.tsx`
- Create: `app/_components/landing/hero.tsx`
- Create: `app/_components/landing/request-path.tsx`
- Create: `tests/landing-page.test.tsx`

**Interfaces:**
- Consumes: `GITHUB_URL` and `requestPath` from Task 1.
- Produces: `BrandMark`, `Header`, `Hero`, and `RequestPath`; `app/page.tsx` renders them as server components.

- [ ] **Step 1: Write the failing server-render test**

Install the type-only test dependency:

```bash
npm install --save-dev @types/react-dom@^19.0.0
```

Expected: only `package.json` and `package-lock.json` change; `dependencies` remains unchanged.

Create `tests/landing-page.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import HomePage from "../app/page";

describe("landing page", () => {
  it("renders the product promise, explicit actions, and request path", () => {
    const html = renderToStaticMarkup(<HomePage />);
    expect(html).toContain("Your Telegram. Inside your AI.");
    expect(html).toContain("View on GitHub");
    expect(html).toContain("Deployment guide");
    expect(html).toContain("Any compatible AI client");
    expect(html).toContain("Your VPS worker");
    expect(html).toContain("href=\"#deploy\"");
    expect(html).toContain(
      "href=\"https://github.com/aartem1/GramScope\"",
    );
  });
});
```

- [ ] **Step 2: Run the test and verify the page import fails**

Run:

```bash
npx vitest run tests/landing-page.test.tsx
```

Expected: FAIL because `app/page.tsx` does not exist.

- [ ] **Step 3: Add the root layout and metadata**

Create `app/layout.tsx` with `Metadata`, import `./globals.css`, set `lang="en"`, and use this metadata copy:

```ts
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
```

Do not add `metadataBase`, analytics, scripts, an authentication wrapper, or an environment lookup.

- [ ] **Step 4: Implement the static header and hero components**

Implement semantic server components with these boundaries:

- `BrandMark` returns an inline SVG with `aria-hidden="true"` when adjacent text names GramScope.
- `Header` contains a home link, section links to `#workflows` and `#deploy`, and an external `View on GitHub` anchor.
- `Hero` owns the only `h1`, the approved lead paragraph, the two explicit actions, and `RequestPath`.
- `RequestPath` renders an ordered list from `requestPath`; the mTLS node is part of the linear path, not a floating orbit.
- External links use `target="_blank"` and `rel="noreferrer"`.

Create `app/page.tsx` as a server component that currently renders `<Header />`, `<main><Hero /></main>`, and a temporary empty `<div id="deploy" />` anchor. Do not add `"use client"`.

- [ ] **Step 5: Establish the Prismatic Relay CSS foundation**

Create `app/globals.css` with:

```css
:root {
  color-scheme: dark;
  --bg: #070814;
  --panel: rgba(15, 18, 38, 0.72);
  --line: rgba(180, 198, 255, 0.16);
  --text: #f5f7ff;
  --muted: #a9b0c7;
  --cyan: #66e6ff;
  --mint: #70f6b2;
  --violet: #a88bff;
  --page: min(1180px, calc(100vw - 2 * clamp(18px, 4vw, 56px)));
}

* { box-sizing: border-box; }
html { scroll-behavior: smooth; overflow-x: clip; }
body { margin: 0; min-width: 0; background: var(--bg); color: var(--text); }
button, a { font: inherit; }
a { color: inherit; }
:focus-visible { outline: 2px solid var(--cyan); outline-offset: 4px; }
```

Add fluid typography with bounded `clamp()`, a centered `--page` container, glass panels, a clipped/background glow, and the semantic request-path connectors. Every grid child gets `min-width: 0`. Do not use `width: 100vw` inside the page.

- [ ] **Step 6: Run the focused tests and production build**

Run:

```bash
npx vitest run tests/landing-content.test.ts tests/landing-page.test.tsx
npm run typecheck
npm run build
```

Expected: all tests pass; typecheck passes; Next build lists `/` and retains every pre-existing `/api/...` route.

- [ ] **Step 7: Checkpoint without committing**

Run:

```bash
git diff --check
git diff --name-only | rg '^(app/api|src/(mcp|ops|media|telegram|worker)/|worker/)'
```

Expected: `git diff --check` exits 0; the protected-path search prints nothing.

---

### Task 3: Add the interactive workflow explorer with a static fallback

**Files:**
- Create: `app/_components/landing/workflow-explorer.tsx`
- Modify: `app/page.tsx`
- Modify: `app/globals.css`
- Modify: `tests/landing-page.test.tsx`

**Interfaces:**
- Consumes: `Workflow` and `workflows` from Task 1.
- Produces: `WorkflowExplorer`, a client island whose initial render contains the complete first workflow and whose controls use workflow IDs as stable keys.

- [ ] **Step 1: Extend the render test with the no-JavaScript baseline**

Add this test to `tests/landing-page.test.tsx`:

```tsx
it("server-renders a useful default workflow and all workflow controls", () => {
  const html = renderToStaticMarkup(<HomePage />);
  expect(html).toContain("id=\"workflows\"");
  expect(html).toContain("Catch up");
  expect(html).toContain("Research");
  expect(html).toContain("Discover");
  expect(html).toContain("Organize");
  expect(html).toContain("Media");
  expect(html).toContain("get_unread_summary");
  expect(html).toContain("role=\"tablist\"");
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npx vitest run tests/landing-page.test.tsx
```

Expected: FAIL because the workflow section is absent.

- [ ] **Step 3: Implement the isolated client component**

Create `workflow-explorer.tsx` beginning with `"use client"`. Use `useState<Workflow["id"]>("catch-up")`, derive the active item with `workflows.find(({ id }) => id === activeId) ?? workflows[0]!`, and render:

- an English section heading and one short introductory sentence;
- a `role="tablist"` containing native buttons;
- each button with `role="tab"`, `aria-selected`, and `aria-controls="workflow-panel"`;
- a `role="tabpanel"`, `id="workflow-panel"`, and `aria-live="polite"` canvas;
- the active prompt, outcome, and tool-name chips; and
- a `<noscript>` sentence explaining that the first example is shown when interaction is unavailable.

Use no effect, timer, fetch, browser storage, animation library, or endpoint call.

- [ ] **Step 4: Compose the section and style intrinsic states**

Render `<WorkflowExplorer />` after `<Hero />` in `app/page.tsx`. In `app/globals.css`, use an auto-fit selector grid and a container-aware two-column layout that collapses when the section itself becomes narrow. Buttons must remain at least 44 CSS pixels tall, wrap their labels, and show selected state without relying on color alone.

- [ ] **Step 5: Run focused tests and static checks**

Run:

```bash
npx vitest run tests/landing-content.test.ts tests/landing-page.test.tsx
npm run typecheck
npm run lint
```

Expected: all commands pass.

- [ ] **Step 6: Checkpoint without committing**

Run:

```bash
git diff --check
git diff --name-only | rg '^(app/api|src/(mcp|ops|media|telegram|worker)/|worker/)'
```

Expected: no protected path is printed.

---

### Task 4: Complete trust, deployment, final actions, and social metadata

**Files:**
- Create: `app/_components/landing/trust-boundaries.tsx`
- Create: `app/_components/landing/deployment-guide.tsx`
- Create: `app/_components/landing/footer.tsx`
- Create: `app/opengraph-image.tsx`
- Modify: `app/page.tsx`
- Modify: `app/globals.css`
- Modify: `tests/landing-page.test.tsx`

**Interfaces:**
- Consumes: `GITHUB_URL`, `OPERATIONS_URL`, `trustBoundaries`, and `deploymentSteps` from Task 1.
- Produces: the remaining server-rendered sections and a local Open Graph image endpoint.

- [ ] **Step 1: Extend the server-render test for the complete information architecture**

Add:

```tsx
it("renders each remaining fact and destination once", () => {
  const html = renderToStaticMarkup(<HomePage />);
  expect(html).toContain("Owner-scoped OAuth");
  expect(html).toContain("Bounded operations");
  expect(html).toContain("Untrusted source content");
  expect(html).toContain("id=\"deploy\"");
  expect(html).toContain("Prepare");
  expect(html).toContain("Clone");
  expect(html).toContain("Install");
  expect(html).toContain("Connect");
  expect(html).toContain(
    "href=\"https://github.com/aartem1/GramScope/blob/main/docs/operations.md\"",
  );
  expect(html.match(/The only process that holds the Telegram session\./g)).toHaveLength(1);
});
```

- [ ] **Step 2: Run the test and verify the missing sections fail**

Run:

```bash
npx vitest run tests/landing-page.test.tsx
```

Expected: FAIL on the trust and deployment assertions.

- [ ] **Step 3: Implement the three server components**

Implement:

- `TrustBoundaries` as a semantic section mapping `trustBoundaries` into three concise cards;
- `DeploymentGuide` as `<section id="deploy">` with prerequisites, an ordered list from `deploymentSteps`, and one `Read the operations guide` anchor to `OPERATIONS_URL`; and
- `Footer` as a compact final panel with one `View the source on GitHub` anchor and a copyright line.

Do not repeat the hero title, session-placement sentence, workflow list, or setup steps in the final panel.

- [ ] **Step 4: Create the local social preview**

Create `app/opengraph-image.tsx` using `ImageResponse` from `next/og`, with:

```ts
export const alt = "GramScope — Your Telegram inside your AI";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
```

Render only the GramScope mark, product name, hero line, and a linear five-node relay motif. Use system fonts and inline colors; do not fetch fonts, images, user data, or environment values.

- [ ] **Step 5: Compose and style the complete page**

In `app/page.tsx`, render sections in this order: `Hero`, `WorkflowExplorer`, `TrustBoundaries`, `DeploymentGuide`. Render `Footer` after `main`. Add section spacing, semantic divider treatments, deployment timeline styles, and the restrained final panel to `globals.css`.

- [ ] **Step 6: Run focused tests and build**

Run:

```bash
npx vitest run tests/landing-content.test.ts tests/landing-page.test.tsx
npm run typecheck
npm run lint
npm run build
```

Expected: all commands pass; the build includes `/`, `/opengraph-image`, and every existing API route.

- [ ] **Step 7: Checkpoint without committing**

Run:

```bash
git diff --check
git diff --name-only | rg '^(app/api|src/(mcp|ops|media|telegram|worker)/|worker/)'
```

Expected: no protected path is printed.

---

### Task 5: Lock isolation, accessibility, and responsive behavior

**Files:**
- Create: `tests/landing-isolation.test.ts`
- Modify: `app/globals.css`
- Modify: landing components only when a browser finding requires it

**Interfaces:**
- Consumes: the complete page from Tasks 2–4.
- Produces: a source-level isolation gate and browser-verified responsive/accessibility behavior.

- [ ] **Step 1: Write the landing isolation test**

Create `tests/landing-isolation.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("landing isolation", () => {
  it("does not depend on runtime secrets or production modules", () => {
    const paths = [
      "app/page.tsx",
      "app/layout.tsx",
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
```

- [ ] **Step 2: Run the isolation test**

Run:

```bash
npx vitest run tests/landing-isolation.test.ts
```

Expected: PASS. If the test catches a forbidden dependency, remove that dependency from the landing code.

- [ ] **Step 3: Add reduced-motion and narrow-container rules**

Add exact behavior, not device-specific duplication:

```css
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

img, svg { max-width: 100%; }
pre, code { overflow-wrap: anywhere; }
```

Use container queries for the request path and workflow canvas. At narrow widths, connectors change orientation, text stays left-aligned, and no node has a fixed pixel width larger than its container.

- [ ] **Step 4: Start only the local Next.js presentation server**

Run:

```bash
test -z "${TELEGRAM_SESSION+x}"
npm run dev
```

Expected: the environment-presence check exits 0 without printing a value, then the root page becomes available locally. Do not invoke MCP or any Telegram operation from the local server.

- [ ] **Step 5: Run automated browser verification**

Use the `vercel:agent-browser-verify` skill against the local root page. Check 320×800, 360×800, 375×812, 390×844, 414×896, 768×1024, 1024×768, 1024×1024, 1440×900, and 844×390.

For every viewport, assert in the browser:

```js
document.documentElement.scrollWidth <= document.documentElement.clientWidth
```

Also assert that the header actions, hero actions, every workflow tab, and both final links have bounding rectangles fully inside the viewport. Exercise every workflow tab, keyboard traversal, visible focus, reduced-motion emulation, and JavaScript-disabled initial rendering.

- [ ] **Step 6: Fix browser findings at their source and repeat the matrix**

For an overflow, identify the exact element whose `scrollWidth > clientWidth` or whose bounding rectangle leaves the viewport. Fix that component with intrinsic sizing or clipped/background decoration; do not hide a real content overflow with a global scrollbar hack.

Expected: the complete matrix passes, with screenshots retained only in local verification output.

- [ ] **Step 7: Run the focused suite again**

Run:

```bash
npx vitest run tests/landing-content.test.ts tests/landing-page.test.tsx tests/landing-isolation.test.ts
npm run typecheck
npm run lint
```

Expected: all commands pass.

- [ ] **Step 8: Checkpoint without committing**

Run:

```bash
git diff --check
git diff --name-only | rg '^(app/api|src/(mcp|ops|media|telegram|worker)/|worker/)'
```

Expected: no protected path is printed.

---

### Task 6: Prepare English public documentation and repository metadata

**Files:**
- Create: `LICENSE`
- Create: `SECURITY.md`
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `tests/media-original-route.test.ts`
- Modify: `tests/telegram-discovery.test.ts`
- Modify: `docs/superpowers/plans/2026-08-27-gramscope-research.md`
- Modify: `docs/superpowers/plans/2026-08-28-gramscope-discovery.md`
- Modify: `docs/superpowers/specs/2026-08-28-gramscope-discovery-design.md`
- Modify: `docs/superpowers/specs/2026-08-29-gramscope-source-notes-design.md`

**Interfaces:**
- Consumes: current README/runbook behavior and the owner's decisions to use English, MIT, and retain the existing Git email.
- Produces: English public repository prose, neutral Unicode coverage, MIT licensing, and a private security-reporting route.

- [ ] **Step 1: Add the MIT license**

Create `LICENSE` from the standard MIT License text with:

```text
Copyright (c) 2026 Artem Altukhov
```

Do not alter the standard permission, warranty, or liability paragraphs.

- [ ] **Step 2: Add the security policy**

Create `SECURITY.md` with these sections and instructions:

```markdown
# Security Policy

## Reporting a vulnerability

Report vulnerabilities privately to artem.altuhov@gmail.com. Do not open a
public issue for a suspected vulnerability.

Never include Telegram session strings, Telegram API credentials, OAuth
tokens, worker bearer tokens, TLS private keys, media capability URLs, private
host addresses, or Telegram message content in a report. Describe the affected
component and a minimal reproduction with synthetic data.

## Supported version

Only the current `main` revision is supported.
```

- [ ] **Step 3: Update ignore rules and public README positioning**

Append `.superpowers/brainstorm/` to `.gitignore`. Retain every existing environment, session, Vercel, TLS, build, and dependency ignore.

Change the README opening from “private MCP server” to “self-hosted, single-owner MCP server”. Add an MIT license section linking to `LICENSE`. Keep setup commands, the one-session warning, and `docs/operations.md` authority unchanged.

- [ ] **Step 4: Translate the remaining reader-facing Russian text**

Replace the six files reported by this command:

```bash
rg -n '\p{Cyrillic}' --glob '!node_modules/**' --glob '!.git/**' .
```

Use “AI research 🔎” for the Unicode search-query fixtures and examples. Use `résumé-notes.txt` for the content-disposition Unicode filename test while retaining its quote and CRLF sanitization coverage. Translate the quoted historical owner statements into accurate English and mark them as translations where the surrounding record attributes exact wording.

- [ ] **Step 5: Prove the English audit is clean**

Run:

```bash
rg -n '\p{Cyrillic}' --glob '!node_modules/**' --glob '!.git/**' .
```

Expected: exit 1 with no output.

- [ ] **Step 6: Re-run affected and landing tests**

Run:

```bash
npx vitest run tests/media-original-route.test.ts tests/telegram-discovery.test.ts tests/landing-content.test.ts tests/landing-page.test.tsx tests/landing-isolation.test.ts
npm run typecheck
npm run lint
```

Expected: all commands pass. Unicode behavior remains covered by accented Latin text and emoji.

- [ ] **Step 7: Checkpoint without committing**

Run:

```bash
git diff --check
git status --short
```

Expected: only the planned presentation, test, documentation, license, security, and ignore files are changed; `.superpowers/brainstorm/` no longer appears.

---

### Task 7: Audit the complete candidate and create one local implementation commit

**Files:**
- Stage: every planned file from Tasks 1–6
- Read only: all reachable Git history
- Must remain unchanged: `tests/fixtures/tools-list.json` and all protected production paths

**Interfaces:**
- Consumes: the full uncommitted release candidate and baseline checksum from Task 1.
- Produces: one locally committed, fully gated candidate on `main`; nothing is pushed.

- [ ] **Step 1: Stage only the planned candidate**

Run `git add` with the explicit paths from the File map. Do not use `git add .` or `git add -A`.

Run:

```bash
git diff --cached --name-only
git diff --cached --check
```

Expected: the list contains only planned paths and the check exits 0.

- [ ] **Step 2: Prove protected implementation paths and the golden fixture are unchanged**

Run:

```bash
git diff --cached --name-only | rg '^(app/api|src/(mcp|ops|media|telegram|worker)/|worker/|tests/fixtures/tools-list\.json$)'
shasum -a 256 tests/fixtures/tools-list.json
```

Expected: the path search prints nothing; the checksum equals Task 1.

- [ ] **Step 3: Install or verify the official history scanner**

Run:

```bash
gitleaks version
```

Expected: Gitleaks 8.30.1. If unavailable, install the official Homebrew package with explicit approval, then verify the version. Do not use an unpinned third-party binary or upload repository contents to a scanning service. Gitleaks documents `git`, `dir`, and fully redacted output in its official repository: `https://github.com/gitleaks/gitleaks`.

- [ ] **Step 4: Scan every reachable commit and the staged candidate without exposing matches**

Run:

```bash
gitleaks git --redact --no-banner --log-opts="--all" .
git diff --cached --no-ext-diff | gitleaks stdin --redact --no-banner
```

Expected: both exit 0. If either reports a finding, keep output redacted, identify only its rule, commit, and path, and stop the release until the finding is proven synthetic or the credential is revoked and removed from all reachable history.

- [ ] **Step 5: Audit historical filenames and GramScope-specific secret assignments**

Run:

```bash
git log --all --name-only --format= | sort -u | rg -i '(^|/)(\.env($|\.)|.*session.*|.*private.*key.*|.*\.pem$|.*\.key$|.*\.crt$|.*\.p12$)'
git log --all -G '(TELEGRAM_SESSION|TELEGRAM_API_HASH|TELEGRAM_WORKER_TOKEN|MEDIA_TOKEN_SECRET|WORKOS_[A-Z_]*SECRET)[[:space:]]*=[[:space:]]*[^[:space:]]' --format='%H' --name-only
```

Expected: only known safe filenames such as `.env.example` or documented blank assignments. These commands print commit IDs and paths, not matching lines. Classify every result locally; any non-empty value or credential-bearing historical filename blocks release.

- [ ] **Step 6: Run every repository gate**

Run in this order:

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run build:worker
```

Expected: all five commands exit 0. The Next build contains `/`, `/opengraph-image`, and every existing API route. The worker build succeeds without any landing import.

- [ ] **Step 7: Re-run the golden contract test explicitly**

Run:

```bash
npx vitest run tests/mcp-handler.test.ts -t "matches the committed tools/list golden fixture"
```

Expected: PASS without changing `tests/fixtures/tools-list.json`.

- [ ] **Step 8: Review the staged diff as one release candidate**

Run:

```bash
git diff --cached --stat
git diff --cached --name-status
git status --short
```

Expected: no secret, local screenshot, `.vercel` state, visual-companion file, build output, or protected production path is staged.

- [ ] **Step 9: Create the local implementation commit**

Run:

```bash
git commit -m "feat: add public GramScope landing page"
```

Expected: one local commit on `main`. Do not push.

- [ ] **Step 10: Verify the committed tree is still clean and gated**

Run:

```bash
git status --short
npm test
npm run typecheck
npm run lint
npm run build
npm run build:worker
```

Expected: clean working tree and all gates pass from the exact committed state.

---

### Task 8: Deploy once, verify MCP continuity, then make GitHub public

**Files:**
- No source changes expected
- External state: GitHub `main`, Vercel production deployment, GitHub repository visibility

**Interfaces:**
- Consumes: the fully gated local commit from Task 7 and the existing logged-in GitHub/Vercel/VPS access described in `docs/operations.md`.
- Produces: a live landing page, unchanged working MCP integrations, and a public MIT-licensed GitHub repository.

- [ ] **Step 1: Perform the final pre-push health and divergence checks**

Run:

```bash
./scripts/gramscope doctor --json
git status --short
git log --oneline origin/main..main
```

Expected: production healthy, working tree clean, and only the approved design/documentation commit plus the implementation commit are ahead of `origin/main`.

- [ ] **Step 2: Push `main` once**

Run:

```bash
git push origin main
```

Expected: push succeeds and triggers the existing Vercel production integration. Do not run a raw `vercel deploy` command.

- [ ] **Step 3: Wait for and inspect the production deployment**

Use the linked Vercel project only to observe the deployment created by the push. Expected: build succeeds, the new production deployment becomes active atomically, and the previous deployment remains available for rollback.

If it fails, stop. Use `./scripts/gramscope status` and the Vercel build logs; do not alter worker credentials or start Telegram locally.

- [ ] **Step 4: Verify the public presentation and existing HTTP boundaries**

Open the production root page and verify hero, workflow controls, deployment links, Open Graph image, and the responsive matrix's representative desktop and mobile widths.

Verify `/api/mcp` still enforces its existing authentication and that the OAuth metadata and media routes retain their prior status behavior. Do not call a media capability URL from logs or fabricate a token.

- [ ] **Step 5: Verify production topology through the supported CLI**

Run:

```bash
./scripts/gramscope doctor --json
```

Expected: exit 0 with the same single-worker/single-session topology. Keep the output private.

- [ ] **Step 6: Perform real-client acceptance without reconnecting**

Using the already-connected ChatGPT and Grok Bot integrations, list the existing tools and invoke one read-only operation in each. Expected: both integrations work without reconnecting, reauthorizing, fixture changes, or a second Telegram connection.

If either client fails, stop public release and diagnose through the production logs and `./scripts/gramscope`; do not reconnect until the failure is understood.

- [ ] **Step 7: Change GitHub visibility only after every acceptance check passes**

Run:

```bash
gh repo edit aartem1/GramScope --visibility public --accept-visibility-change-consequences
gh repo view aartem1/GramScope --json visibility,url,defaultBranchRef
```

Expected: visibility is `PUBLIC`, URL is `https://github.com/aartem1/GramScope`, and the default branch is `main`.

- [ ] **Step 8: Final public checks**

In a logged-out browser session, verify the GitHub repository, `LICENSE`, `SECURITY.md`, README links, and deployment guide are readable. Re-open the landing page's GitHub links and confirm they resolve without authentication.

Run one final read-only health check:

```bash
./scripts/gramscope doctor --json
```

Expected: production remains healthy after the repository visibility change.
