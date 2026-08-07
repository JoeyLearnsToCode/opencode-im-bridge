import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { HeartbeatService } from "../cron/heartbeat.js"
import type { HeartbeatOptions } from "../cron/heartbeat.js"
import { createMockLogger, createMockFeishuClient } from "../__tests__/setup.js"
import type { SessionManager } from "../session/session-manager.js"
import type { HeartbeatConfig } from "../utils/config.js"

vi.mock("node:fs/promises", () => {
  return {
    readFile: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
  }
})

const advanceTimers = async (ms: number) => {
  if (typeof vi.advanceTimersByTimeAsync === "function") {
    await vi.advanceTimersByTimeAsync(ms)
  } else {
    vi.advanceTimersByTime(ms)
    await new Promise(r => setImmediate(r))
  }
}

function createMockSessionManager(): SessionManager {
  return {
    getOrCreate: vi.fn().mockResolvedValue("heartbeat-session"),
    getExisting: vi.fn().mockResolvedValue(undefined),
    getSession: vi.fn().mockReturnValue(null),
    deleteMapping: vi.fn().mockReturnValue(true),
    setMapping: vi.fn().mockReturnValue(true),
    setModel: vi.fn().mockReturnValue(true),
    findRecentSession: vi.fn().mockResolvedValue(null),
    cleanup: vi.fn().mockReturnValue(0),
    validateAndCleanupStale: vi.fn().mockResolvedValue(0),
  }
}

function makeConfig(overrides: Partial<HeartbeatConfig> = {}): HeartbeatConfig {
  return {
    proactiveEnabled: true,
    intervalMs: 1000,
    statusChatId: undefined,
    alertChats: [],
    agent: "build",
    ...overrides,
  }
}

function makeOptions(overrides: Partial<HeartbeatOptions> = {}): HeartbeatOptions {
  return {
    config: makeConfig(),
    serverUrl: "http://127.0.0.1:4096",
    sessionManager: createMockSessionManager(),
    logger: createMockLogger(),
    ...overrides,
  }
}

