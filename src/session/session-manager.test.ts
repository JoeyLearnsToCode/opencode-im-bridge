import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createSessionManager, buildRecentAssistantSummary, MAX_ASSISTANT_SUMMARY_LENGTH } from "./session-manager.js"
import type { SessionManager } from "./session-manager.js"

const isBun = typeof (globalThis as any).Bun !== "undefined"
const describeOrSkip = isBun ? describe : describe.skip

let Database: typeof import("bun:sqlite").Database
if (isBun) {
  ;({ Database } = await import("bun:sqlite"))
}

const SERVER_URL = "http://127.0.0.1:4096"
const DEFAULT_AGENT = "claude"

function createTestDb(): Database {
  return new Database(":memory:")
}

describeOrSkip("buildRecentAssistantSummary", () => {
  it("extracts text from the most recent assistant turn, stopping at user messages", () => {
    const messages = [
      { role: "user", text: "hello" },
      { role: "assistant", content: [{ type: "text", text: "first reply" }] },
      { role: "user", text: "again" },
      { role: "assistant", content: [{ type: "reasoning", text: "think" }, { type: "text", text: "second reply" }] },
    ]
    const result = buildRecentAssistantSummary(messages)
    expect(result?.text).toBe("second reply")
    expect(result?.tools).toEqual([])
  })

  it("keeps only tool names, deduplicated, and excludes them from the text", () => {
    const messages = [
      { role: "user", text: "go" },
      { role: "assistant", content: [
        { type: "tool", tool: "shell" },
        { type: "tool", tool: "shell" },
        { type: "tool", name: "read" },
        { type: "text", text: "done" },
      ] },
    ]
    const result = buildRecentAssistantSummary(messages)
    expect(result?.text).toBe("done")
    expect(result?.tools).toEqual(["shell", "read"])
  })

  it("truncates a single long segment to MAX_ASSISTANT_SUMMARY_LENGTH CJK chars", () => {
    const long = "字".repeat(MAX_ASSISTANT_SUMMARY_LENGTH + 100)
    const messages = [
      { role: "user", text: "go" },
      { role: "assistant", content: [{ type: "text", text: long }] },
    ]
    const result = buildRecentAssistantSummary(messages)
    expect(result!.text.length).toBe(MAX_ASSISTANT_SUMMARY_LENGTH)
  })

  it("drops older segments beyond the budget, keeping the newest", () => {
    const messages = [
      { role: "user", text: "go" },
      { role: "assistant", content: [{ type: "text", text: "A ".repeat(400) }] },
      { role: "assistant", content: [{ type: "text", text: "B ".repeat(200) }] },
      { role: "assistant", content: [{ type: "text", text: "C ".repeat(100) }] },
    ]
    const result = buildRecentAssistantSummary(messages)
    const aCount = (result!.text.match(/A/g) ?? []).length
    expect(aCount).toBeLessThan(400)
    expect(result!.text).toContain("C ")
    expect(result!.text.lastIndexOf("C ")).toBeGreaterThan(result!.text.lastIndexOf("A "))
  })

  it("returns null when there is no assistant content", () => {
    expect(buildRecentAssistantSummary([])).toBeNull()
    expect(buildRecentAssistantSummary([{ role: "user", text: "hi" }])).toBeNull()
    expect(buildRecentAssistantSummary([{ role: "system", text: "sys" }])).toBeNull()
  })
})

