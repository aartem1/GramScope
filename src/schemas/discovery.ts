import { z } from "zod";

/**
 * A source the account does NOT necessarily hold. It is deliberately not
 * `telegramSourceSchema`: a candidate has no unread state and no folders, and
 * it carries trust flags that a subscribed source has no reason to repeat.
 * Widening the shared schema would add fields to the declared outputSchema of
 * four shipped tools that never populate them.
 */
export const discoveredSourceSchema = z.object({
  id: z.string(),
  title: z.string(),
  username: z.string().optional(),
  description: z.string().optional(),
  url: z.string().optional(),
  type: z.enum(["channel", "group", "chat"]),
  subscriber_count: z.number().int().optional(),
  joined: z.boolean(),
  // Non-optional on purpose: an absent `scam` and a false one must not look
  // the same to a model deciding whether to recommend a channel.
  verified: z.boolean(),
  scam: z.boolean(),
  fake: z.boolean(),
  restricted: z.boolean(),
});

export type DiscoveredSource = z.infer<typeof discoveredSourceSchema>;

export const searchChannelsResultSchema = z.object({
  candidates: z.array(discoveredSourceSchema),
  truncated: z.boolean(),
});

export const similarChannelsResultSchema = z.object({
  candidates: z.array(discoveredSourceSchema),
  total_similar: z.number().int().optional(),
  truncated: z.boolean(),
});
