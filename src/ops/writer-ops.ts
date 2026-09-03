/**
 * Operations that change account state. Read-only remote calls may retry once
 * on a connection failure; these never do.
 */
export const WRITER_OPERATIONS = [
  "join_channel",
  "leave_channel",
  "manage_folder",
  "mark_read",
  "mark_unread",
  "set_source_note",
] as const;

export type WriterOperation = (typeof WRITER_OPERATIONS)[number];

/** String array view for tests that compare against dynamic tool names. */
export const WRITER_OPERATION_NAMES: readonly string[] = WRITER_OPERATIONS;

const WRITER_SET = new Set<string>(WRITER_OPERATIONS);

export function isWriterOperation(op: string): boolean {
  return WRITER_SET.has(op);
}
