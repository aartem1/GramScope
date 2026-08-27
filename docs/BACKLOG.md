# GramScope Backlog

This document is a parking lot for ideas worth preserving but **not committed to the roadmap**. Items here may be explored, changed, split, or dropped later. Active work continues to live under `docs/superpowers/`.

## Channel discovery beyond subscribed sources

**Idea:** let GramScope discover relevant Telegram channels outside the owner's current subscriptions, then inspect and rank them using the same Telegram-reading capabilities as subscribed channels.

### Why

A subscribed-source-only model has an obvious blind spot: the owner must already know which channels are worth following. Discovery should help answer questions such as:

- "Find good Telegram channels about AI."
- "Are there newer or better channels than the ones I already follow?"
- "Which channels repeatedly publish useful material about Claude Code / OpenAI / agents?"
- "Find related channels to this one."

### Preferred discovery layers

1. **Telegram-native discovery — preferred first layer**
   - Global public-post search (`channels.searchPosts`) can find relevant posts across public channels, not only subscribed sources.
   - Channel recommendations (`channels.getChannelRecommendations`) can expand from a known useful channel to related channels.
   - Possible flow: search several topic queries → collect unique channels → inspect recent content with GramScope → rank → expand top results through recommendations.
   - Likely advantage: fresher and less dependent on a third-party catalogue.

2. **Telemetr / Telemetrio — strong external catalogue candidate**
   - Structured catalogue and message search.
   - Useful filters may include language, country, category, audience metrics and public/private status.
   - Potentially useful for discovering channels Telegram-native search does not surface directly.
   - Validate current API availability, pricing and exact coverage before implementation.

3. **TGStat — strong external candidate, especially for RU/CIS Telegram**
   - Channel catalogue, keyword/category search and post search.
   - Good candidate for an independent discovery/ranking signal.
   - Validate API-plan requirements and limits before implementation.

4. **Secondary/fallback sources**
   - TelegramChannels.me — simple searchable catalogue/API candidate.
   - Nicegram Hub — structured web catalogue; likely usable as a web fallback if no stable API is available.
   - Telega.in — advertising marketplace; potentially useful as a secondary quality/activity signal, but biased toward monetized channels.
   - Other public catalogues (`list.tg`, `catalog.tg`, etc.) only if they add meaningful coverage.

### Private channels: constraint

There is no general mechanism to enumerate arbitrary private Telegram channels. A private channel without a public username is normally discoverable only through an invite/access path. GramScope can fully analyse a private channel only when its Telegram account already has access.

External catalogues may know about some private channels and can therefore provide partial discovery metadata, but this must not be treated as complete Telegram-wide private-channel search or as a way to bypass access controls.

### Possible future MCP surface

Names are illustrative, not API decisions:

- `discover_channels(query, language?, country?, limit?)`
- `similar_channels(channel)`
- `search_public_posts(query, period?)`
- `discover_private_channels(query)` — external-catalogue metadata only, with explicit accessibility state

The agent should ideally receive normalized candidates with provenance, then use GramScope itself to inspect recent content and rank usefulness rather than trusting catalogue rankings directly.

### Suggested implementation order if this is ever promoted

1. Prototype Telegram-native `searchPosts` + `getChannelRecommendations`.
2. Measure discovery quality and API/quota constraints.
3. Add **one** external catalogue only if it materially improves recall or filtering (Telemetr/Telemetrio first candidate; TGStat second).
4. Add more catalogues only based on demonstrated coverage gaps.

### Research references

- Telegram `channels.searchPosts`: https://core.telegram.org/method/channels.searchPosts
- Telegram `channels.getChannelRecommendations`: https://core.telegram.org/method/channels.getChannelRecommendations
- Telemetr API: https://api.telemetr.io/
- TGStat API: https://api.tgstat.ru/docs/
- TelegramChannels.me API: https://telegramchannels.me/api-doc
- Nicegram Hub: https://nicegram.app/hub/
- Telega.in catalogue: https://telega.in/catalog

## Threads as a public discovery source

**Idea:** add Threads as a second high-quality public information source, focused on agent-driven search over public posts rather than subscriptions.

### Why it fits

The official Threads API supports public keyword/topic search, so GramScope could answer questions such as:

- "What are people on Threads saying about GPT-6 in the last hour?"
- "Summarize the main reactions to this launch over the last day."
- "Find recent Threads posts about Claude Code from the last week."

This does not require following the authors first. The useful model is on-demand public discovery rather than maintaining a subscription graph.

### Expected integration shape

A minimal future tool could look like:

- `search_threads(query, from?, to?, sort?, limit?)`

The adapter should return normalized post data such as text, author, timestamp, permalink and source metadata. The agent can run several simple searches for a broader topic, merge and deduplicate results, then perform its own semantic ranking and summarization.

### Access and operational constraints

- Official Meta Threads API; no browser scraping should be required.
- Requires a Meta developer app, a Threads account/profile and OAuth.
- Public keyword search requires the relevant Threads search permission and, for production use across other users' public content, Meta Advanced Access / App Review.
- Long-lived access tokens still require lifecycle management and refresh.
- API usage is currently not priced per request, but rate limits and permission requirements must be revalidated before implementation because Meta can change them.
- Current search supports recent/top-style discovery and time-bounded queries, which maps well to hour/day/week agent requests.

### Main risk

The technical adapter is relatively straightforward. The real dependency is **Meta approval**. Do not commit significant implementation effort until a small spike proves that the intended personal research/listening use case can obtain the required public keyword-search access.

### Suggested spike if this is promoted

1. Create a Threads-enabled Meta developer app.
2. Implement OAuth and obtain the required search permission.
3. Confirm public search works for posts outside the authorized user's own content.
4. Test practical queries over 1 hour, 1 day and 1 week windows.
5. Measure result quality, pagination behaviour and effective rate limits.
6. Only then design the permanent GramScope adapter.

### Research reference

- Meta Threads API collection: https://www.postman.com/meta/threads/collection/dht3nzz/threads-api
