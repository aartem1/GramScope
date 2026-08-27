import {
  getApi,
  resolveEntity,
  withTelegram,
  type TelegramLike,
} from "./client";
import { fetchDialogIndex } from "./dialog-index";
import { fetchChannelDetails, foldersByPeer, toSource } from "./dialogs";
import { parseTelegramName, resolveSource } from "./peer-resolve";
import { entityMarkedId, sourceType } from "./peer-id";
import { GramScopeError } from "../errors/taxonomy";

export type ResolvedUrl = {
  kind: "source" | "post" | "invite";
  source?: {
    source_id?: string;
    title: string;
    username?: string;
    type: "channel" | "group" | "chat";
    subscriber_count?: number;
    linked_discussion_id?: string;
    joined: boolean;
    folder_ids?: string[];
  };
  message_id?: number;
  comment_id?: number;
};

/**
 * messages.checkChatInvite previews a private chat without joining it. A
 * preview carries no usable peer, so source_id is absent unless the account is
 * already a member — in which case Telegram returns the chat itself.
 */
async function previewInvite(
  client: TelegramLike,
  hash: string,
  joinedIds: Set<string>,
  folderIndex: Map<string, string[]>,
): Promise<ResolvedUrl> {
  const Api = await getApi();
  const raw = (await client.invoke(
    new Api.messages.CheckChatInvite({ hash }),
  )) as Record<string, unknown> | undefined;
  const invite = raw ?? {};

  const chat = invite.chat as Record<string, unknown> | undefined;
  if (chat) {
    // ChatInviteAlready or ChatInvitePeek: a real entity came back.
    const source = toSource(chat, folderIndex);
    return {
      kind: "invite",
      source: {
        ...(source.id ? { source_id: source.id } : {}),
        title: source.title,
        ...(source.username !== undefined ? { username: source.username } : {}),
        type: source.type,
        ...(source.subscriber_count !== undefined
          ? { subscriber_count: source.subscriber_count }
          : {}),
        joined: source.id ? joinedIds.has(source.id) : false,
        ...(source.folder_ids ? { folder_ids: source.folder_ids } : {}),
      },
    };
  }

  const title = typeof invite.title === "string" ? invite.title : "";
  const count =
    typeof invite.participantsCount === "number"
      ? invite.participantsCount
      : undefined;
  return {
    kind: "invite",
    source: {
      title,
      // An invite preview is not an entity, so sourceType cannot read it: the
      // flags are what Telegram gives here.
      type:
        invite.megagroup === true
          ? "group"
          : invite.broadcast === true || invite.channel === true
            ? "channel"
            : "chat",
      ...(count !== undefined ? { subscriber_count: count } : {}),
      joined: false,
    },
  };
}

export async function resolveTelegramUrl(input: {
  url: string;
}): Promise<ResolvedUrl> {
  const link = parseTelegramName(input.url);
  // fetchDialogIndex fetches the folders itself; calling fetchFolders again
  // here would be a second round trip for the same list.
  const index = await fetchDialogIndex();
  const folderIndex = foldersByPeer(index.folders);

  return withTelegram(async (client) => {
    if (link.kind === "invite") {
      return previewInvite(
        client,
        link.hash,
        new Set(index.byId.keys()),
        folderIndex,
      );
    }

    const resolved = await resolveSource(client, index, input.url);
    const entity =
      resolved.entity ?? (await resolveEntity(client, resolved.handle));
    if (entityMarkedId(entity) === undefined) {
      throw new GramScopeError(
        "CHANNEL_NOT_FOUND",
        `Could not resolve ${input.url} to a Telegram peer`,
      );
    }

    // The ONE getFullChannel of this call. Broadcast channels and megagroups
    // carry their subscriber count and linked group only here; a failure costs
    // those two fields, never the call.
    const details =
      sourceType(entity) === "channel" || sourceType(entity) === "group"
        ? await fetchChannelDetails(client, entity).catch(() => ({}))
        : {};

    const source = toSource(entity, folderIndex, {
      id: resolved.source_id,
      title: resolved.title,
      ...details,
    });

    return {
      kind: link.messageId !== undefined ? "post" : "source",
      source: {
        source_id: source.id,
        title: source.title,
        ...(source.username !== undefined ? { username: source.username } : {}),
        type: source.type,
        ...(source.subscriber_count !== undefined
          ? { subscriber_count: source.subscriber_count }
          : {}),
        ...(source.linked_discussion_id !== undefined
          ? { linked_discussion_id: source.linked_discussion_id }
          : {}),
        joined: index.byId.has(source.id),
        ...(source.folder_ids ? { folder_ids: source.folder_ids } : {}),
      },
      ...(link.messageId !== undefined ? { message_id: link.messageId } : {}),
      ...(link.commentId !== undefined ? { comment_id: link.commentId } : {}),
    };
  });
}
