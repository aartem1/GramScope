import { z } from "zod";

export const telegramFolderSchema = z.object({
  id: z.string(),
  title: z.string(),
  included_peer_ids: z.array(z.string()),
  excluded_peer_ids: z.array(z.string()),
  order: z.number().int(),
});

export type TelegramFolder = z.infer<typeof telegramFolderSchema>;
