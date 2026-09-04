# GramScope public repository and landing page — design

Task card: `docs/superpowers/tasks/public-landing.md`. Branch: `main`, by the
owner's explicit decision. This design is additive to the production
architecture in
`docs/superpowers/specs/2026-09-03-telegram-worker-split-design.md`.

## 1. Outcome

Publish GramScope as an MIT-licensed GitHub repository and add a polished,
English-only landing page at `/` in the existing Next.js application on
Vercel.

The landing page explains, with concise copy and visual demonstrations:

- what GramScope is;
- why someone would connect Telegram to an AI client this way;
- how the Vercel and VPS halves keep the Telegram session private;
- how to deploy an independent instance; and
- where to inspect and clone the source code.

The page is a presentation and self-hosting entry point. It does not provide
access to the owner's Telegram account, expose a public demo, or add any
multi-user hosted service.

## 2. Non-negotiable production boundary

The website must not change the running MCP system at any stage.

- The existing MCP endpoint remains `/api/mcp`.
- OAuth metadata, issuer, audience, owner validation, and token handling remain
  unchanged.
- Existing media routes and capability-token behavior remain unchanged.
- The VPS worker, RPC transport, mTLS channel, and Telegram connection remain
  unchanged.
- No Telegram credential or session is introduced into Vercel, a local
  development server, a test, or the repository.
- No local or second worker process may connect to the production Telegram
  session.
- The complete `tools/list` payload remains byte-identical, including names,
  titles, descriptions, schemas, annotations, and embedded limits.

Landing-page work is therefore restricted to new presentation files, public
documentation, repository metadata, and narrowly necessary shared styling or
static assets. It must not modify MCP registration, schemas, middleware,
authentication, media handling, worker code, or Telegram code.

## 3. Chosen deployment shape

The landing page lives at `/` in the existing Next.js/Vercel project. Route
handlers continue to live under their current `/api/...` paths.

This is preferred to a second Vercel project or a separate repository because
it gives the public project one canonical URL, keeps deployment and ownership
simple, and requires no proxy or cross-project routing. A normal App Router
page and the existing route handlers can coexist without sharing application
logic.

The application must not be converted to a static export: the production API
routes require the Next.js server runtime. The root page itself should be
statically rendered at build time.

## 4. Page architecture

The page uses five sections, in this order.

### 4.1 Hero: what it is

Primary message:

> Your Telegram. Inside your AI.

Supporting copy identifies GramScope as a private MCP bridge through which
compatible AI clients can read, research, and organize Telegram without giving
a hosted third party the Telegram session.

The primary action opens the GitHub repository. The secondary action scrolls
to the deployment section. Button labels must describe the result explicitly:
`View on GitHub` and `Deployment guide`.

The hero's main visual is a request path rather than a decorative orbit:

1. compatible AI client;
2. GramScope on Vercel;
3. private mTLS boundary;
4. GramScope worker on the owner's VPS;
5. Telegram.

ChatGPT and Grok Bot appear as tested examples. The visual and copy must not
imply that these are the only compatible clients.

### 4.2 Workflows: why it is useful

An interactive workflow selector shows a small set of concrete outcomes:

- catch up on unread channels;
- research a topic across joined sources;
- discover related public channels;
- organize subscriptions and folders; and
- inspect bounded media from a selected message.

Selecting a workflow updates one visual command or prompt canvas. This section
demonstrates value without duplicating the architecture or publishing a wall
of all twenty tools. The examples must be truthful to the current tool set and
must not imply autonomous monitoring, unrestricted messaging, transcription,
or a built-in AI model.

### 4.3 Trust boundaries: why it is private

This section introduces only security facts not already stated elsewhere:

- OAuth access is restricted to one configured owner;
- the worker exposes bounded domain operations rather than raw Telegram API
  access; and
- Telegram content is untrusted source material, not instruction or verified
  evidence.

The Telegram-session placement is shown once in the hero architecture and is
not repeated as a slogan in this section.

### 4.4 Deployment: how to run an independent instance

The page gives a concise sequence and sends readers to the repository for the
authoritative procedure:

1. prepare a dedicated Telegram account, Telegram API credentials, a Node.js
   20+ environment, a Debian/Ubuntu VPS, Vercel, and WorkOS AuthKit;
2. clone the repository and configure the local SSH alias expected by the
   operations tooling;
3. run the repository's `./scripts/gramscope` install and login workflow;
4. connect a compatible AI client to the deployed `/api/mcp` endpoint.

The page must not reproduce secret-bearing commands, private host details, or
the full runbook. `README.md` provides the public overview and
`docs/operations.md` remains the authoritative operational source.

