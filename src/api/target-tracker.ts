import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join, resolve, dirname } from "node:path"
import { createLogger } from "../utils/logger.js"

const logger = createLogger("target-tracker")

export interface ChannelTargetMap {
  [channelId: string]: string
}

export class ChannelTargetTracker {
  private targets: ChannelTargetMap = {}
  private filePath: string

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "channel-last-targets.json")
  }

  async init(): Promise<void> {
    try {
      const data = await readFile(this.filePath, "utf-8")
      this.targets = JSON.parse(data)
      logger.info(`Loaded ${Object.keys(this.targets).length} channel target(s) from ${this.filePath}`)
    } catch {
      this.targets = {}
    }
  }

  recordTarget(channelId: string, address: string): void {
    this.targets[channelId] = address
    this.save().catch((err) => logger.warn(`Failed to save channel targets: ${err}`))
  }

  getAllTargets(): ChannelTargetMap {
    return { ...this.targets }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, JSON.stringify(this.targets, null, 2), "utf-8")
  }
}
