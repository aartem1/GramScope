import { loadConfig } from "../config";
import {
  finalizeMediaOutcome,
  type MediaFinalizeDependencies,
  type MediaOutcome,
} from "../media/service";
import { issueMediaCapability } from "../media/token";

export function vercelMediaFinalizeDeps(
  env: NodeJS.ProcessEnv = process.env,
): MediaFinalizeDependencies {
  const config = loadConfig(env);
  return {
    ownerId: config.ownerUserId,
    mediaOrigin: new URL(config.mcpResourceUrl).origin,
    issueCapability: (claims) =>
      issueMediaCapability(claims, new Date(), config.mediaTokenSecret),
  };
}

/**
 * After remote (or in-process) get_media, ensure capability URLs exist.
 * Worker drafts carry unsignedClaims; in-process outcomes are already sealed.
 */
export async function sealMediaOutcomeForClient(
  outcome: MediaOutcome,
  deps: MediaFinalizeDependencies = vercelMediaFinalizeDeps(),
): Promise<MediaOutcome> {
  if (!outcome.unsignedClaims) return outcome;
  return finalizeMediaOutcome(outcome, deps);
}