### 4.5 Final action

A compact final panel links to the GitHub repository and the deployment
documentation. There is no pricing, waitlist, hosted-demo form, testimonial,
FAQ, newsletter, or duplicated feature summary.

## 5. Visual direction

Use the approved “Prismatic Relay” direction:

- near-black navy base;
- controlled cyan, mint, and violet light;
- technical glass surfaces with fine borders and a subtle grid;
- strong typographic hierarchy;
- data-flow motion that reinforces the architecture; and
- deliberate empty space instead of dense marketing copy.

The result should feel like a mature infrastructure product, not a generic AI
template. Decoration must carry structural meaning. The request path is the
main visual metaphor; unexplained orbit diagrams, arbitrary particles, and
fake dashboards are excluded.

The existing geometric GramScope mark may be reused. No personal avatar,
Telegram screenshot, message content, or account identifier is shown.

## 6. Interaction and motion

The interactive layer is intentionally small:

- workflow selection updates the example canvas;
- request-path nodes may reveal concise explanatory states on focus or hover;
- the deployment action scrolls to the relevant section; and
- restrained entrance or relay animations support the reading order.

The document and every link remain useful if JavaScript fails. Only components
that require state become client components; the page shell, copy, navigation,
and diagrams remain server-rendered HTML and CSS/SVG.

Motion must stop or simplify under `prefers-reduced-motion`. All interactive
elements must work with a keyboard, expose visible focus, use semantic controls,
and provide accessible names. Hover cannot be the only way to reveal required
information.

## 7. Implementation shape

The expected presentation-only surface is:

- `app/layout.tsx` for document metadata, font setup, and the shared body;
- `app/page.tsx` for the static landing composition;
- a small group of landing-specific components;
- one landing stylesheet or CSS Modules; and
- local SVG/CSS graphics and existing public brand assets.

Use the framework and React versions already installed. Do not add Tailwind,
Framer Motion, a component framework, an analytics SDK, a CMS, a database, or
an AI SDK for this page. CSS transitions, keyframes, SVG, and a small React
state island are sufficient and keep the production surface small.

No global middleware or authentication wrapper is introduced. The public root
page performs no server fetch, reads no environment variable, and calls no MCP
or worker endpoint.

Metadata includes an English title and description, canonical GitHub link in
the page, Open Graph/Twitter presentation, theme color, and a local social
preview asset that contains no private data. The site initially has no
analytics or cookies.

## 8. Responsive behavior

Responsiveness is intrinsic rather than a sequence of device-specific mockups.

- The page uses fluid type and spacing with bounded `clamp()` values.
- Major grids collapse based on available component width, using `minmax()`,
  `auto-fit`, and container queries where they improve local composition.
- Children use `min-width: 0`; code and long identifiers wrap or clip inside
  their own bounds.
- Decorative glows are backgrounds or clipped descendants and cannot expand
  the document's scroll width.
- Controls remain reachable and readable with touch-sized targets.
- No page or component introduces horizontal scrolling at standard viewport
  widths from 320 px upward. Vertical scrolling is expected on short screens.

The 320 px threshold is an acceptance baseline, not a fixed design target.
Square, landscape, short, zoomed, and wide layouts must retain the reading
order without overlaps or off-screen controls.

## 9. Content rules

The public repository and website use English only for reader-facing prose.
Historical design records remain accurate records but any Russian prose found
before publication is translated without changing its technical meaning.

Tests that currently use Cyrillic only as Unicode fixtures are rewritten with
neutral non-ASCII examples, such as accented Latin text or emoji, so Unicode
coverage remains while the repository reads as English.

Each factual claim has one primary location on the page. Later sections may
link back through layout and hierarchy but must not restate the same claim in
new words. Final copy is checked against current implemented behavior and the
operations runbook; aspirational or future capabilities are excluded.

## 10. Public repository preparation

Before changing GitHub visibility:

- add the standard MIT `LICENSE` with the correct copyright holder/year;
- add `SECURITY.md` with a private vulnerability-reporting route and explicit
  instructions never to include credentials or Telegram content;
- update `README.md` only where the public positioning, landing URL, license,
  or self-hosting navigation requires it;
- confirm `.gitignore` excludes local Vercel state, environment files,
  certificates, keys, sessions, build output, and visual-companion artifacts;
- audit current tracked content and every reachable Git object for Telegram
  sessions, Telegram API credentials, OAuth secrets/tokens, worker bearer
  tokens, TLS private keys, media capability URLs, private host addresses, and
  accidentally committed environment files; and
- manually review every scanner finding in redacted form.

