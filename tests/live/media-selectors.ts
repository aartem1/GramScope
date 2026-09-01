export const MEDIA_MESSAGE_KINDS = [
  "PHOTO",
  "IMAGE_DOCUMENT",
  "VIDEO",
  "OVERSIZED_VIDEO",
  "VIDEO_NOTE",
  "GIF",
  "VOICE",
  "LARGE_VOICE",
  "AUDIO",
  "DOCUMENT",
  "STICKER",
] as const;

export type MediaMessageKind = (typeof MEDIA_MESSAGE_KINDS)[number];

export type MediaLiveSelector = {
  sourceId: string;
  messageId: number;
};

export type MediaLiveSelection = {
  enabled: boolean;
  strict: boolean;
  selectors: Partial<Record<MediaMessageKind, MediaLiveSelector>>;
};

type Environment = Readonly<Record<string, string | undefined>>;

function value(environment: Environment, name: string): string | undefined {
  return environment[name]?.trim() || undefined;
}

function positiveMessageId(raw: string, name: string): number {
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

export function loadMediaLiveSelection(
  environment: Environment,
): MediaLiveSelection {
  const enabled = value(environment, "GRAMSCOPE_LIVE") === "1";
  const strict = value(environment, "GRAMSCOPE_LIVE_STRICT") === "1";
  if (!enabled) return { enabled: false, strict, selectors: {} };

  const sharedSource = value(environment, "GRAMSCOPE_LIVE_MEDIA_SOURCE");
  if (strict && !sharedSource) {
    throw new Error("GRAMSCOPE_LIVE_MEDIA_SOURCE is required");
  }
  const selectors: Partial<Record<MediaMessageKind, MediaLiveSelector>> = {};

  for (const kind of MEDIA_MESSAGE_KINDS) {
    const sourceName = `GRAMSCOPE_LIVE_${kind}_SOURCE`;
    const messageName = `GRAMSCOPE_LIVE_${kind}_MESSAGE_ID`;
    const kindSource = value(environment, sourceName);
    const rawMessageId = value(environment, messageName);
    const pairWasProvided = kindSource !== undefined || rawMessageId !== undefined;

    if (!strict && !pairWasProvided) continue;

    const sourceId = kindSource ?? sharedSource;
    if (!sourceId) throw new Error(`${sourceName} is required`);
    if (!rawMessageId) throw new Error(`${messageName} is required`);

    selectors[kind] = {
      sourceId,
      messageId: positiveMessageId(rawMessageId, messageName),
    };
  }

  if (Object.keys(selectors).length === 0) {
    throw new Error("at least one complete media selector is required");
  }

  return { enabled: true, strict, selectors };
}
