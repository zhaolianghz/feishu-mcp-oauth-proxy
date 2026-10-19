import { z } from "zod";

export function identityToolMetadata(name: string) {
  if (name !== "feishu_get_profile") return {};
  return {
    _meta: { "openai/profile": true },
    outputSchema: { id: z.string().min(1).regex(/\S/), name: z.string().optional(), nickname: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  };
}