Secret values or matching file contents must never be printed into logs or the
conversation. Any plausible secret blocks publication until it is classified
and, when necessary, revoked and removed. A clean current tree alone is not
sufficient; the reachable history must be scanned.

The existing Git author email is intentionally retained by the owner's explicit
decision. Repository history is not rewritten for email privacy.

The GitHub repository remains private until the website is deployed and the
production MCP acceptance checks succeed. Only then is visibility changed to
public.

## 11. Safe delivery sequence on `main`

Because Vercel deploys from `main`, all work stays local until the entire
candidate passes its gates.

1. Run `./scripts/gramscope doctor` before implementation and record only the
   redacted health outcome.
2. Implement the additive page and public-repository files locally.
3. Perform the language and full-history secret audits.
4. Run the complete local acceptance suite.
5. Review the exact diff to confirm no protected MCP, worker, Telegram, OAuth,
   or media code changed.
6. Commit the complete candidate to local `main` only after those checks pass.
7. Push `main` once. Vercel builds the candidate atomically while the previous
   production deployment continues serving traffic.
8. Verify the deployed root page and existing routes, then run
   `./scripts/gramscope doctor` again.
9. Exercise the already-connected ChatGPT and Grok Bot integrations without
   reconnecting them and without starting any additional Telegram client.
10. Change the GitHub repository from private to public only after production
    acceptance succeeds.

If any local or production check fails, stop the release. Do not update the
golden `tools/list` fixture, rotate credentials, reconnect clients, or start a
second Telegram process as a workaround.

## 12. Verification and acceptance

The candidate must pass all of the following before push:

- `npm test`;
- `npm run typecheck`;
- `npm run lint`;
- `npm run build`;
- `npm run build:worker` because the public-release commit must not regress the
  second deployable half;
- the golden `tools/list` assertion with no fixture update;
- a production-build route review confirming `/` is static and every existing
  `/api/...` route is still present;
- a current-tree and reachable-history secret scan with every finding reviewed;
- an English-language audit of tracked reader-facing files;
- keyboard, visible-focus, reduced-motion, no-JavaScript, and semantic-heading
  checks;
- browser checks at 320, 360, 375, 390, 414, 768, 1024, and 1440 CSS pixels,
  plus representative square and short-landscape viewports; and
- confirmation that neither the page nor any component scrolls horizontally at
  the accepted widths.

After the Vercel deployment:

- `/` returns the landing page and its GitHub/documentation links resolve;
- the MCP endpoint still requires and validates its existing authentication;
- OAuth metadata and media routes retain their prior behavior;
- `./scripts/gramscope doctor` reports the existing production topology healthy;
- the already-connected ChatGPT and Grok Bot clients can list and invoke the
  existing tools without reconnecting; and
- no second MTProto connection is opened during acceptance.

## 13. Failure behavior

The landing page has no operational dependency on Telegram, WorkOS, the worker,
or the MCP endpoint. A page-rendering failure cannot call or mutate them.

If optional client-side interaction fails, the selected examples fall back to
static content and all navigation remains usable. Missing decorative assets
must not hide text or controls. External links use normal anchors rather than
JavaScript navigation.

Deployment failure leaves the previous Vercel production deployment active. A
failed post-deployment MCP or health check blocks public visibility and is
handled through `./scripts/gramscope`; it is not diagnosed by creating a local
Telegram connection.

## 14. Out of scope

- a hosted GramScope service or shared public instance;
- sign-up, billing, analytics, mailing lists, or user accounts on the landing
  page;
- a live Telegram demo or access to the owner's data;
- changes to MCP tools, schemas, capabilities, or product behavior;
- changes to the worker topology, authentication, mTLS, or secrets model;
- localization beyond English in this release; and
- history rewriting solely to hide the already-public Git author email.

## 15. Primary risks and mitigations

**Production coupling through one Vercel project.** Mitigated by a static root
page with no environment reads, by prohibiting middleware/auth changes, and by
holding the push until every local gate passes.

**Accidental `tools/list` drift.** Mitigated by protected-file diff review and
the existing golden fixture, which must be restored rather than updated if it
changes.

**Secret exposure when the repository becomes public.** Mitigated by scanning
both the current tree and reachable history, manually classifying redacted
findings, and changing visibility only after the audit and production
acceptance.

**Responsive decoration causing overflow.** Mitigated by intrinsic grids,
container-aware components, clipped/background decoration, explicit internal
width constraints, and a viewport matrix starting at 320 px.

**A visual page overstating the product.** Mitigated by deriving every example
from current tools and the operations runbook, presenting ChatGPT and Grok Bot
as tested clients rather than an exhaustive compatibility claim, and keeping
the setup guide linked to its authoritative repository documentation.
