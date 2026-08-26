import { z } from "zod";

export const telegramSourceSchema = z.object({
  id: z.string(),
  title: z.string(),
  username: z.string().optional(),
  description: z.string().optional(),
  url: z.string().optional(),
  type: z.enum(["channel", "group", "chat"]),
  subscriber_count: z.number().int().optional(),
  folder_ids: z.array(z.string()).optional(),
  unread_count: z.number().int().optional(),
  read_inbox_max_id: z.number().int().optional(),
  linked_discussion_id: z.string().optional(),
});

export type TelegramSource = z.infer<typeof telegramSourceSchema>;
