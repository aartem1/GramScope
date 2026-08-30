/**
 * The tools that change account state, in one place.
 *
 * Two suites assert against this list — tools.test.ts, that registerTools
 * registers exactly the expected set, and mcp-handler.test.ts, that only these
 * carry `readOnlyHint: false` over a real MCP server. Kept here so tool
 * twenty moves one list rather than two that must agree.
 */
export const WRITERS = [
  "join_channel",
  "leave_channel",
  "manage_folder",
  "mark_read",
  "mark_unread",
  "set_source_note",
];
