import {
  isRemoteDispatchEnabled,
  loadConfig,
  loadWorkerClientConfig,
  type WorkerClientConfig,
} from "../config";
import { withTelegram, type TelegramLike } from "../telegram/client";
import { resolveMediaAsset, type MediaAsset } from "../telegram/media";
import { viewRouteErrorResponse } from "./http-errors";
import { materializeMediaView, type GeneratedMediaView } from "./materializer";
import { safeMediaFilename } from "./names";
import { contentDispositionAttachment } from "./original-route";
import type { MediaRepresentationPlan } from "./representation";
import { verifyMediaCapability, type VerifiedMediaCapability } from "./token";
import { fetchMediaFromWorker } from "./worker-proxy";
import type { MediaRepresentationWire } from "./wire";

export type ViewRouteDependencies = {
  verifyToken(token: string): Promise<VerifiedMediaCapability>;
  withClient<T>(run: (client: TelegramLike) => Promise<T>): Promise<T>;
  resolveAsset(
    client: TelegramLike,
    input: { sourceId: string; messageId: number },
  ): Promise<MediaAsset>;
  materialize(
    client: TelegramLike,
    asset: MediaAsset,
    plan: Exclude<MediaRepresentationPlan, { kind: "original" }>,
  ): Promise<GeneratedMediaView>;
  ownerId: string;
  workerConfig?: WorkerClientConfig;
  fetchFromWorker?(
    body: {
      sourceId: string;
      messageId: number;
      representation: MediaRepresentationWire;
    },
    signal?: AbortSignal,
  ): Promise<Response>;
};

function productionViewDependencies(): ViewRouteDependencies {
  const config = loadConfig();
  const deps: ViewRouteDependencies = {
    verifyToken: (token) => verifyMediaCapability(token, new Date(), config.mediaTokenSecret),
    withClient: withTelegram,
    resolveAsset: resolveMediaAsset,
    materialize: materializeMediaView,
    ownerId: config.ownerUserId,
  };
  if (isRemoteDispatchEnabled() && config.worker) {
    deps.workerConfig = loadWorkerClientConfig();
    deps.fetchFromWorker = (body, signal) =>
      fetchMediaFromWorker({
        config: deps.workerConfig!,
        body,
        signal,
      });
  }
  return deps;
}

function completeViewDependencies(
  value: Partial<ViewRouteDependencies>,
): value is ViewRouteDependencies {
  const hasLocal =
    typeof value.withClient === "function" &&
    typeof value.resolveAsset === "function" &&
    typeof value.materialize === "function";
  const hasRemote = typeof value.fetchFromWorker === "function";
  return typeof value.verifyToken === "function" &&
    typeof value.ownerId === "string" &&
    (hasLocal || hasRemote);
}

function viewProxyHeaders(
  upstream: Response,
  claims: Extract<VerifiedMediaCapability, { v: 2 }>,
): Headers {
  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  const filename = safeMediaFilename({
    kind: contentType === "image/jpeg" ? "photo" : "download",
    messageId: claims.messageId,
    mimeType: contentType,
  });
  const headers = new Headers({
    "content-type": contentType,
    "content-disposition": contentDispositionAttachment(filename),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  const length = upstream.headers.get("content-length");
  if (length) headers.set("content-length", length);
  return headers;
}

async function handleViewProxy(
  request: Request,
  claims: Extract<VerifiedMediaCapability, { v: 2 }>,
  deps: ViewRouteDependencies,
): Promise<Response> {
  void request;
  const upstream = await deps.fetchFromWorker!(
    {
      sourceId: claims.sourceId,
      messageId: claims.messageId,
      representation: claims.representation,
    },
    request.signal,
  );

  if (upstream.status !== 200) {
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: upstream.headers,
    });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: viewProxyHeaders(upstream, claims),
  });
}

export async function handleViewRequest(
  request: Request,
  token: string,
  overrides: Partial<ViewRouteDependencies> = {},
): Promise<Response> {
  const deps: ViewRouteDependencies = completeViewDependencies(overrides)
    ? overrides
    : { ...productionViewDependencies(), ...overrides };
  try {
    const claims = await deps.verifyToken(token);
    if (claims.v !== 2 || claims.ownerId !== deps.ownerId) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (claims.representation.kind === "original") return new Response("Unauthorized", { status: 401 });
    const representation = claims.representation;

    if (deps.fetchFromWorker) {
      return handleViewProxy(request, claims, deps);
    }

    return await deps.withClient(async (client) => {
      const media = await deps.resolveAsset(client, {
        sourceId: claims.sourceId,
        messageId: claims.messageId,
      });
      const generated = await deps.materialize(client, media, representation);
      const filename = safeMediaFilename({
        kind: generated.mimeType === "image/jpeg" ? "photo" : media.descriptor.type,
        messageId: media.messageId,
        mimeType: generated.mimeType,
      });
      return new Response(new Uint8Array(generated.data), {
        status: 200,
        headers: {
          "content-type": generated.mimeType,
          "content-length": String(generated.data.length),
          "content-disposition": contentDispositionAttachment(filename),
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        },
      });
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    return viewRouteErrorResponse(error);
  }
}
