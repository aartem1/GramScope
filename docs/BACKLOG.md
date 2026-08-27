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
