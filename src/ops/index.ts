export { createDispatcher } from "./dispatch";
export type { OperationDefinition, OperationRegistry } from "./dispatch";
export { operationNames } from "./registry";
export {
  DEFAULT_RPC_DEADLINE_MS,
  RPC_REQUEST_BODY_MAX_BYTES,
  gramScopeErrorFromWire,
  rpcErrorResponse,
  rpcRequestSchema,
  rpcSuccessResponse,
  serializeGramScopeError,
} from "./wire";
export type { RpcWireError } from "./wire";
export {
  dispatch,
  getChannel,
  getMedia,
  getMessage,
  getMessages,
  getPinnedMessages,
  getSimilarChannels,
  getThread,
  getUnreadSummary,
  joinChannel,
  leaveChannel,
  listDialogs,
  listFolders,
  listSourceNotes,
  manageFolder,
  markRead,
  markUnread,
  resolveTelegramUrl,
  searchChannels,
  searchMessages,
  setSourceNote,
} from "./client";
export type { MediaOutcome } from "./client";
export * from "./schemas";
