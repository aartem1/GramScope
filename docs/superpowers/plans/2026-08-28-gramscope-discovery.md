# GramScope Discovery (sub-project 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two discovery tools — `search_channels` and `get_similar_channels` — so ChatGPT can propose public channels the account does not follow and hand them straight to the reading tools, taking the server to thirteen tools.

**Architecture:** One engine module `src/telegram/discovery.ts` owns both TL calls, the candidate mapping and the description enrichment. Enrichment is the whole design problem: `channels.getFullChannel` floods after roughly twenty calls in five seconds and teleproto absorbs the flood by sleeping, so the module caps a call at ten enrichments, runs them three at a time, and memoizes what it fetched for the life of the serverless instance. Neither tool paginates, because neither TL method offers an offset.

**Tech Stack:** TypeScript, Next.js App Router on Vercel, `@modelcontextprotocol/server` + `mcp-handler`, `teleproto` v1.229.0 (MTProto), `zod` v4, `vitest`.

**Spec:** `docs/superpowers/specs/2026-08-28-gramscope-discovery-design.md`

**Card:** `docs/superpowers/tasks/gramscope-mcp.md`

## Global Constraints

- **Branch `main`.** The owner works directly on `main` until the project is fully launched. Do not create a branch. A push to `main` deploys to Vercel, so push only where the plan says to.
- **`src/telegram/client.ts` is the only module permitted to import `teleproto`.** Reach MTProto through `withTelegram(fn)` and the TL namespace through `await getApi()`. No other file may `import ... from "teleproto"`.
- **Never print or log the StringSession, the api hash, or any credential.** Secrets live in the gitignored `.env.local` locally and in `vercel env` for deploys; they never enter chat, commits, specs, plans, or test fixtures.
- **`channels.getFullChannel` floods after roughly 20 calls in 5 seconds** with a 27-second FLOOD_WAIT that teleproto absorbs by sleeping. This sub-project is the first to fan out over it at all, and it may do so only under all three of: **at most `MAX_ENRICHED_CANDIDATES` = 10 per call**, **`DISCOVERY_ENRICH_CONCURRENCY` = 3**, and the instance-level details cache. Do not raise any of the three.
- **Normalize teleproto arrays with `Array.from` before they enter a returned value.** TL list fields arrive as `Array` subclasses whose `filter`/`map`/`slice` preserve the subclass through `Symbol.species`, and a leak is invisible on the wire.
- **Response cap: `MAX_RESPONSE_BYTES` = 256 KB**, enforced with the existing `fitToSizeCap`.
- **An empty result is never an error.** No candidates and no recommendations are empty successes.
- **Telegram's order is never re-sorted** — not by subscriber count, not by anything. README §D requires the server not to rank candidates.
- **Both tools are read-only** and join nothing. `annotations: { readOnlyHint: true }` on both.
- **Gates for every task:** `npm run test`, `npm run typecheck`, `npm run lint` green before the commit. `npm run test` excludes the live tier by design.
- **`npm run build` rewrites `tsconfig.json`** (Next adds `allowJs`, `incremental`, `resolveJsonModule`, `isolatedModules` and reformats it). That is local churn — revert it, never commit it.
- **Format only the files you edited.** `npx prettier --write` over a directory reformats unrelated files, because the repository is not prettier-clean and `npm run lint` does not enforce formatting.
- **Test imports use the `@/` alias** for `src/` (`import { searchChannels } from "@/telegram/discovery"`).

---

## File Structure

Created:

| File | Responsibility |
| --- | --- |
| `src/schemas/discovery.ts` | `discoveredSourceSchema` and the two response schemas. A candidate is not a `TelegramSource`: it has no unread state and no folders, and it has trust flags. |
| `src/telegram/discovery.ts` | Both TL engines, the candidate mapping, and the capped, throttled, cached enrichment. |
| `src/mcp/tools/search-channels.ts` | Tool registration: schema, description, `readOnlyHint`. |
| `src/mcp/tools/get-similar-channels.ts` | Same, for recommendations. |
| `tests/telegram-discovery.test.ts` | Unit tests against a faked `TelegramLike`. |
| `tests/live/discovery.live.test.ts` | The live tier for this sub-project. |

Modified:

| File | Change |
| --- | --- |
| `src/concurrency.ts` | Add `DISCOVERY_ENRICH_CONCURRENCY = 3`. |
| `src/mcp/server.ts` | Register the two new tools. |
| `src/mcp/version.ts`, `package.json` | Bump `MCP_SERVER_VERSION` to `1.2.0`; `tests/mcp-handler.test.ts` pins the two to each other. |
| `tests/tools.test.ts` | Thirteen tools; both new ones in the read-only list and in the outside-source guidance list. |
| `tests/mcp-handler.test.ts` | The exact `tools/list` set, and the version assertion. |
| `src/telegram/peer-id.ts` | **Only if** Task 6 proves `contacts.search` omits `active` on `usernames[]` entries. |

`fetchChannelDetails` and `SourceDetails` are reused from `src/telegram/dialogs.ts` unchanged. `fetchChannelDetails` takes an entity and hands it to `channels.GetFullChannel`, and teleproto converts a wire `Api.Channel` — which is what both TL methods return, carrying `accessHash` — into an `InputChannel` itself. No resolution step, so the sub-project 3 lookup budget is not involved.

---

### Task 1: The candidate schema and its mapping

Spec §6. A discovery candidate is its own shape. This task delivers the schema
and the pure function that builds one from a TL entity, with no network in it.

**Files:**
- Create: `src/schemas/discovery.ts`
- Create: `src/telegram/discovery.ts`
- Test: `tests/telegram-discovery.test.ts`

