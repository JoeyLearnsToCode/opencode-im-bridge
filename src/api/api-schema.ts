import { z } from "zod"

export const ApiConfigSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().min(1).max(65535).default(3002),
  host: z.string().default("127.0.0.1"),
})

export type ApiConfig = z.infer<typeof ApiConfigSchema>

export const NotifyRequestSchema = z.object({
  title: z.string().min(1),
  type: z.enum(["text", "markdown"]),
  content: z.string().min(1),
})

export type NotifyRequest = z.infer<typeof NotifyRequestSchema>
