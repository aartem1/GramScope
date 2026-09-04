# GramScope Source Notes — design

Sub-project 5b, and the last one. Slug `gramscope-mcp`. Branch `main` — the
owner works directly on `main` until the project is fully launched. Card:
`docs/superpowers/tasks/gramscope-mcp.md`. Predecessor spec:
`docs/superpowers/specs/2026-08-28-gramscope-writes-design.md`.

This spec replaces two pieces of earlier planning at once, by owner decision on
2026-08-29. See §4.

## 1. Problem

Seventeen tools are deployed. The agent can find a channel, read it without
joining, join it, file it into a folder and leave it again. What it cannot do
is remember anything it learned by reading.

Folders are the only durable classification the account has, and a folder is a
coarse instrument: it says a source belongs to Business or Long Reads and
nothing more. So when a specific question arrives — one whose answer does not
fall out of the folder taxonomy — the agent has to choose which of 58 sources
to read with nothing to go on but their titles. Choosing a source by its title
is exactly the inference the rest of this project refuses to make: a channel's
name is a claim about itself, not a description of what it publishes.

Every session therefore re-derives the same knowledge — what this channel
actually covers, how often it posts, whether it reports or aggregates — reads
it out of the same posts, and throws it away at the end.

## 2. Required outcome

Two tools on the deployed server, callable from ChatGPT:

| Tool               | Purpose                                                        |
| ------------------ | -------------------------------------------------------------- |
| `set_source_note`  | Write or delete the one note GramScope keeps about one source  |
| `get_source_notes` | Read the notes: all of them, a named subset, or a topic search |

Nineteen tools total after this sub-project. Version 1.4.0.

The outcome is not "the agent can store text." It is that at question time one
call returns a routing table — which source covers what, and how much that
source is worth — small enough to read whole before deciding where to look.

## 3. Scope and non-goals

In scope: the two tools; the Saved Messages storage layer beneath them; the
README rewrite that §4 makes necessary; the ChatGPT Project instructions
update that any change to accepted tool input requires.