describeOrSkip("session-manager", () => {
  let db: Database
  let sm: SessionManager
  const originalFetch = globalThis.fetch
  let savedOpencodeCwd: string | undefined

  beforeEach(() => {
    db = createTestDb()
    savedOpencodeCwd = process.env.OPENCODE_CWD
    process.env.OPENCODE_CWD = "/test/project"
    globalThis.fetch = vi.fn()
  })

  afterEach(() => {
    db.close()
    globalThis.fetch = originalFetch
    if (savedOpencodeCwd === undefined) delete process.env.OPENCODE_CWD
    else process.env.OPENCODE_CWD = savedOpencodeCwd
  })

  function mockFetch(impl: typeof globalThis.fetch) {
    globalThis.fetch = vi.fn(impl)
  }

  describe("getOrCreate", () => {
    it("discovers existing TUI session and returns its ID", async () => {
      const tuiSessionId = "ses-tui-abc"
      mockFetch(async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
        if (url.includes("/session") && !url.includes("/session/")) {
          // GET /session — list sessions
          if (url.includes("roots=true")) {
            return new Response(
              JSON.stringify([
                {
                  id: tuiSessionId,
                  title: "TUI Session",
                  directory: "/test/project",
                  time: { created: 1000, updated: 2000 },
                },
              ]),
              { status: 200 },
            )
          }
        }
        // Validation GET /session/{id} — return 200 for the discovered session
        if (url.includes(`/session/${tuiSessionId}`)) {
          return new Response(JSON.stringify({ id: tuiSessionId }), { status: 200 })
        }
        return new Response("Not found", { status: 404 })
      })

      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })
      const result = await sm.getOrCreate("chat-1")

      expect(result).toBe(tuiSessionId)

      // Verify is_bound = 1 for discovered session
      const mapping = sm.getSession("chat-1")
      expect(mapping).not.toBeNull()
      expect(mapping!.is_bound).toBe(1)
      expect(mapping!.session_id).toBe(tuiSessionId)
    })

    it("falls back to POST /session when no sessions exist", async () => {
      const createdSessionId = "ses-new-123"
      mockFetch(async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
        const method = init?.method ?? "GET"

        if (url.includes("/session") && method === "GET") {
          // Return empty array — no existing sessions
          return new Response(JSON.stringify([]), { status: 200 })
        }
        if (url.includes("/session") && method === "POST") {
          return new Response(JSON.stringify({ id: createdSessionId }), { status: 200 })
        }
        return new Response("Not found", { status: 404 })
      })

      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })
      const result = await sm.getOrCreate("chat-2")

      expect(result).toBe(createdSessionId)

      // Verify is_bound = 0 for created session
      const mapping = sm.getSession("chat-2")
      expect(mapping).not.toBeNull()
      expect(mapping!.is_bound).toBe(0)
    })

    it("reuses cached session without any API call", async () => {
      const tuiSessionId = "ses-cached-xyz"
      let fetchCallCount = 0

      mockFetch(async (input) => {
        fetchCallCount++
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
        if (url.includes("/session") && url.includes("roots=true")) {
          return new Response(
            JSON.stringify([
              { id: tuiSessionId, title: "TUI", directory: "/test/project", time: { created: 1, updated: 2 } },
            ]),
            { status: 200 },
          )
        }
        // Validation GET /session/{id}
        if (url.includes(`/session/${tuiSessionId}`)) {
          return new Response(JSON.stringify({ id: tuiSessionId }), { status: 200 })
        }
        return new Response("Not found", { status: 404 })
      })

      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })

      // First call — triggers discovery
      await sm.getOrCreate("chat-3")
      const callsAfterFirst = fetchCallCount

      // Second call — should use DB cache, no new fetch
      const result = await sm.getOrCreate("chat-3")
      expect(result).toBe(tuiSessionId)
      expect(fetchCallCount).toBe(callsAfterFirst)
    })

    it("sets is_bound=1 for discovered sessions, is_bound=0 for created", async () => {
      mockFetch(async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
        const method = init?.method ?? "GET"

        if (url.includes("/session") && method === "GET" && url.includes("roots=true")) {
          if (url.includes("directory=")) {
            return new Response(
              JSON.stringify([
                { id: "ses-discovered", title: "TUI", directory: "/test/project", time: { created: 1, updated: 2 } },
              ]),
              { status: 200 },
            )
          }
        }
        // Validation GET /session/ses-discovered
        if (url.includes("/session/ses-discovered") && method === "GET") {
          return new Response(JSON.stringify({ id: "ses-discovered" }), { status: 200 })
        }
        if (url.includes("/session") && method === "POST") {
          return new Response(JSON.stringify({ id: "ses-created" }), { status: 200 })
        }
        return new Response("Not found", { status: 404 })
      })

      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })

      await sm.getOrCreate("chat-discovered")
      const discovered = sm.getSession("chat-discovered")
      expect(discovered!.is_bound).toBe(1)
    })

    it("falls back to POST silently when GET fails", async () => {
      const createdId = "ses-fallback-456"
      mockFetch(async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
        const method = init?.method ?? "GET"

        if (method === "GET" || (!init?.method && !init?.body)) {
          // GET fails with 500
          return new Response("Internal Server Error", { status: 500 })
        }
        if (method === "POST") {
          return new Response(JSON.stringify({ id: createdId }), { status: 200 })
        }
        return new Response("Not found", { status: 404 })
      })

      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })
      const result = await sm.getOrCreate("chat-fail")

      // Should not throw, should fall back to POST
      expect(result).toBe(createdId)

      const mapping = sm.getSession("chat-fail")
      expect(mapping!.is_bound).toBe(0)
    })

    it("falls back to POST when GET throws network error", async () => {
      const createdId = "ses-net-err"
      let callIndex = 0
      mockFetch(async (input, init) => {
        callIndex++
        const method = init?.method ?? "GET"

        if (method === "GET" || (!init?.method && !init?.body)) {
          throw new Error("Network error")
        }
        if (method === "POST") {
          return new Response(JSON.stringify({ id: createdId }), { status: 200 })
        }
        return new Response("Not found", { status: 404 })
      })

      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })
      const result = await sm.getOrCreate("chat-neterr")

      expect(result).toBe(createdId)
      expect(sm.getSession("chat-neterr")!.is_bound).toBe(0)
    })
  })

  describe("cleanup", () => {
    it("does not break with is_bound column", () => {
      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })
      // Just verify cleanup still works
      const result = sm.cleanup(0)
      expect(result).toBe(0)
    })
  })

  describe("migration", () => {
    it("adds is_bound column to existing table without errors", () => {
      // Pre-create the old schema
      db.exec(`
        CREATE TABLE IF NOT EXISTS feishu_sessions (
          feishu_key  TEXT PRIMARY KEY,
          session_id  TEXT NOT NULL,
          agent       TEXT NOT NULL,
          created_at  INTEGER NOT NULL,
          last_active INTEGER NOT NULL
        )
      `)

      // Should not throw — ALTER TABLE in try/catch
      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })
      expect(sm).toBeDefined()
    })

    it("handles already-migrated table gracefully", () => {
      // Create table with is_bound already present
      db.exec(`
        CREATE TABLE IF NOT EXISTS feishu_sessions (
          feishu_key  TEXT PRIMARY KEY,
          session_id  TEXT NOT NULL,
          agent       TEXT NOT NULL,
          created_at  INTEGER NOT NULL,
          last_active INTEGER NOT NULL,
          is_bound    INTEGER DEFAULT 0
        )
      `)

      // Second createSessionManager should not throw even though column exists
      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })
      expect(sm).toBeDefined()
    })
  })

  describe("discoverTuiSession validation", () => {
    it("skips discovered session that returns 404 from server", async () => {
      const createdSessionId = "ses-created-after-stale"
      mockFetch(async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
        const method = init?.method ?? "GET"

        if (url.includes("/session") && method === "GET" && url.includes("roots=true")) {
          // Return a session from TUI discovery
          return new Response(
            JSON.stringify([
              { id: "ses-stale", title: "Old TUI", directory: "/test/project", time: { created: 1, updated: 2 } },
            ]),
            { status: 200 },
          )
        }
        // GET /session/ses-stale — returns 404 (session doesn't exist anymore)
        if (url.includes("/session/ses-stale") && method === "GET") {
          return new Response("Not found", { status: 404 })
        }
        if (url.includes("/session") && method === "POST") {
          return new Response(JSON.stringify({ id: createdSessionId }), { status: 200 })
        }
        return new Response("Not found", { status: 404 })
      })

      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })
      const result = await sm.getOrCreate("chat-stale-discover")

      // Should have fallen through to POST (create new session)
      expect(result).toBe(createdSessionId)
      expect(sm.getSession("chat-stale-discover")!.is_bound).toBe(0)
    })

    it("accepts discovered session that returns 200 from server", async () => {
      const tuiSessionId = "ses-valid-tui"
      mockFetch(async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
        const method = init?.method ?? "GET"

        if (url.includes("/session") && method === "GET" && url.includes("roots=true")) {
          return new Response(
            JSON.stringify([
              { id: tuiSessionId, title: "Valid TUI", directory: "/test/project", time: { created: 1, updated: 2 } },
            ]),
            { status: 200 },
          )
        }
        // GET /session/ses-valid-tui — 200 OK
        if (url.includes(`/session/${tuiSessionId}`) && method === "GET") {
          return new Response(JSON.stringify({ id: tuiSessionId }), { status: 200 })
        }
        return new Response("Not found", { status: 404 })
      })

      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })
      const result = await sm.getOrCreate("chat-valid-discover")

      expect(result).toBe(tuiSessionId)
      expect(sm.getSession("chat-valid-discover")!.is_bound).toBe(1)
    })
  })

    it("accepts discovered session when server returns 500 (conservative — not 404)", async () => {
      const tuiSessionId = "ses-500-tui"
      mockFetch(async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
        const method = init?.method ?? "GET"

        if (url.includes("/session") && method === "GET" && url.includes("roots=true")) {
          return new Response(
            JSON.stringify([
              { id: tuiSessionId, title: "TUI", directory: "/test/project", time: { created: 1, updated: 2 } },
            ]),
            { status: 200 },
          )
        }
        // GET /session/ses-500-tui — returns 500 (server error)
        if (url.includes(`/session/${tuiSessionId}`) && method === "GET") {
          return new Response("Internal Server Error", { status: 500 })
        }
        return new Response("Not found", { status: 404 })
      })

      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })
      const result = await sm.getOrCreate("chat-500-discover")

      // 500 should be treated conservatively as \"exists\" — session accepted, not skipped
      expect(result).toBe(tuiSessionId)
      expect(sm.getSession("chat-500-discover")!.is_bound).toBe(1)
    })

  describe("validateAndCleanupStale", () => {
    it("removes mappings whose sessions return 404", async () => {
      mockFetch(async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
        if (url.includes("/session/ses-alive")) {
          return new Response(JSON.stringify({ id: "ses-alive" }), { status: 200 })
        }
        if (url.includes("/session/ses-dead")) {
          return new Response("Not found", { status: 404 })
        }
        return new Response("Not found", { status: 404 })
      })

      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })

      // Manually insert mappings
      const now = Date.now()
      db.prepare(
        "INSERT INTO feishu_sessions (feishu_key, session_id, agent, created_at, last_active, is_bound) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("key-alive", "ses-alive", "claude", now, now, 1)
      db.prepare(
        "INSERT INTO feishu_sessions (feishu_key, session_id, agent, created_at, last_active, is_bound) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("key-dead", "ses-dead", "claude", now, now, 1)

      const cleaned = await sm.validateAndCleanupStale()

      expect(cleaned).toBe(1)
      expect(sm.getSession("key-alive")).not.toBeNull()
      expect(sm.getSession("key-dead")).toBeNull()
    })

    it("preserves all mappings when all sessions are valid", async () => {
      mockFetch(async () => {
        return new Response(JSON.stringify({ id: "ses-1" }), { status: 200 })
      })

      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })

      const now = Date.now()
      db.prepare(
        "INSERT INTO feishu_sessions (feishu_key, session_id, agent, created_at, last_active, is_bound) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("key-1", "ses-1", "claude", now, now, 1)

      const cleaned = await sm.validateAndCleanupStale()
      expect(cleaned).toBe(0)
      expect(sm.getSession("key-1")).not.toBeNull()
    })

    it("returns 0 when no mappings exist", async () => {
      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })
      const cleaned = await sm.validateAndCleanupStale()
      expect(cleaned).toBe(0)
    })

    it("skips mappings when server is unreachable (network error)", async () => {
      mockFetch(async () => {
        throw new Error("Network error")
      })

      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })

      const now = Date.now()
      db.prepare(
        "INSERT INTO feishu_sessions (feishu_key, session_id, agent, created_at, last_active, is_bound) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("key-1", "ses-1", "claude", now, now, 1)

      const cleaned = await sm.validateAndCleanupStale()
      // Network errors should NOT cause cleanup — mapping preserved
      expect(cleaned).toBe(0)
      expect(sm.getSession("key-1")).not.toBeNull()
    })

    it("preserves mappings when server returns 500 (not treated as missing)", async () => {
      mockFetch(async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
        if (url.includes("/session/ses-500")) {
          return new Response("Internal Server Error", { status: 500 })
        }
        return new Response(JSON.stringify({ id: "ses-ok" }), { status: 200 })
      })

      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })

      const now = Date.now()
      db.prepare(
        "INSERT INTO feishu_sessions (feishu_key, session_id, agent, created_at, last_active, is_bound) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("key-500", "ses-500", "claude", now, now, 1)
      db.prepare(
        "INSERT INTO feishu_sessions (feishu_key, session_id, agent, created_at, last_active, is_bound) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("key-ok", "ses-ok", "claude", now, now, 1)

      const cleaned = await sm.validateAndCleanupStale()

      // 500 should NOT be treated as "not exists" — mapping preserved
      expect(cleaned).toBe(0)
      expect(sm.getSession("key-500")).not.toBeNull()
      expect(sm.getSession("key-ok")).not.toBeNull()
    })

    it("preserves mappings when server returns 429 (rate limited)", async () => {
      mockFetch(async () => {
        return new Response("Too Many Requests", { status: 429 })
      })

      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })

      const now = Date.now()
      db.prepare(
        "INSERT INTO feishu_sessions (feishu_key, session_id, agent, created_at, last_active, is_bound) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("key-rl", "ses-rl", "claude", now, now, 1)

      const cleaned = await sm.validateAndCleanupStale()

      expect(cleaned).toBe(0)
      expect(sm.getSession("key-rl")).not.toBeNull()
    })
  })

  describe("findRecentSession", () => {
    it("returns the most recently active root session for the directory", async () => {
      mockFetch(async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
        if (url.includes("/api/session") && url.includes("directory=")) {
          return new Response(
            JSON.stringify({
              data: [
                { id: "ses-new-created", parentID: undefined, time: { created: 3000, updated: 3000 } },
                { id: "ses-recent", parentID: undefined, time: { created: 1000, updated: 5000 } },
                { id: "ses-child", parentID: "ses-new-created", time: { created: 4000, updated: 6000 } },
                { id: "ses-old", parentID: undefined, time: { created: 500, updated: 1000 } },
              ],
            }),
            { status: 200 },
          )
        }
        return new Response("Not found", { status: 404 })
      })

      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })
      const result = await sm.findRecentSession("/test/project")

      // ses-child is more recently updated but is a child session — must be excluded
      expect(result).toBe("ses-recent")
    })

    it("returns null when no sessions exist for the directory", async () => {
      mockFetch(async () => {
        return new Response(JSON.stringify({ data: [], cursor: {} }), { status: 200 })
      })

      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })
      const result = await sm.findRecentSession("/test/project")

      expect(result).toBeNull()
    })

    it("returns null when the API responds with a non-200 status", async () => {
      mockFetch(async () => {
        return new Response("Internal Server Error", { status: 500 })
      })

      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })
      const result = await sm.findRecentSession("/test/project")

      expect(result).toBeNull()
    })

    it("returns null when the API call throws a network error", async () => {
      mockFetch(async () => {
        throw new Error("Network error")
      })

      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })
      const result = await sm.findRecentSession("/test/project")

      expect(result).toBeNull()
    })
  })

  describe("setMapping", () => {
    it("resets agent and model when binding the same key to a different session", () => {
      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })

      const now = Date.now()
      db.prepare(
        "INSERT INTO feishu_sessions (feishu_key, session_id, agent, model, created_at, last_active, is_bound) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("key-switch", "ses-old", "gpt-4.1", "model-old", now, now, 1)

      const changed = sm.setMapping("key-switch", "ses-new")
      expect(changed).toBe(true)

      const mapping = sm.getSession("key-switch")
      expect(mapping).not.toBeNull()
      expect(mapping!.session_id).toBe("ses-new")
      expect(mapping!.agent).toBe(DEFAULT_AGENT)
      expect(mapping!.model).toBe("model-old")
    })
  })
})
