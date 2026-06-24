import express from "express"
import type { ChannelManager } from "../channel/manager.js"
import type { ChannelId } from "../channel/types.js"
import type { ChannelTargetTracker } from "./target-tracker.js"
import type { Logger } from "../utils/logger.js"
import type { ApiConfig } from "./api-schema.js"
import { NotifyRequestSchema } from "./api-schema.js"

export function createApiServer(
  config: ApiConfig,
  channelManager: ChannelManager,
  targetTracker: ChannelTargetTracker,
  logger: Logger,
): { start(): Promise<void>; stop(): Promise<void> } {
  const app = express()
  app.use(express.json())

  app.post("/api/notify", async (req, res) => {
    const parseResult = NotifyRequestSchema.safeParse(req.body)
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request",
        details: parseResult.error.flatten(),
      })
      return
    }

    const { title, type, content } = parseResult.data
    const text = type === "markdown" ? `${title}\n\n${content}` : `${title}\n${content}`

    const targets = targetTracker.getAllTargets()
    if (Object.keys(targets).length === 0) {
      res.json({ sent: 0, failed: 0, channels: 0, message: "No channel targets recorded yet" })
      return
    }

    let sentCount = 0
    let failCount = 0

    for (const [channelId, address] of Object.entries(targets)) {
      const plugin = channelManager.getChannel(channelId as ChannelId)
      if (!plugin?.outbound?.sendText) {
        logger.warn(`[api/notify] Channel ${channelId} has no sendText, skipping`)
        continue
      }
      try {
        await plugin.outbound.sendText({ address }, text)
        sentCount++
      } catch (err) {
        logger.error(`[api/notify] Failed to send via ${channelId}: ${err}`)
        failCount++
      }
    }

    res.json({ sent: sentCount, failed: failCount, channels: Object.keys(targets).length })
  })

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" })
  })

  let server: ReturnType<typeof app.listen> | null = null

  return {
    async start(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        server = app.listen(config.port, config.host, () => {
          logger.info(`Notification API server started on ${config.host}:${config.port}`)
          resolve()
        })
        server.on("error", reject)
      })
    },
    async stop(): Promise<void> {
      return new Promise<void>((resolve) => {
        if (server) {
          server.close(() => resolve())
        } else {
          resolve()
        }
      })
    },
  }
}