**Interfaces:**
- Consumes: `entityMarkedId`, `entityUsernames`, `sourceType` from `src/telegram/peer-id.ts`; `SourceDetails` from `src/telegram/dialogs.ts`; `DialogIndex` from `src/telegram/dialog-index.ts`.
- Produces: `discoveredSourceSchema`, `DiscoveredSource`, `searchChannelsResultSchema`, `similarChannelsResultSchema` from `src/schemas/discovery.ts`; `toCandidate(entity: Record<string, unknown>, index: DialogIndex, details?: SourceDetails): DiscoveredSource` from `src/telegram/discovery.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/telegram-discovery.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { toCandidate } from "@/telegram/discovery";
import type { DialogIndex } from "@/telegram/dialog-index";

const HELD = "-1001111111111";

function index(ids: string[] = []): DialogIndex {
  return {
    byId: new Map(
      ids.map((id) => [
        id,
        {
          source_id: id,
          title: "Held",
          unread_count: 0,
          read_inbox_max_id: 0,
          folder_ids: [],
        },
      ]),
    ),
    folders: [],
  };
}

function channel(over: Record<string, unknown> = {}) {
  return {
    className: "Channel",
    id: 1111111111n,
    title: "Alpha News",
    broadcast: true,
    participantsCount: 4874,
    ...over,
  };
}

describe("toCandidate", () => {
  it("reads a live handle out of usernames[] when username is null", () => {
    // Measured 2026-08-28: contacts.search returns username: null for
    // collectible handles and puts the live one in usernames[].
    const candidate = toCandidate(
      channel({
        username: null,
        usernames: [{ username: "alpha_news", active: true }],
      }),
      index(),
    );
    expect(candidate.username).toBe("alpha_news");
    expect(candidate.url).toBe("https://t.me/alpha_news");
  });

  it("reports joined from the dialog index, not from the left flag", () => {
    // A stale `left` is exactly the disagreement this pins: the index is the
    // same authority every other tool means by "this account holds it".
    const held = toCandidate(channel({ left: true }), index([HELD]));
    const stranger = toCandidate(channel({ left: false }), index([]));
    expect(held.joined).toBe(true);
    expect(stranger.joined).toBe(false);
  });

  it("states every trust flag as a boolean, never as an absent key", () => {
    const clean = toCandidate(channel(), index());
    expect(clean).toMatchObject({
      verified: false,
      scam: false,
      fake: false,
      restricted: false,
    });
    const bad = toCandidate(
      channel({ scam: true, fake: true, restricted: true, verified: true }),
      index(),
    );
    expect(bad).toMatchObject({
      verified: true,
      scam: true,
      fake: true,
      restricted: true,
    });
  });

  it("prefers a fetched description over the entity's own about", () => {
    const candidate = toCandidate(channel({ about: "stale" }), index(), {
      description: "fetched",
    });
    expect(candidate.description).toBe("fetched");
  });

  it("carries id, title, type and subscriber count", () => {
    expect(toCandidate(channel({ username: "alpha" }), index())).toMatchObject({
      id: HELD,
      title: "Alpha News",
      type: "channel",
      subscriber_count: 4874,
      username: "alpha",
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/telegram-discovery.test.ts`
Expected: FAIL — `Failed to resolve import "@/telegram/discovery"`.

- [ ] **Step 3: Write the schema**

Create `src/schemas/discovery.ts`:

```ts
import { z } from "zod";

/**
 * A source the account does NOT necessarily hold. It is deliberately not
 * `telegramSourceSchema`: a candidate has no unread state and no folders, and
 * it carries trust flags that a subscribed source has no reason to repeat.
 * Widening the shared schema would add fields to the declared outputSchema of
 * four shipped tools that never populate them.
 */
export const discoveredSourceSchema = z.object({
  id: z.string(),
  title: z.string(),
  username: z.string().optional(),
  description: z.string().optional(),
  url: z.string().optional(),
  type: z.enum(["channel", "group", "chat"]),
  subscriber_count: z.number().int().optional(),
  joined: z.boolean(),
  // Non-optional on purpose: an absent `scam` and a false one must not look
  // the same to a model deciding whether to recommend a channel.
  verified: z.boolean(),
  scam: z.boolean(),
  fake: z.boolean(),
  restricted: z.boolean(),
});

export type DiscoveredSource = z.infer<typeof discoveredSourceSchema>;

export const searchChannelsResultSchema = z.object({
  candidates: z.array(discoveredSourceSchema),
  truncated: z.boolean(),
});

export const similarChannelsResultSchema = z.object({
  candidates: z.array(discoveredSourceSchema),
  total_similar: z.number().int().optional(),
  truncated: z.boolean(),
});
```

- [ ] **Step 4: Write the mapping**

Create `src/telegram/discovery.ts`:

```ts
import type { SourceDetails } from "./dialogs";
import type { DialogIndex } from "./dialog-index";
import { entityMarkedId, entityUsernames, sourceType } from "./peer-id";
import type { DiscoveredSource } from "../schemas/discovery";

/**
 * Builds one candidate from a TL entity. Pure: everything it needs is either
 * on the entity, in the already-loaded dialog index, or in `details` fetched
 * by the caller.
 */
export function toCandidate(
  entity: Record<string, unknown>,
  index: DialogIndex,
  details: SourceDetails = {},
): DiscoveredSource {
  const id = entityMarkedId(entity) ?? "";
  // entityUsernames, not entityUsername: contacts.search returns collectible
  // handles only in usernames[], with username itself null.
  const username = entityUsernames(entity)[0];
  const description =
    details.description ??
    (typeof entity.about === "string" ? entity.about : undefined);

  return {
    id,
    title: typeof entity.title === "string" ? entity.title : "",
    ...(username ? { username, url: `https://t.me/${username}` } : {}),
    ...(description ? { description } : {}),
    type: sourceType(entity),
    ...(typeof entity.participantsCount === "number"
      ? { subscriber_count: entity.participantsCount }
      : {}),
    joined: id !== "" && index.byId.has(id),
    verified: entity.verified === true,
    scam: entity.scam === true,
    fake: entity.fake === true,
    restricted: entity.restricted === true,
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/telegram-discovery.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Run the gates**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
npx prettier --write src/schemas/discovery.ts src/telegram/discovery.ts tests/telegram-discovery.test.ts
git add src/schemas/discovery.ts src/telegram/discovery.ts tests/telegram-discovery.test.ts
git commit -m "feat: the discovery candidate schema and its mapping"
```

---

### Task 2: Capped, throttled, cached enrichment

Spec §7, and the reason this sub-project needs a design at all. A description
costs one `channels.getFullChannel`, and that method floods after roughly
twenty calls in five seconds — teleproto then sleeps 27 seconds inside a
60-second serverless budget. All three guards land together because each one
alone is insufficient.

**Files:**
- Modify: `src/concurrency.ts`
- Modify: `src/telegram/discovery.ts`
- Test: `tests/telegram-discovery.test.ts`

**Interfaces:**
- Consumes: `mapWithConcurrency` from `src/concurrency.ts`; `fetchChannelDetails` and `SourceDetails` from `src/telegram/dialogs.ts`; `TelegramLike` from `src/telegram/client.ts`.
- Produces: `DISCOVERY_ENRICH_CONCURRENCY` from `src/concurrency.ts`; `MAX_ENRICHED_CANDIDATES`, `enrichCandidates(client, entities)`, `__resetDiscoveryCacheForTests()` from `src/telegram/discovery.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/telegram-discovery.test.ts`:

```ts
import { afterEach } from "vitest";
import {
  __resetDiscoveryCacheForTests,
  enrichCandidates,
  MAX_ENRICHED_CANDIDATES,
} from "@/telegram/discovery";
import type { TelegramLike } from "@/telegram/client";

