import { getApi, resolveEntity, withTelegram } from "./client";
import { fetchDialogIndex } from "./dialog-index";
import { fetchChannelDetails, foldersByPeer, toSource } from "./dialogs";
import { resolveSource } from "./peer-resolve";
import { peerKind, sourceType } from "./peer-id";
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

export type LeaveChannelResult = {
  source: TelegramSource;
  was_member: boolean;
};

/**
 * Unsubscribes from one source, one per call (spec §4.3): a single injected
 * "leave everything" then costs one visible tool call per source instead of
 * one call total.
 *
 * The echoed source is the pre-leave state on purpose. After the call the
 * account may hold nothing to describe, and what the caller needs to see is
 * which object was actually left.
 */
export async function leaveChannel(input: {
  source: string;
}): Promise<LeaveChannelResult> {
  const index = await fetchDialogIndex();
  const folderIndex = foldersByPeer(index.folders);

  return withTelegram(async (client) => {
    const resolved = await resolveSource(client, index, input.source);
    const entity =
      resolved.entity ?? (await resolveEntity(client, resolved.handle));

    const details =
      sourceType(entity) === "channel" || sourceType(entity) === "group"
        ? await fetchChannelDetails(client, entity).catch(() => ({}))
        : {};
    const source = toSource(entity, folderIndex, {
      id: resolved.source_id,
      title: resolved.title,
      ...details,
    });

    // The kind check comes BEFORE the membership check on purpose. Being a
    // legacy chat is a property of the target, not of membership: answering
    // `was_member: false` for one would imply the tool would have worked had
    // the account been a member, which is not true — leaving a legacy chat is
    // messages.DeleteChatUser, a different call this sub-project does not make.
    if (peerKind(entity) !== "channel") {
      throw new GramScopeError(
        "INVALID_INPUT",
        `${input.source} is a ${source.type}, not a channel or supergroup. leave_channel unsubscribes from channels and groups only.`,
      );
    }

    if (!index.byId.has(resolved.source_id)) {
      return { source, was_member: false };
    }

    const Api = await getApi();
    await client.invoke(
      new Api.channels.LeaveChannel({ channel: entity as never }),
    );

    return { source, was_member: true };
  });
}
