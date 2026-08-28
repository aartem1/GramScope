import { getApi, resolveEntity, withTelegram } from "./client";
import { fetchDialogIndex } from "./dialog-index";
import { fetchChannelDetails, foldersByPeer, toSource } from "./dialogs";
import { resolveSource } from "./peer-resolve";
import { peerKind } from "./peer-id";
import { GramScopeError } from "../errors/taxonomy";
import type { TelegramSource } from "../schemas/source";

export type JoinChannelResult = {
  source: TelegramSource;
  already_member: boolean;
};

/**
 * Subscribes to one public channel.
 *
 * The entity is resolved once, and its kind is checked BEFORE the membership
 * branch: kind is a property of the target, not of membership, so a held DM
 * (a bare numeric id resolves for any chat the account already belongs to,
 * private ones included) is rejected exactly like an unheld one instead of
 * short-circuiting into a silent already_member success.
 *
 * Membership is decided from the dialog index BEFORE any TL call, not from
 * Telegram's answer: channels.JoinChannel on a channel the account already
 * follows is a silent no-op, so asking Telegram could not tell the two cases
 * apart, and skipping the call keeps a re-join off the write path entirely.
 *
 * Invite links are out of scope (spec §3): they need their own preview and
 * error semantics, and every flow that feeds this tool — search_channels,
 * get_similar_channels, resolve_telegram_url — yields a username.
 */
export async function joinChannel(input: {
  source: string;
}): Promise<JoinChannelResult> {
  const index = await fetchDialogIndex();
  const folderIndex = foldersByPeer(index.folders);

  return withTelegram(async (client) => {
    // resolveSource rejects an invite link with INVALID_INPUT of its own.
    const resolved = await resolveSource(client, index, input.source);
    const entity =
      resolved.entity ?? (await resolveEntity(client, resolved.handle));

    if (peerKind(entity) !== "channel") {
      throw new GramScopeError(
        "INVALID_INPUT",
        `${input.source} is not a channel or group. join_channel subscribes to channels and groups; there is nothing to join for a private chat.`,
      );
    }

    if (index.byId.has(resolved.source_id)) {
      const details = await fetchChannelDetails(client, entity).catch(
        () => ({}),
      );
      return {
        source: toSource(entity, folderIndex, {
          id: resolved.source_id,
          title: resolved.title,
          ...details,
        }),
        already_member: true,
      };
    }

    const Api = await getApi();
    await client.invoke(
      new Api.channels.JoinChannel({ channel: entity as never }),
    );

    const details = await fetchChannelDetails(client, entity).catch(() => ({}));
    return {
      source: toSource(entity, folderIndex, {
        id: resolved.source_id,
        title: resolved.title,
        ...details,
      }),
      already_member: false,
    };
  });
}