describe("HeartbeatService", () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    vi.useFakeTimers()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("start() begins interval with configured intervalMs", () => {
    const options = makeOptions({ config: makeConfig({ intervalMs: 1000 }) })
    const service = new HeartbeatService(options)

    service.start()

    expect(options.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Heartbeat service started (interval: 1000ms)"),
    )

    service.stop()
    expect(options.logger.info).toHaveBeenCalledWith("Heartbeat service stopped")
  })

  it("start() is idempotent", () => {
    const options = makeOptions()
    const service = new HeartbeatService(options)

    service.start()
    service.start()

    const startCalls = (options.logger.info as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("started"))
    expect(startCalls).toHaveLength(1)

    service.stop()
  })

  it("stop() is idempotent", () => {
    const options = makeOptions()
    const service = new HeartbeatService(options)

    service.start()
    service.stop()
    service.stop()

    const stopCalls = (options.logger.info as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("stopped"))
    expect(stopCalls).toHaveLength(1)
  })

  it("tick() logs success on HEARTBEAT_OK", async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
      if (url.includes("/session/") && url.endsWith("/message") && init?.method === "POST") {
        return { ok: true }
      }
      if (url.includes("/session/") && !url.includes("/message")) {
        return { ok: true, json: async () => ({ status: { type: "idle" } }) }
      }
      if (url.includes("/message?limit=1")) {
        return { ok: true, json: async () => [{ role: "assistant", text: "HEARTBEAT_OK" }] }
      }
      return { ok: false, status: 404 }
    })
    globalThis.fetch = mockFetch

    const options = makeOptions({ config: makeConfig({ intervalMs: 10_000 }) })
    const service = new HeartbeatService(options)

    service.start()
    vi.advanceTimersByTime(10_000)
    await advanceTimers(2_100)

    expect(options.logger.info).toHaveBeenCalledWith("Server healthy (Heartbeat OK)")

    service.stop()
  })

  it("tick() logs error and does not alert when feishuClient is undefined", async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
      if (url.includes("/session/") && url.endsWith("/message") && init?.method === "POST") {
        return { ok: true }
      }
      if (url.includes("/session/") && !url.includes("/message")) {
        return { ok: true, json: async () => ({ status: { type: "idle" } }) }
      }
      if (url.includes("/message?limit=1")) {
        return { ok: true, json: async () => [{ role: "assistant", text: "ERROR" }] }
      }
      return { ok: false, status: 404 }
    })
    globalThis.fetch = mockFetch

    const options = makeOptions({ config: makeConfig({ intervalMs: 100 }), feishuClient: undefined })
    const service = new HeartbeatService(options)

    service.start()
    vi.advanceTimersByTime(10_000)
    await advanceTimers(2_100)

    expect(options.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Heartbeat agent returned failure: ERROR"),
    )

    service.stop()
  })

  it("tick() logs error and sends alert on agent failure with statusChatId", async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
      if (url.includes("/session/") && url.endsWith("/message") && init?.method === "POST") {
        return { ok: true }
      }
      if (url.includes("/session/") && !url.includes("/message")) {
        return { ok: true, json: async () => ({ status: { type: "idle" } }) }
      }
      if (url.includes("/message?limit=1")) {
        return { ok: true, json: async () => [{ role: "assistant", text: "Disk full" }] }
      }
      return { ok: false, status: 404 }
    })
    globalThis.fetch = mockFetch

    const feishuClient = createMockFeishuClient()
    const options = makeOptions({
      config: makeConfig({ intervalMs: 100, statusChatId: "chat-123" }),
      feishuClient,
    })
    const service = new HeartbeatService(options)

    service.start()
    vi.advanceTimersByTime(100)
    await advanceTimers(2_100)

    expect(options.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Heartbeat agent returned failure: Disk full"),
    )
    expect(feishuClient.sendMessage).toHaveBeenCalledWith(
      "chat-123",
      expect.objectContaining({
        msg_type: "text",
      }),
    )

    service.stop()
  })

  it("tick() handles fetch network error", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network timeout"))
    globalThis.fetch = mockFetch

    const options = makeOptions({ config: makeConfig({ intervalMs: 100 }) })
    const service = new HeartbeatService(options)

    service.start()
    vi.advanceTimersByTime(100)
    await advanceTimers(10)

    expect(options.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Heartbeat check failed to execute: Network timeout"),
    )

    service.stop()
  })

  it("tick() sends alert on network error with statusChatId", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    globalThis.fetch = mockFetch

    const feishuClient = createMockFeishuClient()
    const options = makeOptions({
      config: makeConfig({ intervalMs: 100, statusChatId: "chat-456" }),
      feishuClient,
    })
    const service = new HeartbeatService(options)

    service.start()
    vi.advanceTimersByTime(100)
    await advanceTimers(10)

    expect(feishuClient.sendMessage).toHaveBeenCalledWith(
      "chat-456",
      expect.objectContaining({
        msg_type: "text",
      }),
    )

    service.stop()
  })

  it("getStats() returns successCount and failCount", async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
      if (url.includes("/session/") && url.endsWith("/message") && init?.method === "POST") {
        return { ok: true }
      }
      if (url.includes("/session/") && !url.includes("/message")) {
        return { ok: true, json: async () => ({ status: { type: "idle" } }) }
      }
      if (url.includes("/message?limit=1")) {
        return { ok: true, json: async () => [{ role: "assistant", text: "HEARTBEAT_OK" }] }
      }
      return { ok: false, status: 404 }
    })
    globalThis.fetch = mockFetch

    const options = makeOptions({ config: makeConfig({ intervalMs: 100 }) })
    const service = new HeartbeatService(options)

    const tick1 = (service as any).tick()
    await advanceTimers(2_100)
    await tick1

    let stats = service.getStats()
    expect(stats.successCount).toBe(1)
    expect(stats.failCount).toBe(0)

    // Second run returns failure text
    const mockFetch2 = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
      if (url.includes("/session/") && url.endsWith("/message") && init?.method === "POST") {
        return { ok: true }
      }
      if (url.includes("/session/") && !url.includes("/message")) {
        return { ok: true, json: async () => ({ status: { type: "idle" } }) }
      }
      if (url.includes("/message?limit=1")) {
        return { ok: true, json: async () => [{ role: "assistant", text: "FAIL" }] }
      }
      return { ok: false, status: 404 }
    })
    globalThis.fetch = mockFetch2
    const tick2 = (service as any).tick()
    await advanceTimers(2_100)
    await tick2

    stats = service.getStats()
    expect(stats.successCount).toBe(1)
    expect(stats.failCount).toBe(1)

    service.stop()
  })
})