**Out of scope — forwarding posts into Saved Messages.** The README's §H
`save_message` ("prefer native forwarding/saving semantics so the original
source remains traceable") describes a feature the owner rejected outright on
2026-08-29. Saved Messages hold GramScope's own notes and nothing else. A
store that also accumulates forwarded posts is the "dump" (translation of the
owner's wording) that the owner named as the one thing this must not become.

**Out of scope — a processed/unprocessed status on notes.** A note is current
knowledge about a source, not a work item. There is no queue to drain.

**Out of scope — notes that are not about a source.** A free-form entry keyed
by topic rather than by source is unbounded in number: it grows with every
question asked, and nothing ever retires one. One note per source is bounded by
the account's inventory, which is the property that makes the store compact by
construction rather than by discipline.

**Out of scope — a third tool for search.** `get_source_notes(query)` answers
it. Sub-project 5a already rejected a second tool that answers the same
question as an existing one, because the cost is paid on every `tools/list`.

**Out of scope — surfacing note coverage in `list_dialogs`.** Which sources
lack a note is the difference of two lists the agent can already fetch. A
`has_note` field would put a cost on every dialog listing to save one call.

## 4. What this supersedes

**Sub-project 6 is absorbed here.** The private `Source Meta` channel described
in the README will not be created, and `get_channel_note` / `set_channel_note`
will not ship against it. The owner chose Saved Messages as the single store on
2026-08-29, knowing the trade: a channel guarantees unrestricted in-place
editing of one's own posts, while Saved Messages needs no channel to create, no
channel id in config, and no "the channel does not exist yet" path. §7 handles
the editing risk directly.

There is therefore no sub-project 6. This spec closes the project's tool
roadmap.

**Three README tool names disappear.** `save_message`, `get_saved_messages` and
`search_saved_messages` described a bookmark archive. The two tools here
replace all three, and the README sections that describe the archive, the
`Source Meta` channel, and the five superseded tool names are rewritten as part
of this work rather than left to contradict the shipped server.

## 5. The note model

One note per source, addressed by the source's identifier, overwritten in
place. The number of notes equals the number of sources the agent has formed an
opinion about; it does not grow with the number of questions asked.

| Field          | Origin                           | Required                | Cap                              |
| -------------- | -------------------------------- | ----------------------- | -------------------------------- |
| `id`           | server, from the resolved entity | yes                     | marked id, e.g. `-1002222222222` |
| `handle`       | server, from the resolved entity | when the source has one | —                                |
| `title`        | server, from the resolved entity | yes                     | —                                |
| `about`        | agent                            | yes                     | 300 characters                   |
| `topics`       | agent                            | yes, at least one       | 12 items, 32 characters each     |
| `kind`         | agent                            | yes                     | enum, below                      |
| `lang`         | agent                            | no                      | 16 characters                    |
| `cadence`      | agent                            | no                      | 32 characters                    |
| `derived_from` | agent                            | no                      | 60 characters                    |
| `updated`      | server, date of the write        | yes                     | ISO date                         |

`id`, `handle` and `title` are filled by the server from the entity it
resolved, never from what the caller sent. This is sub-project 5a's rule that a
write addresses a target by identifier and echoes the resolved object; a note
whose title was supplied by the caller would record the caller's belief about
the source rather than the source.

`kind` is one of `reporting`, `aggregator`, `opinion`, `promo`, `mixed`. It
records what the source _is_ epistemically, and it is the field that changes how
its content is weighed later: an aggregator's post is a pointer, an opinion
channel's post is a claim by its author. The tool description must state that
`kind` is set from posts actually read, not from the channel's name or its
self-description — a channel calling itself an analytical review is making a
claim, and §8 of this spec is the reason that claim is not evidence.

`about` says what the source publishes, in one or two sentences, from reading
it. `topics` is the routing surface: the keyword list that `get_source_notes`
searches when the agent asks where to look for something.

`derived_from` records what the note was made from — a message id range, or a
phrase such as "last 40 posts". With `updated` it is how staleness becomes
visible: a note derived from forty posts in March says something different in
September than it did when written.

Every cap is enforced at input validation, and every rejection names the limit
it enforces. Sub-project 2 left an open finding that a rejection naming only
its error code tells an agent nothing about how to retry; this sub-project does
not repeat it.

## 6. Tool contracts

### 6.1 `set_source_note`

Input: `action` (`"set"` | `"delete"`), `source_id`, and on `set` the agent-side
fields of §5.

One source per call. Setting a note destroys the previous note for that source,
and sub-project 5a fixed the rule that batching is for non-destructive actions.

Output on `set`: the stored note, **re-read from Telegram after the write** and
parsed back, plus `replaced: boolean`. Echoing the input would confirm the
caller's intent; echoing the re-read confirms what the store now holds, which is
the only thing worth confirming.

Output on `delete`: `deleted: boolean` — `false` when there was no note, which
is a fact about the store and not an error. This mirrors `leave_channel`'s
`was_member`.

`readOnlyHint: false`. The tool joins `WRITERS` in `tests/tool-names.ts`.

A note may be written about a source the account has never joined. Search and
discovery reach channels the account has no membership in, and "this one is an
aggregator, not worth joining" is precisely the conclusion that should not have
to be re-derived. The source must resolve; membership is not required.

### 6.2 `get_source_notes`

Input: `source_ids?` (at most `MAX_SOURCES_PER_CALL`), `query?`, `limit?`
(default 100), `cursor?`.

`source_ids` is resolved by one marker search per id rather than by loading the
store and filtering it, so asking about three sources costs three lookups and
not the whole memory. It reuses `assertSourceIdsBounded` from
`src/telegram/source-selection.ts`, which sub-project 5a extracted for exactly
this shape of guard.

The cursor carries its own kind discriminator, distinct from every existing
one. A cursor minted by another tool must be rejected as `INVALID_CURSOR`, not
silently honoured into a wrong page.

With no arguments it returns the whole store. That is the primary mode — the
one call before deciding where to look — and the tool description says so.

`query` searches the note text through Telegram's own search over the account's
own chats, which sub-project 3 measured as free and paging cleanly, and which
the probe in §7 confirmed matches both a Russian word in a note body and a
source id in any of its written forms.

Output: `notes`, `duplicates`, `malformed`, and a cursor when the page was
capped. `readOnlyHint: true`.

## 7. Storage mechanics

Every rule in this section was measured against the live account on 2026-08-29
with a throwaway probe, not read from documentation. The findings are recorded
on the card under "Changes and findings".

**One message per note.** Line one is the marker `gs:src:<absolute value of
the marked id>` — `-1002222222222` gives `gs:src:1002222222222` — and the rest
is the note as a JSON object. The absolute value is used because the leading
minus is punctuation to Telegram's tokenizer; the signed id stays inside the
JSON, where it is the field every other tool joins on. The marker is separate from the
JSON for two reasons: Telegram's search matches it as a single token, so a note
is findable by source id without an index; and a message that does not begin
with it is not a note, which is how the reader tells notes from everything else
in the peer.

**Write with raw `Api.messages.SendMessage`, never `client.sendMessage`.**
teleproto's high-level send applies markdown parsing by default: the probe's
`**bold**` came back as `bold`, the asterisks consumed into an entity. A note
store that silently rewrites its own payload is worse than no note store. The
raw call with no `entities` round-trips the text byte-exact.

**Update with `Api.messages.EditMessage`, falling back to delete-and-resend.**
Editing the account's own Saved Messages works; the probe could only edit a
message seconds old, so whether Telegram's 48-hour edit window applies here is
unmeasured. The fallback is not decoration — it is the whole update path once a
note is a day old, if the window does apply.

**Filter reads by the marker.** The `me` peer holds service messages: this
account carries an undeletable `MessageActionHistoryClear`, which survived a
`DeleteMessages` with `revoke`. A reader that assumes every message is a note
breaks on the first one that is not.

**Never address a note by a stored message id.** After the probe deleted its
message, reading that same id returned a different object rather than nothing.
The marker is the only handle; a message id is valid for the duration of the
call that found it.

**Malformed notes are reported, not fatal.** A message that carries the marker
but whose JSON does not parse is returned in `malformed` with its message id and
a reason. One corrupt message must not deny the agent the rest of its memory.

**Duplicates are reported on read and collapsed on write.** An interrupted
delete-and-resend can leave two messages with the same marker, and serverless
execution makes that a real interruption rather than a theoretical one.
`get_source_notes` reports the duplicate and returns the newest; only
`set_source_note` deletes the extras, because it is already overwriting that
source's note and deleting stored data on a read path is not a thing this
server does.

## 8. Trust boundary

A note is GramScope's own derived text, not channel content — but it is derived
_from_ channel content, and it is read back later by an agent that no longer has
the posts in front of it. Two consequences.

A note must never be written as if it were the source's own words. `about` and
`kind` are the agent's assessment; the tool description says to write them from
posts read, and `derived_from` records what was read. A note that copies a
channel's self-description launders a claim into the store, where it will be
read back as GramScope's finding.

Notes are returned under their own tool and their own key. Nothing else in the
server returns them, so a caller cannot confuse a note with post text — which
is what keeps the server's existing content rule (`SERVER_INSTRUCTIONS`) intact
without adding a sentence to it. Server-wide guidance is stated once; this
sub-project adds no new shared sentence and repeats none of the existing ones
in its tool descriptions.

## 9. Errors

No new error codes. `INVALID_INPUT` covers every cap violation and names the
limit; `CHANNEL_NOT_FOUND` covers an unresolvable `source_id`; `RATE_LIMITED`
and `INTERNAL_ERROR` behave as everywhere else.

Absence is never an error: no note to delete returns `deleted: false`, and a
`get_source_notes` that matches nothing returns an empty `notes` array.

## 10. Files

New:

- `src/schemas/source-note.ts` — the note shape, the caps, the `kind` enum.
- `src/telegram/source-notes.ts` — serialize, parse, find by marker, upsert,
  delete, list, search. The only module that knows the wire format.
- `src/mcp/tools/set-source-note.ts`, `src/mcp/tools/get-source-notes.ts`.
- `tests/telegram-source-notes.test.ts`, `tests/live/source-notes.live.test.ts`.

Changed:

- `src/mcp/server.ts` — register two tools.
- `tests/tool-names.ts` — `set_source_note` joins `WRITERS`.
- `tests/tools.test.ts`, `tests/mcp-handler.test.ts` — the exact-set and
  `readOnlyHint` assertions.
- `README.md` — rewrite §H and the `Source Meta` and Saved Messages sections;
  drop the five superseded tool names; nineteen tools.
- `docs/chatgpt-project-instructions.md` — live prompt text of an existing
  ChatGPT Project. Two new tools change what the Project can call, so it is
  updated here and the owner re-pastes the marked region.
- `package.json`, `package-lock.json`, `src/mcp/version.ts` — 1.4.0. The
  lockfile is included because sub-project 5a's review established that both
  root version fields are part of the tested version invariant.

`src/telegram/client.ts` needs no change: send, edit and delete go through the
already-declared `invoke`, and reads through the already-declared `getMessages`.

## 11. Testing

Fast tier, against a fake client, is where the format lives or dies:

- byte-exact round-trip of a note whose text contains `**`, `_`, backticks and
  a JSON-significant quote — the regression the probe found in `sendMessage`;
- the marker filter rejecting a service message and an unmarked text message;
- a malformed note reported without failing the read;
- two messages sharing a marker: reported by the read, collapsed by the write;
- every cap rejected with the limit named in the message;
- `set` on a source with no note reporting `replaced: false`, and on one with a
  note reporting `true`;
- `delete` with no note reporting `deleted: false`.

Live tier, one new file, sequential under the existing `fileParallelism`
setting because it mutates the same account as every other live file. It writes
a note about a real source, re-reads it, searches for it by topic and by id,
overwrites it, deletes it, and **asserts Saved Messages is back to holding no
notes**. The account's baseline is zero notes plus the undeletable service
message, and the file must leave it there.

## 12. Acceptance criteria

1. `npm run test`, typecheck, lint and build green.
2. `npm run test:live` green, and Saved Messages left at baseline.
3. Production serves 1.4.0 and lists nineteen tools.
4. In the ChatGPT connector, end to end: pick a channel the account follows,
   read some of it, `set_source_note` about it, `get_source_notes()` with no
   arguments showing it among the rest, `get_source_notes(query)` on one of its
   topics finding it, then `set_source_note(delete)` and a final read showing it
   gone.
5. The README no longer names `save_message`, `get_saved_messages`,
   `search_saved_messages`, `get_channel_note` or `set_channel_note`, and no
   longer describes a `Source Meta` channel.

## 13. Open questions

None. The owner delegated the shape of a note explicitly ("think through the
best way to organize it; I don't know" [translation]), with one binding
constraint — the store stays compact and does not become a dump — which §5's
one-note-per-source model and §5's caps implement.

## 14. Decisions carried forward

This is the last sub-project, so these are for maintenance rather than for a
successor spec.

- The wire format is owned by one module. A format change is a migration of
  every stored note, and there is no versioning in the marker; if the format
  ever changes, the marker gains a version segment first.
- `messages.editMessage` beyond Telegram's edit window is still unmeasured on
  Saved Messages. The fallback path makes it not matter, but the first real
  note older than two days is the observation that settles it.