afterEach(() => {
  __resetDiscoveryCacheForTests();
});

function fullChannelClient(
  reply: (channelId: string) => unknown,
): { client: TelegramLike; calls: string[]; inFlight: () => number } {
  const calls: string[] = [];
  let live = 0;
  let peak = 0;
  const client = {
    connected: true,
    connect: async () => true,
    getDialogs: async () => [],
    getEntity: async () => ({}),
    getMessages: async () => [],
    invoke: async (request: unknown) => {
      const channel = (request as { channel?: { id?: unknown } }).channel;
      const id = String((channel as { id?: unknown })?.id ?? "");
      calls.push(id);
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 5));
      live -= 1;
      return reply(id);
    },
  } as unknown as TelegramLike;
  return { client, calls, inFlight: () => peak };
}

function fullChannel(about: string) {
  return { fullChat: { about } };
}

function entities(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    className: "Channel",
    id: BigInt(1000000000 + i),
    title: `C${i}`,
  }));
}

describe("enrichCandidates", () => {
  it("never issues more than the flood ceiling of requests", async () => {
    const { client, calls } = fullChannelClient(() => fullChannel("about"));
    await enrichCandidates(client, entities(40));
    expect(MAX_ENRICHED_CANDIDATES).toBe(10);
    expect(calls.length).toBe(MAX_ENRICHED_CANDIDATES);
  });

  it("keeps at most three requests in flight", async () => {
    const { client, inFlight } = fullChannelClient(() => fullChannel("about"));
    await enrichCandidates(client, entities(10));
    expect(inFlight()).toBeLessThanOrEqual(3);
  });

  it("serves a repeat candidate from the instance cache", async () => {
    const { client, calls } = fullChannelClient(() => fullChannel("about"));
    const list = entities(3);
    await enrichCandidates(client, list);
    await enrichCandidates(client, list);
    expect(calls.length).toBe(3);
  });

  it("does not cache a failure, so one flood is not permanent", async () => {
    let fail = true;
    const { client, calls } = fullChannelClient(() => {
      if (fail) throw new Error("FLOOD_WAIT_27");
      return fullChannel("about");
    });
    const list = entities(1);
    expect((await enrichCandidates(client, list))[0]).toEqual({});
    fail = false;
    expect((await enrichCandidates(client, list))[0]).toMatchObject({
      description: "about",
    });
    expect(calls.length).toBe(2);
  });

  it("isolates one failure to one candidate", async () => {
    const { client } = fullChannelClient((id) => {
      if (id === "1000000001") throw new Error("CHANNEL_PRIVATE");
      return fullChannel("about");
    });
    const details = await enrichCandidates(client, entities(3));
    expect(details.map((d) => d.description)).toEqual([
      "about",
      undefined,
      "about",
    ]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/telegram-discovery.test.ts`
Expected: FAIL — `enrichCandidates` is not exported.

- [ ] **Step 3: Add the concurrency constant**

In `src/concurrency.ts`, below `FANOUT_CONCURRENCY`:

```ts
/**
 * Spec §7. `channels.getFullChannel` floods after roughly 20 calls in 5
 * seconds, and teleproto absorbs the flood by sleeping 27 seconds — so what
 * matters is calls per second, not calls per tool invocation. Eight in flight
 * would empty a ten-item queue in about two round trips and put the next tool
 * call inside the same window.
 */
export const DISCOVERY_ENRICH_CONCURRENCY = 3;
```

- [ ] **Step 4: Implement enrichment**

Add to `src/telegram/discovery.ts`:

```ts
import { fetchChannelDetails } from "./dialogs";
import type { TelegramLike } from "./client";
import {
  DISCOVERY_ENRICH_CONCURRENCY,
  mapWithConcurrency,
} from "../concurrency";

/** Half the measured flood threshold, so one call can never flood alone. */
export const MAX_ENRICHED_CANDIDATES = 10;

/**
 * Marked id to fetched details, for the life of the serverless instance. A
 * channel's `about` changes rarely and recommendation sets overlap heavily
 * between calls, so this is what keeps two discovery calls in one conversation
 * from summing past the flood threshold. It holds description and linked-chat
 * only; `joined`, unread state and folder membership are never cached, because
 * those change while `about` does not.
 */
const detailsCache = new Map<string, SourceDetails>();

export function __resetDiscoveryCacheForTests(): void {
  detailsCache.clear();
}

/**
 * Fetches a description per candidate, in input order, under all three flood
 * guards. Cuts to MAX_ENRICHED_CANDIDATES first: cutting after fetching would
 * spend exactly the requests the ceiling exists to prevent.
 *
 * A failure yields {} and is NOT cached — caching it would make one transient
 * FLOOD_WAIT permanent for the life of the instance. A candidate without a
 * description is a valid candidate; a discovery call that dies because one
 * channel of ten refused a full-info request is not.
 */
export async function enrichCandidates(
  client: TelegramLike,
  entities: Record<string, unknown>[],
): Promise<SourceDetails[]> {
  const kept = entities.slice(0, MAX_ENRICHED_CANDIDATES);
  return mapWithConcurrency(
    kept,
    DISCOVERY_ENRICH_CONCURRENCY,
    async (entity) => {
      const id = entityMarkedId(entity) ?? "";
      const cached = detailsCache.get(id);
      if (cached) return cached;

      const details = await fetchChannelDetails(client, entity).catch(
        () => ({}) as SourceDetails,
      );
      if (
        details.description !== undefined ||
        details.linkedDiscussionId !== undefined
      ) {
        detailsCache.set(id, details);
      }
      return details;
    },
  );
}
```

`SourceDetails` moves from a type-only import to a value-free import alongside
`fetchChannelDetails`; keep it as `import { fetchChannelDetails } from "./dialogs"`
plus the existing `import type { SourceDetails } from "./dialogs"`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/telegram-discovery.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Prove the guards are not vacuous**

Run each mutation, confirm the named test goes red, then revert it:

1. `MAX_ENRICHED_CANDIDATES = 40` → "never issues more than the flood ceiling" fails.
2. `DISCOVERY_ENRICH_CONCURRENCY = 8` → "keeps at most three requests in flight" fails.
3. Remove the `detailsCache.get` early return → "serves a repeat candidate from the instance cache" fails.
4. Cache unconditionally (`detailsCache.set(id, details)` with no guard) → "does not cache a failure" fails.

Record the four results in the ledger. A guard that survives its own mutation
is not a guard.

- [ ] **Step 7: Run the gates and commit**

```bash
npm run test && npm run typecheck && npm run lint
npx prettier --write src/concurrency.ts src/telegram/discovery.ts tests/telegram-discovery.test.ts
git add src/concurrency.ts src/telegram/discovery.ts tests/telegram-discovery.test.ts
git commit -m "feat: capped, throttled and cached description enrichment"
```

---

### Task 3: `search_channels` engine

Spec §5.1. `contacts.search` with `broadcasts: true`, merging the account's own
matches ahead of strangers, de-duplicated, users dropped.

**Files:**
- Modify: `src/telegram/discovery.ts`
- Test: `tests/telegram-discovery.test.ts`

**Interfaces:**
- Consumes: `getApi`, `withTelegram` from `src/telegram/client.ts`; `fetchDialogIndex` from `src/telegram/dialog-index.ts`; `readBigId` from `src/telegram/peer-id.ts`; `GramScopeError` from `src/errors/taxonomy.ts`; `fitToSizeCap` from `src/schemas/size.ts`; `toCandidate` and `enrichCandidates` from Tasks 1-2.
- Produces: `searchChannels(input: { query: string; limit?: number }): Promise<{ candidates: DiscoveredSource[]; truncated: boolean }>` from `src/telegram/discovery.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/telegram-discovery.test.ts`:

```ts
import {
  __resetClientForTests,
  __setClientFactoryForTests,
} from "@/telegram/client";
import { searchChannels } from "@/telegram/discovery";

function found(over: Record<string, unknown>) {
  return { className: "contacts.Found", myResults: [], results: [], chats: [], users: [], ...over };
}

function peerChannel(bare: number) {
  return { className: "PeerChannel", channelId: BigInt(bare) };
}

function peerUser(bare: number) {
  return { className: "PeerUser", userId: BigInt(bare) };
}

/**
 * Routes by TL class name, never by the presence of a `channel` field:
 * GetChannelRecommendations carries one too, so a field test would feed the
 * recommendation call the enrichment reply. Requests are stored unspread,
 * because teleproto puts `className` on the prototype.
 */
function requestName(request: unknown): string {
  return String((request as { className?: unknown }).className ?? "");
}

function isEnrichment(request: unknown): boolean {
  return requestName(request).includes("GetFullChannel");
}

function installSearch(reply: unknown) {
  const sent: unknown[] = [];
  __setClientFactoryForTests(async () => ({
    connected: true,
    connect: async () => true,
    getDialogs: async () => [],
    getEntity: async () => ({}),
    getMessages: async () => [],
    invoke: async (request: unknown) => {
      sent.push(request);
      if (isEnrichment(request)) return { fullChat: { about: "about" } };
      return reply;
    },
  }));
  return sent;
}

afterEach(() => {
  __setClientFactoryForTests(undefined);
  __resetClientForTests();
});

describe("searchChannels", () => {
  it("always asks Telegram for broadcasts only", async () => {
    const sent = installSearch(found({}));
    await searchChannels({ query: "нейросети" });
    expect(requestName(sent[0])).toBe("contacts.Search");
    expect(sent[0]).toMatchObject({ q: "нейросети", broadcasts: true });
  });

  it("rejects an empty query without calling Telegram", async () => {
    const sent = installSearch(found({}));
    await expect(searchChannels({ query: "   " })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(sent).toEqual([]);
  });

  it("drops user results and keeps channels", async () => {
    installSearch(
      found({
        results: [peerUser(5), peerChannel(1111111111)],
        chats: [{ className: "Channel", id: 1111111111n, title: "Alpha" }],
        users: [{ className: "User", id: 5n, firstName: "Someone" }],
      }),
    );
    const { candidates } = await searchChannels({ query: "alpha" });
    expect(candidates.map((c) => c.title)).toEqual(["Alpha"]);
  });

  it("puts the account's own matches first and lists a peer once", async () => {
    installSearch(
      found({
        myResults: [peerChannel(2222222222)],
        results: [peerChannel(1111111111), peerChannel(2222222222)],
        chats: [
          { className: "Channel", id: 1111111111n, title: "Stranger" },
          { className: "Channel", id: 2222222222n, title: "Mine" },
        ],
      }),
    );
    const { candidates } = await searchChannels({ query: "x" });
    expect(candidates.map((c) => c.title)).toEqual(["Mine", "Stranger"]);
  });

  it("reports truncated at Telegram's cap of ten and not below it", async () => {
    const ten = Array.from({ length: 10 }, (_, i) => 1000000000 + i);
    installSearch(
      found({
        results: ten.map(peerChannel),
        chats: ten.map((bare) => ({
          className: "Channel",
          id: BigInt(bare),
          title: `C${bare}`,
        })),
      }),
    );
    expect((await searchChannels({ query: "x" })).truncated).toBe(true);

    const nine = ten.slice(0, 9);
    installSearch(
      found({
        results: nine.map(peerChannel),
        chats: nine.map((bare) => ({
          className: "Channel",
          id: BigInt(bare),
          title: `C${bare}`,
        })),
      }),
    );
    expect((await searchChannels({ query: "x" })).truncated).toBe(false);
  });

  it("cuts to limit before enriching, not after", async () => {
    const ten = Array.from({ length: 10 }, (_, i) => 1000000000 + i);
    const sent = installSearch(
      found({
        results: ten.map(peerChannel),
        chats: ten.map((bare) => ({
          className: "Channel",
          id: BigInt(bare),
          title: `C${bare}`,
        })),
      }),
    );
    const { candidates, truncated } = await searchChannels({
      query: "x",
      limit: 2,
    });
    expect(candidates).toHaveLength(2);
    expect(truncated).toBe(true);
    expect(sent.filter(isEnrichment)).toHaveLength(2);
  });

  it("returns an empty list as a success", async () => {
    installSearch(found({}));
    await expect(searchChannels({ query: "nothing" })).resolves.toEqual({
      candidates: [],
      truncated: false,
    });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/telegram-discovery.test.ts`
Expected: FAIL — `searchChannels` is not exported.

- [ ] **Step 3: Implement the engine**

Add to `src/telegram/discovery.ts`:

```ts
import { getApi, withTelegram } from "./client";
import { fetchDialogIndex } from "./dialog-index";
import { readBigId } from "./peer-id";
import { GramScopeError } from "../errors/taxonomy";
import { fitToSizeCap } from "../schemas/size";

/**
 * Measured 2026-08-28: contacts.search caps global results at 10 whatever
 * `limit` says — 50 and 200 returned the same page — and offers no offset.
 * A full page is therefore the only available signal that more may exist.
 */
const CONTACTS_SEARCH_CAP = 10;

export type SearchChannelsInput = { query: string; limit?: number };

export type SearchChannelsResult = {
  candidates: DiscoveredSource[];
  truncated: boolean;
};

/**
 * Channel entities from a contacts.Found, in Telegram's order with the
 * account's own matches first, each peer once. A PeerUser has no channelId, so
 * users fall out here rather than needing a separate filter.
 */
function channelEntities(found: unknown): Record<string, unknown>[] {
  const reply = (found ?? {}) as {
    myResults?: unknown[];
    results?: unknown[];
    chats?: unknown[];
  };

  const byBareId = new Map<string, Record<string, unknown>>();
  for (const chat of Array.from(reply.chats ?? [])) {
    const bare = readBigId((chat as { id?: unknown }).id);
    if (bare !== undefined) byBareId.set(bare, chat as Record<string, unknown>);
  }

  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const peer of [
    ...Array.from(reply.myResults ?? []),
    ...Array.from(reply.results ?? []),
  ]) {
    const bare = readBigId((peer as { channelId?: unknown }).channelId);
    if (bare === undefined) continue;
    const entity = byBareId.get(bare);
    if (entity === undefined) continue;
    const marked = entityMarkedId(entity);
    if (marked === undefined || seen.has(marked)) continue;
    seen.add(marked);
    out.push(entity);
  }
  return out;
}

export async function searchChannels(
  input: SearchChannelsInput,
): Promise<SearchChannelsResult> {
  const query = (input.query ?? "").trim();
  if (query.length === 0) {
    throw new GramScopeError("INVALID_INPUT", "query must not be empty");
  }
  const limit = input.limit ?? MAX_ENRICHED_CANDIDATES;

  const index = await fetchDialogIndex();

  return withTelegram(async (client) => {
    const Api = await getApi();
    const found = await client.invoke(
      new Api.contacts.Search({
        q: query,
        limit: CONTACTS_SEARCH_CAP,
        // Not an option: it costs nothing, and the quota it frees refills
        // with channels, which is what this product reads.
        broadcasts: true,
      }),
    );

    const entities = channelEntities(found);
    const kept = entities.slice(0, limit);
    const details = await enrichCandidates(client, kept);
    const candidates = kept.map((entity, i) =>
      toCandidate(entity, index, details[i]),
    );

    const fit = fitToSizeCap(candidates, (shown) => ({
      candidates: shown,
      truncated: true,
    }));
    const shown = candidates.slice(0, fit);

    return {
      candidates: shown,
      // One meaning in both tools: the server held more than this response
      // carries — whether Telegram capped the page or `limit` cut it.
      truncated: shown.length < entities.length || entities.length >= CONTACTS_SEARCH_CAP,
    };
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/telegram-discovery.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Run the gates and commit**

```bash
npm run test && npm run typecheck && npm run lint
npx prettier --write src/telegram/discovery.ts tests/telegram-discovery.test.ts
git add src/telegram/discovery.ts tests/telegram-discovery.test.ts
git commit -m "feat: search_channels engine on contacts.search"
```

---

### Task 4: `get_similar_channels` engine

Spec §5.2. One TL method, two modes, and the mode follows the argument rather
than a flag the model can set wrongly.

**Files:**
- Modify: `src/telegram/discovery.ts`
- Test: `tests/telegram-discovery.test.ts`

**Interfaces:**
- Consumes: everything Task 3 consumes, plus `resolveSource` from `src/telegram/peer-resolve.ts`.
- Produces: `getSimilarChannels(input: { source?: string; limit?: number }): Promise<{ candidates: DiscoveredSource[]; total_similar?: number; truncated: boolean }>`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/telegram-discovery.test.ts`:

```ts
import { getSimilarChannels } from "@/telegram/discovery";
import { __resetPeerCacheForTests } from "@/telegram/peer-resolve";

afterEach(() => {
  __resetPeerCacheForTests();
});

function chatsReply(count: number | undefined, ids: number[]) {
  return {
    className: count === undefined ? "messages.Chats" : "messages.ChatsSlice",
    ...(count === undefined ? {} : { count }),
    chats: ids.map((bare) => ({
      className: "Channel",
      id: BigInt(bare),
      title: `C${bare}`,
      participantsCount: bare,
    })),
  };
}

describe("getSimilarChannels", () => {
  it("omits the channel argument entirely when no source is given", async () => {
    const sent = installSearch(chatsReply(undefined, [1000000001]));
    await getSimilarChannels({});
    const recommendation = sent.find(
      (r) => requestName(r) === "channels.GetChannelRecommendations",
    );
    expect(recommendation).toBeDefined();
    expect((recommendation as { channel?: unknown }).channel).toBeUndefined();
  });

  it("passes a resolved handle when a source is given", async () => {
    const sent = installSearch(chatsReply(79, [1000000001]));
    await getSimilarChannels({ source: "@alpha" });
    const recommendation = sent.find(
      (r) => requestName(r) === "channels.GetChannelRecommendations",
    );
    expect(recommendation).toMatchObject({ channel: "alpha" });
  });

  it("reports total_similar in seeded mode and omits it in global mode", async () => {
    installSearch(chatsReply(79, [1000000001]));
    const seeded = await getSimilarChannels({ source: "@alpha" });
    expect(seeded.total_similar).toBe(79);
    expect(seeded.truncated).toBe(true);

    installSearch(chatsReply(undefined, [1000000001]));
    const global = await getSimilarChannels({});
    expect(global.total_similar).toBeUndefined();
    expect(global.truncated).toBe(false);
  });

  it("never re-sorts Telegram's order", async () => {
    // Ascending subscriber counts: a tool that ranked by popularity would
    // reverse these, and README §D forbids the server ranking candidates.
    installSearch(chatsReply(undefined, [10, 20, 30]));
    const { candidates } = await getSimilarChannels({});
    expect(candidates.map((c) => c.subscriber_count)).toEqual([10, 20, 30]);
  });

  it("cuts a hundred global recommendations to the flood ceiling", async () => {
    const ids = Array.from({ length: 100 }, (_, i) => 1000000000 + i);
    const sent = installSearch(chatsReply(undefined, ids));
    const { candidates, truncated } = await getSimilarChannels({});
    expect(candidates).toHaveLength(MAX_ENRICHED_CANDIDATES);
    expect(truncated).toBe(true);
    expect(sent.filter(isEnrichment)).toHaveLength(MAX_ENRICHED_CANDIDATES);
  });

  it("returns no recommendations as a success", async () => {
    installSearch(chatsReply(undefined, []));
    await expect(getSimilarChannels({})).resolves.toEqual({
      candidates: [],
      truncated: false,
    });
  });
});
```

Note for the implementer: `installSearch` and `isEnrichment` come from Task 3
and route by TL class name. Do not switch either to a `"channel" in request`
test — `GetChannelRecommendations` carries a `channel` field too, and the
recommendation call would then be served the enrichment reply and the seeded
tests would fail for a reason that has nothing to do with the engine.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/telegram-discovery.test.ts`
Expected: FAIL — `getSimilarChannels` is not exported.

- [ ] **Step 3: Implement the engine**

Add to `src/telegram/discovery.ts`:

```ts
import { resolveSource } from "./peer-resolve";

export type SimilarChannelsInput = { source?: string; limit?: number };

export type SimilarChannelsResult = {
  candidates: DiscoveredSource[];
  total_similar?: number;
  truncated: boolean;
};

/**
 * Telegram's own recommendations. With a source: channels similar to it,
 * returned as a ChatsSlice whose `count` exceeds what it serves — the rest is
 * Premium-only and no argument reaches it. Without a source: channels
 * recommended for the account from its own subscriptions, returned as a plain
 * Chats with no count. One TL method, and the mode follows the argument.
 */
export async function getSimilarChannels(
  input: SimilarChannelsInput,
): Promise<SimilarChannelsResult> {
  const limit = input.limit ?? MAX_ENRICHED_CANDIDATES;
  const index = await fetchDialogIndex();

  return withTelegram(async (client) => {
    const Api = await getApi();

    const request = input.source
      ? new Api.channels.GetChannelRecommendations({
          channel: (await resolveSource(client, index, input.source)).handle,
        })
      : new Api.channels.GetChannelRecommendations({});

    const reply = (await client.invoke(request)) as {
      chats?: unknown[];
      count?: unknown;
    };

    const chats = Array.from(reply.chats ?? []) as Record<string, unknown>[];
    const total = typeof reply.count === "number" ? reply.count : undefined;

    const kept = chats.slice(0, limit);
    const details = await enrichCandidates(client, kept);
    const candidates = kept.map((entity, i) =>
      toCandidate(entity, index, details[i]),
    );

    const fit = fitToSizeCap(candidates, (shown) => ({
      candidates: shown,
      truncated: true,
    }));
    const shown = candidates.slice(0, fit);

    return {
      candidates: shown,
      ...(total !== undefined ? { total_similar: total } : {}),
      truncated:
        shown.length < chats.length ||
        (total !== undefined && total > shown.length),
    };
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/telegram-discovery.test.ts`
Expected: PASS, 23 tests.

- [ ] **Step 5: Prove the order guard is not vacuous**

Insert `candidates.sort((a, b) => (b.subscriber_count ?? 0) - (a.subscriber_count ?? 0))`
before the `fitToSizeCap` call. Confirm "never re-sorts Telegram's order" goes
red, then revert. Record it in the ledger.

- [ ] **Step 6: Run the gates and commit**

```bash
npm run test && npm run typecheck && npm run lint
npx prettier --write src/telegram/discovery.ts tests/telegram-discovery.test.ts
git add src/telegram/discovery.ts tests/telegram-discovery.test.ts
git commit -m "feat: get_similar_channels engine on channel recommendations"
```

---

### Task 5: Expose both tools

Spec §5. The descriptions are the deliverable here, not the plumbing: §4
measured that `contacts.search` matches names rather than topics, so a
description that lets the model read it as a topical search engine turns a
too-short query into "there are no such channels".

**Files:**
- Create: `src/mcp/tools/search-channels.ts`
- Create: `src/mcp/tools/get-similar-channels.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/mcp/version.ts`, `package.json`
- Test: `tests/tools.test.ts`, `tests/mcp-handler.test.ts`

**Interfaces:**
- Consumes: `searchChannels`, `getSimilarChannels` from Tasks 3-4; `runTool` from `src/mcp/tool-result.ts`; `OUTSIDE_SOURCE_GUIDANCE` from `src/mcp/source-guidance.ts`; the schemas from Task 1.
- Produces: `registerSearchChannels(server)`, `registerGetSimilarChannels(server)`.

- [ ] **Step 1: Write the failing tests**

In `tests/tools.test.ts`, add `"get_similar_channels"` and `"search_channels"`
to the `READ_ONLY` array (it is sorted; keep it sorted), rename the test
`"registers all eleven tools"` to `"registers all thirteen tools"`, and add both
names to the `sourceTools` list in the outside-source-guidance test. Then add:

```ts
it("tells callers that search_channels matches names, not topics", () => {
  // Measured 2026-08-28: q="AI" returns nothing while q="artificial
  // intelligence" returns nine channels. A model that reads this tool as a
  // topical search engine reports that no such channels exist.
  const server = fakeServer();
  registerTools(server as never);
  const tool = server.tools.find((t) => t.name === "search_channels")!;
  const description = String(tool.config.description);
  expect(description).toContain("by name");
  expect(description).toContain("not by topic");
  expect(description).toContain("get_similar_channels");
});

it("says that similar channels are capped and not rankable by the server", () => {
  const server = fakeServer();
  registerTools(server as never);
  const tool = server.tools.find((t) => t.name === "get_similar_channels")!;
  const description = String(tool.config.description);
  expect(description).toContain("Premium");
  expect(description).toContain("never re-ranked");
});
```

In `tests/mcp-handler.test.ts`, add `"get_similar_channels"` and
`"search_channels"` to the exact sorted set, rename the test to
`"advertises all thirteen tools"`, and change the version assertion to
`expect(MCP_SERVER_VERSION).toBe("1.2.0")`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/tools.test.ts tests/mcp-handler.test.ts`
Expected: FAIL — the tool sets do not match and the version is `1.1.0`.

- [ ] **Step 3: Register `search_channels`**

Create `src/mcp/tools/search-channels.ts`:

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { searchChannels } from "../../telegram/discovery";
import { searchChannelsResultSchema } from "../../schemas/discovery";
import { runTool } from "../tool-result";
import { OUTSIDE_SOURCE_GUIDANCE } from "../source-guidance";

export function registerSearchChannels(server: McpServer): void {
  server.registerTool(
    "search_channels",
    {
      title: "Find public Telegram channels",
      description:
        `Find public Telegram channels by name. This searches titles and @usernames, not by topic: "AI" finds nothing while "artificial intelligence" finds channels whose name contains it. An empty result usually means the query was too short or abbreviated, NOT that no such channels exist — retry with the full name, or call get_similar_channels from a channel you already know, which is the better tool for "find me more like this". Telegram caps this at 10 candidates and offers no pagination or cursor; truncated says whether it capped. Order is Telegram's own and is never re-ranked, with channels this account already follows first. Each candidate carries verified, scam, fake and restricted so you can judge it before recommending it, and joined says whether the account already follows it. Inspect a candidate with get_pinned_messages or get_messages before trusting it. ${OUTSIDE_SOURCE_GUIDANCE} This tool joins nothing and changes nothing. Read-only.`,
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe(
            "Words from the channel's name or its @username. Not a topic: use the fullest name you know.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe("How many candidates to return. 1-10, default 10."),
      }),
      outputSchema: searchChannelsResultSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => runTool("search_channels", () => searchChannels(input)),
  );
}
```

- [ ] **Step 4: Register `get_similar_channels`**

Create `src/mcp/tools/get-similar-channels.ts`:

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getSimilarChannels } from "../../telegram/discovery";
import { similarChannelsResultSchema } from "../../schemas/discovery";
import { runTool } from "../tool-result";
import { OUTSIDE_SOURCE_GUIDANCE } from "../source-guidance";

export function registerGetSimilarChannels(server: McpServer): void {
  server.registerTool(
    "get_similar_channels",
    {
      title: "Telegram's own channel recommendations",
      description:
        `Telegram's own recommendations. With source, it returns channels similar to that one. Without source, it returns channels recommended for this whole account from everything it already follows — that is the tool for "what else should I be reading". total_similar is how many similar channels Telegram knows about; only about 10 are served and the rest need Telegram Premium, so no argument reaches them and truncated says so. Order is Telegram's own and is never re-ranked: read candidates with get_messages or get_pinned_messages and pick the best yourself. Each candidate carries verified, scam, fake and restricted, and joined says whether the account already follows it. ${OUTSIDE_SOURCE_GUIDANCE} This tool joins nothing and changes nothing. Read-only.`,
      inputSchema: z.object({
        source: z
          .string()
          .optional()
          .describe(
            "The channel to find neighbours of — marked id, @username, or t.me link. Omit it to get recommendations for the whole account.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe("How many candidates to return. 1-10, default 10."),
      }),
      outputSchema: similarChannelsResultSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      runTool("get_similar_channels", () => getSimilarChannels(input)),
  );
}
```

- [ ] **Step 5: Wire them up and bump the version**

In `src/mcp/server.ts`, add the two imports and two calls after
`registerGetPinnedMessages(server);`:

```ts
import { registerGetSimilarChannels } from "./tools/get-similar-channels";
import { registerSearchChannels } from "./tools/search-channels";
```

```ts
  registerSearchChannels(server);
  registerGetSimilarChannels(server);
```

Set `MCP_SERVER_VERSION` in `src/mcp/version.ts` to `"1.2.0"` and `version` in
`package.json` to `"1.2.0"`. The handler test pins them to each other.

- [ ] **Step 6: Run the tests**

Run: `npm run test`
Expected: PASS — thirteen tools in both the registration test and the live
handler test.

- [ ] **Step 7: Run the gates and commit**

```bash
npm run typecheck && npm run lint
npx prettier --write src/mcp/tools/search-channels.ts src/mcp/tools/get-similar-channels.ts src/mcp/server.ts src/mcp/version.ts tests/tools.test.ts tests/mcp-handler.test.ts
git add src/mcp/tools/search-channels.ts src/mcp/tools/get-similar-channels.ts src/mcp/server.ts src/mcp/version.ts package.json tests/tools.test.ts tests/mcp-handler.test.ts
git commit -m "feat: expose search_channels and get_similar_channels"
```

---

### Task 6: The live tier

Spec §10, and the task that closes the one risk §6 names: `entityUsernames`
keeps only `usernames[]` entries with `active === true`, and the probe did not
record whether `contacts.search` sets that flag. If it does not, every
collectible-handle candidate ships with no username — no durable handle at all.
A fake cannot answer this; only the real account can.

**Files:**
- Create: `tests/live/discovery.live.test.ts`
- Modify (only if the risk lands): `src/telegram/peer-id.ts`

**Interfaces:**
- Consumes: `searchChannels`, `getSimilarChannels`.
- Produces: nothing importable.

- [ ] **Step 1: Write the live suite**

Create `tests/live/discovery.live.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { searchChannels, getSimilarChannels } from "@/telegram/discovery";
import { fetchDialogIndex } from "@/telegram/dialog-index";

const enabled = process.env.GRAMSCOPE_LIVE === "1";
const suite = enabled ? describe : describe.skip;

// House rule for this file: an assertion inside a `for` over a fetched list
// proves nothing when the list is empty, and an empty list is exactly what a
// broken query returns. Every loop below is preceded by an assertion (or a
// visible ctx.skip) on the length of what it iterates.
suite("Discovery against the real account", () => {
  beforeAll(() => {
    if (!process.env.TELEGRAM_SESSION) {
      throw new Error("TELEGRAM_SESSION is required for live tests");
    }
  });

  it("finds public channels by name", async () => {
    // Measured 2026-08-28 to return ten channels on this account. A one-word
    // abbreviation would return nothing and prove only that the tool runs.
    const { candidates } = await searchChannels({ query: "нейросети" });
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.id).toBeTruthy();
      expect(candidate.title).toBeTruthy();
      expect(typeof candidate.joined).toBe("boolean");
    }
  });

  it("gives every found channel a usable @username", async () => {
    // The §6 risk. contacts.search returns username: null for collectible
    // handles; if entityUsernames drops them for want of `active`, a candidate
    // ships with no durable handle and get_messages cannot read it later.
    const { candidates } = await searchChannels({ query: "нейросети" });
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.username, candidate.title).toBeTruthy();
      expect(candidate.url).toBe(`https://t.me/${candidate.username}`);
    }
  });

  it("describes at least one found channel", async () => {
    const { candidates } = await searchChannels({ query: "нейросети" });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some((c) => (c.description ?? "").length > 0)).toBe(true);
  });

  it("recommends neighbours of a channel the account follows", async () => {
    const index = await fetchDialogIndex();
    const seed = [...index.byId.values()].find((entry) => entry.username);
    expect(seed, "the account follows no channel with a username").toBeTruthy();

    const result = await getSimilarChannels({ source: `@${seed!.username}` });
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.total_similar).toBeGreaterThan(result.candidates.length);
    expect(result.truncated).toBe(true);
  });

  it("recommends channels for the account as a whole", async () => {
    const { candidates, total_similar } = await getSimilarChannels({});
    expect(candidates.length).toBeGreaterThan(0);
    expect(total_similar).toBeUndefined();
  });

  it("never spends more than the flood ceiling of full-channel calls", async () => {
    // Two calls back to back is the shape that floods. The second must be
    // measurably faster than a cold ten-request fan-out because the instance
    // cache answers the overlap.
    const first = Date.now();
    await getSimilarChannels({});
    const cold = Date.now() - first;
    const second = Date.now();
    await getSimilarChannels({});
    const warm = Date.now() - second;
    expect(warm).toBeLessThan(cold);
  });

  it("reports joined for a candidate the account already follows", async (ctx) => {
    const { candidates } = await getSimilarChannels({});
    expect(candidates.length).toBeGreaterThan(0);
    const held = candidates.filter((c) => c.joined);
    // Skip visibly rather than pass silently: recommendations are mostly
    // channels the account does NOT follow, and a green tick over an empty
    // list would be mistaken for evidence that `joined` works.
    if (held.length === 0) {
      ctx.skip();
      return;
    }
    const index = await fetchDialogIndex();
    for (const candidate of held) {
      expect(index.byId.has(candidate.id)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run it**

Run: `GRAMSCOPE_LIVE=1 npx vitest run tests/live/discovery.live.test.ts`
Expected: PASS, 7 tests, at most the one visible `ctx.skip`.

- [ ] **Step 3: If the username test fails, widen the mapper**

Only if "gives every found channel a usable @username" goes red. In
`src/telegram/peer-id.ts`, `entityUsernames` currently requires
`candidate.active === true`. Change that condition to accept an entry whose
`active` is absent, while still rejecting an explicit `active: false`:

```ts
        (candidate as { active?: unknown }).active !== false &&
```

Then add a unit test in `tests/telegram-peer-id.test.ts` pinning all three
cases — `active: true` kept, `active` absent kept, `active: false` dropped —
because a widened predicate that nothing pins is the next silent regression.
Re-run both the fast tier and this live test.

- [ ] **Step 4: Run the whole live tier**

Run: `GRAMSCOPE_LIVE=1 npm run test:live`
Expected: all four suites green, no skips beyond the one above. This proves
discovery did not regress sub-projects 1-3, which share the dialog index and
the resolver.

- [ ] **Step 5: Run the gates and commit**

```bash
npm run test && npm run typecheck && npm run lint
npx prettier --write tests/live/discovery.live.test.ts
git add tests/live/discovery.live.test.ts
git commit -m "test: live tier for discovery"
```

---

### Task 7: Deploy and accept

Spec §11. Nothing has been pushed before this task; a push to `main` deploys.

**Files:** none.

- [ ] **Step 1: Re-run every gate on the exact tree to be pushed**

```bash
npm run test && npm run typecheck && npm run lint && npm run build
git checkout -- tsconfig.json
git status --short
```
Expected: all green, and a clean tracked tree — `npm run build` rewrites
`tsconfig.json` and that churn is never committed.

- [ ] **Step 2: Push**

```bash
git push origin main
```

- [ ] **Step 3: Confirm the deployment is live**

Wait for the Vercel production deployment to reach `Ready`, then:

```bash
curl -s -i https://gramscope.vercel.app/api/mcp | head -20
curl -s https://gramscope.vercel.app/.well-known/oauth-protected-resource
```
Expected: `401` with a `WWW-Authenticate: Bearer` challenge naming
`resource_metadata`, and the metadata document naming
`https://gramscope.vercel.app/api/mcp` with the AuthKit issuer. Record
both, plus the deployment URL, in the ledger.

- [ ] **Step 4: Owner acceptance in the ChatGPT connector**

The tool descriptions changed, so the connector must be **reconnected** before
this runs — a stale connector serves the old list. Ask the owner to reconnect
and then run the brief's discovery scenario:

> I like this channel. Find similar channels, inspect their recent posts, and recommend the best three.

Acceptance is met when `tools/list` shows thirteen tools, the scenario completes
without the owner opening Telegram, and a candidate handed to `get_messages` by
its `@username` reads successfully. Record what the connector actually returned
— tool count, candidate count, whether descriptions arrived — in the ledger and
on the card.

- [ ] **Step 5: Request the whole-implementation review**

Sub-project 3's per-task reviews all missed three defects that lived across
module boundaries; only a reviewer reading the whole diff found them. Dispatch
`superpowers:requesting-code-review` over the full sub-project 4 range before
declaring it complete.

---

## Self-Review

**Spec coverage.** §5.1 → Tasks 3, 5. §5.2 → Tasks 4, 5. §6 → Tasks 1, 6
(the `active` risk). §7 → Task 2. §8 errors → Task 3 (`INVALID_INPUT`), Task 4
(resolver errors reach the caller through `runTool` unchanged, which is how
every other tool handles them). §9 files → the File Structure table. §10
testing → Tasks 1-4 (fast) and 6 (live). §11 acceptance → Task 7.

**Type consistency.** `toCandidate`, `enrichCandidates`, `searchChannels`,
`getSimilarChannels`, `MAX_ENRICHED_CANDIDATES`, `DISCOVERY_ENRICH_CONCURRENCY`
and `__resetDiscoveryCacheForTests` are named identically in every task that
defines or consumes them. The response shapes in Tasks 3 and 4 match
`searchChannelsResultSchema` and `similarChannelsResultSchema` from Task 1
field for field.

**One deliberate deviation from the spec's wording.** §7 says the engine builds
`InputChannel` from the id and access hash it holds. The plan passes the wire
`Api.Channel` entity to the existing `fetchChannelDetails` instead, which
teleproto converts to an `InputChannel` itself. Same number of round trips, same
absence of a resolution step, and it reuses the single existing `getFullChannel`
call site rather than opening a second one.
