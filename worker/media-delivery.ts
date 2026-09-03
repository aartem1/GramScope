import { GramScopeError } from "../src/errors/taxonomy";
import { mapTelegramError } from "../src/errors/from-telegram";
import { materializeMediaView } from "../src/media/materializer";
import type { MediaRepresentationPlan } from "../src/media/representation";
import {
  mediaDeliveryHttpStatus,
} from "../src/media/http-errors";
import type { MediaRequestBody } from "../src/media/wire";
import { withTelegram, type TelegramLike } from "../src/telegram/client";
import {
  iterAssetBytes,
  resolveMediaAsset,
  type MediaAsset,
} from "../src/telegram/media";
import { z } from "zod";

export type MediaDeliveryStream = {
  kind: "stream";
  status: 200 | 206;
  headers: Record<string, string>;
  chunks: AsyncIterable<Buffer>;
};

export type MediaDeliveryBuffer = {
  kind: "buffer";
  status: 200;
  headers: Record<string, string>;
  data: Buffer;
};

export type MediaDeliveryFailure = {
  kind: "error";
  status: number;
  message: string;
  headers?: Record<string, string>;
};

export type MediaDeliveryResult =
  | MediaDeliveryStream
  | MediaDeliveryBuffer
  | MediaDeliveryFailure;

export type MediaDeliveryDependencies = {
  withClient<T>(run: (client: TelegramLike) => Promise<T>): Promise<T>;
  resolveAsset(
    client: TelegramLike,
    input: { sourceId: string; messageId: number },
  ): Promise<MediaAsset>;
  iterBytes(
    client: TelegramLike,
    asset: MediaAsset,
    options: { offset?: number; limit?: number; signal?: AbortSignal },
  ): AsyncIterable<Buffer>;
  materialize(
    client: TelegramLike,
    asset: MediaAsset,
    plan: Exclude<MediaRepresentationPlan, { kind: "original" }>,
  ): Promise<{ data: Buffer; mimeType: string }>;
};

function productionMediaDeliveryDependencies(): MediaDeliveryDependencies {
  return {
    withClient: withTelegram,
    resolveAsset: resolveMediaAsset,
    iterBytes: iterAssetBytes,
    materialize: async (client, asset, plan) => {
      const generated = await materializeMediaView(client, asset, plan);
      return { data: generated.data, mimeType: generated.mimeType };
    },
  };
}

function mapExecutionError(err: unknown): GramScopeError {
  if (err instanceof GramScopeError) return err;
  if (err instanceof z.ZodError) {
    return new GramScopeError("INVALID_INPUT", "Invalid media request.");
  }
  return mapTelegramError(err);
}

function toRepresentationPlan(
  representation: MediaRequestBody["representation"],
): MediaRepresentationPlan {
  return representation;
}

export async function deliverMedia(
  input: MediaRequestBody,
  signal?: AbortSignal,
  overrides: Partial<MediaDeliveryDependencies> = {},
): Promise<MediaDeliveryResult> {
  const deps: MediaDeliveryDependencies = {
    ...productionMediaDeliveryDependencies(),
    ...overrides,
  };

  try {
    return await deps.withClient(async (client) => {
      const asset = await deps.resolveAsset(client, {
        sourceId: input.sourceId,
        messageId: input.messageId,
      });
      const plan = toRepresentationPlan(input.representation);

      if (plan.kind === "original") {
        const size = asset.descriptor.size;
        if (size === undefined) {
          return {
            kind: "error",
            status: 422,
            message: "Media size unavailable",
          };
        }

        const range = input.range;
        const offset = range?.start;
        const limit = range ? range.end - range.start + 1 : undefined;
        const length = limit ?? size;
        const headers: Record<string, string> = {
          "content-type": asset.descriptor.mime_type ?? "application/octet-stream",
          "content-length": String(length),
          "accept-ranges": "bytes",
        };
        if (range) {
          headers["content-range"] = `bytes ${range.start}-${range.end}/${size}`;
        }

        return {
          kind: "stream",
          status: range ? 206 : 200,
          headers,
          chunks: deps.iterBytes(client, asset, {
            ...(offset !== undefined ? { offset } : {}),
            ...(limit !== undefined ? { limit } : {}),
            signal,
          }),
        };
      }

      const generated = await deps.materialize(client, asset, plan);
      return {
        kind: "buffer",
        status: 200,
        headers: {
          "content-type": generated.mimeType,
          "content-length": String(generated.data.length),
        },
        data: generated.data,
      };
    });
  } catch (error) {
    const mapped = mediaDeliveryHttpStatus(mapExecutionError(error));
    return {
      kind: "error",
      status: mapped.status,
      message: mapped.message,
      ...(mapped.headers ? { headers: mapped.headers } : {}),
    };
  }
}
