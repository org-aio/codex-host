import { z } from "zod";

export const BUDDY_PRIVATE_METHOD = "codexhost/buddy/private";
export const buddyPrivateModelSchema = z.enum(["q3-4b", "q3-14b"]);
const sessionId = z.string().uuid();
export const buddyPrivateRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status"), sessionId }).strict(),
  z.object({ action: z.literal("reset"), sessionId }).strict(),
  z.object({ action: z.literal("cancel"), sessionId }).strict(),
  z
    .object({
      action: z.literal("send"),
      sessionId,
      model: buddyPrivateModelSchema,
      text: z.string().min(1).max(32_000),
    })
    .strict(),
]);
export const buddyPrivateSnapshotSchema = z.object({
  sessionId,
  configured: z.boolean(),
  endpoint: z.string().nullable(),
  model: buddyPrivateModelSchema.nullable(),
  busy: z.boolean(),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() })),
});
export type BuddyPrivateRequest = z.infer<typeof buddyPrivateRequestSchema>;
export type BuddyPrivateSnapshot = z.infer<typeof buddyPrivateSnapshotSchema>;
export type BuddyPrivateModel = z.infer<typeof buddyPrivateModelSchema>;
