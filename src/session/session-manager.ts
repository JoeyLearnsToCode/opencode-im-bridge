import { type Database } from "bun:sqlite"
import { createLogger } from "../utils/logger.js"
import type { SessionMapping } from "../types.js"
import { getCwdBase } from "../utils/paths.js"

const logger = createLogger("session-manager")

interface SessionManagerOptions {
  serverUrl: string
  db: Database
  defaultAgent: string
  defaultModel?: string | null
}

export interface SessionManager {
  getOrCreate(feishuKey: string, agent?: string): Promise<string>
  getExisting(feishuKey: string): Promise<string | undefined>
  getSession(feishuKey: string): SessionMapping | null
  deleteMapping(feishuKey: string): boolean
  setMapping(feishuKey: string, sessionId: string, agent?: string): boolean
  setModel(feishuKey: string, model: string | null): boolean
  findRecentSession(directory: string): Promise<string | null>
  getRecentAssistantSummary(sessionId: string): Promise<AssistantSummary | null>
  cleanup(maxAgeMs?: number): number
  validateAndCleanupStale(): Promise<number>
}

/** Cap for the recent-assistant-message summary, counted as CJK chars + English words.
 *  Tune this constant when the threshold needs adjusting. */
export const MAX_ASSISTANT_SUMMARY_LENGTH = 500

export interface AssistantSummary {
  text: string
  tools: string[]
}

interface SummaryMessage {
  role?: string
  type?: string
  text?: string
  content?: Array<{ type?: string; text?: string; name?: string; tool?: string }>
}

const SUMMARY_TOKEN_RE =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]|[^\s\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g

/** Count text as CJK chars (each = 1) plus whitespace-separated words (each = 1). */
function countSummaryUnits(text: string): number {
  let units = 0
  for (const _ of text.matchAll(SUMMARY_TOKEN_RE)) units++
  return units
}

/** Keep the first `maxUnits` units of text (CJK chars + words). */
function truncateSummaryText(text: string, maxUnits: number): string {
  if (countSummaryUnits(text) <= maxUnits) return text
  let units = 0
  let out = ""
  for (const match of text.matchAll(SUMMARY_TOKEN_RE)) {
    if (units >= maxUnits) break
    out += match[0]
    units++
  }
  return out
}

/** Walk messages newest-first, stopping at the first user message. Collects the
 *  assistant text (capped at MAX_ASSISTANT_SUMMARY_LENGTH units) and the deduplicated
 *  tool names (not counted toward the cap). Returns null when there is nothing to show. */
export function buildRecentAssistantSummary(messages: SummaryMessage[]): AssistantSummary | null {
  const texts: string[] = []
  const tools: string[] = []

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message) continue
    const role = message.role ?? message.type
    if (role === "user") break
    if (role !== "assistant") continue
    for (const part of message.content ?? []) {
      if (part.type === "tool" && part.name) {
        if (!tools.includes(part.name)) tools.push(part.name)
      } else if (part.type === "tool" && part.tool) {
        if (!tools.includes(part.tool)) tools.push(part.tool)
      } else if (part.type === "text" && part.text) {
        texts.push(part.text)
      }
    }
  }

  if (texts.length === 0 && tools.length === 0) return null

  texts.reverse()

  const kept: string[] = []
  let keptUnits = 0
  for (let i = texts.length - 1; i >= 0; i--) {
    const text = texts[i]
    if (text === undefined) continue
    const units = countSummaryUnits(text)
    if (keptUnits + units <= MAX_ASSISTANT_SUMMARY_LENGTH) {
      kept.unshift(text)
      keptUnits += units
    } else if (keptUnits < MAX_ASSISTANT_SUMMARY_LENGTH) {
      kept.unshift(truncateSummaryText(text, MAX_ASSISTANT_SUMMARY_LENGTH - keptUnits))
      break
    } else {
      break
    }
  }

  return { text: kept.join("\n"), tools }
}

interface TuiSession {
  id: string
  title?: string
  directory?: string
  time?: { created: number; updated: number }
}

interface V2SessionInfo {
  id: string
  parentID?: string | null
  time?: { created?: number; updated?: number }
}

export function createSessionManager(
  options: SessionManagerOptions,
): SessionManager {
  const { serverUrl, db, defaultAgent, defaultModel = null } = options

  db.exec(`
    CREATE TABLE IF NOT EXISTS feishu_sessions (
      feishu_key  TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      agent       TEXT NOT NULL,
      model       TEXT,
      created_at  INTEGER NOT NULL,
      last_active INTEGER NOT NULL,
      is_bound    INTEGER DEFAULT 0
    )
  `)

  try {
    db.exec("ALTER TABLE feishu_sessions ADD COLUMN is_bound INTEGER DEFAULT 0")
  } catch {
    // Column already exists.
  }

  try {
    db.exec("ALTER TABLE feishu_sessions ADD COLUMN model TEXT")
  } catch {

    // Column already exists — safe to ignore
  }

  const getStmt = db.prepare(
    "SELECT * FROM feishu_sessions WHERE feishu_key = ?",
  )

  const upsertStmt = db.prepare(
    `INSERT OR REPLACE INTO feishu_sessions
       (feishu_key, session_id, agent, model, created_at, last_active, is_bound)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )

  const updateActiveStmt = db.prepare(
    "UPDATE feishu_sessions SET last_active = ? WHERE feishu_key = ?",
  )

  const cleanupStmt = db.prepare(
    "DELETE FROM feishu_sessions WHERE last_active < ?",
  )

  const deleteMappingStmt = db.prepare(
    "DELETE FROM feishu_sessions WHERE feishu_key = ?",
  )

  const updateModelStmt = db.prepare(
    "UPDATE feishu_sessions SET model = ?, last_active = ? WHERE feishu_key = ?",
  )

  /** Check whether a session ID actually exists on the opencode server.
   *  Returns false ONLY on 404. All other errors (500, 429, network) return true (conservative). */

  async function sessionExistsOnServer(sessionId: string): Promise<boolean> {
    try {
      const resp = await fetch(`${serverUrl}/session/${sessionId}`)
      return resp.status !== 404
    } catch {
      return true
    }
  }

  async function discoverTuiSession(): Promise<TuiSession | null> {
    const cwd = getCwdBase()
    const url = `${serverUrl}/session?roots=true&limit=1&directory=${encodeURIComponent(cwd)}`

    try {
      const resp = await fetch(url)
      if (!resp.ok) return null

      const sessions = (await resp.json()) as TuiSession[]
      const candidate = sessions[0] ?? null
      if (!candidate) return null

      const exists = await sessionExistsOnServer(candidate.id)
      if (!exists) {
        logger.warn(`Discovered TUI session ${candidate.id} returned 404, skipping`)
        return null
      }

      return candidate
    } catch {
      return null
    }
  }

  async function createNewSession(feishuKey: string): Promise<string> {
    const resp = await fetch(`${serverUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: `Feishu chat ${feishuKey}` }),
    })

    if (!resp.ok) {
      throw new Error(`Failed to create session: HTTP ${resp.status}`)
    }

    const data = (await resp.json()) as { id: string }
    return data.id
  }

  /** Query the opencode global API for the most recently active root session
   *  in the given directory. Returns null on failure or when none exists. */

  async function findRecentSession(directory: string): Promise<string | null> {
    const url = `${serverUrl}/api/session?directory=${encodeURIComponent(directory)}&limit=100`

    try {
      const resp = await fetch(url)
      if (!resp.ok) return null

      const body = (await resp.json()) as { data: V2SessionInfo[] }
      const roots = body.data.filter((session) => !session.parentID)
      const recent = roots.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))[0]
      return recent?.id ?? null
    } catch {
      return null
    }
  }

  /** Try the paginated v2 endpoint first (newest page first). The response is
   *  expected to be non-empty; some opencode versions return an empty `data` here,
   *  in which case the v1 endpoint is used as a fallback. */

  async function getRecentAssistantSummary(sessionId: string): Promise<AssistantSummary | null> {
    const fromV2 = await fetchSummaryV2(sessionId)
    if (fromV2) return fromV2
    return fetchSummaryV1(sessionId)
  }

  async function fetchSummaryV2(sessionId: string): Promise<AssistantSummary | null> {
    try {
      const resp = await fetch(`${serverUrl}/api/session/${sessionId}/message?order=desc&limit=200`)
      if (!resp.ok) return null
      const body = (await resp.json()) as { data: SummaryMessage[] }
      if (!Array.isArray(body.data) || body.data.length === 0) return null
      // The API returns newest-first; the summarizer expects chronological (oldest-first).
      return buildRecentAssistantSummary(body.data.slice().reverse())
    } catch {
      return null
    }
  }

  /** v1 fallback — returns the whole session as WithParts ({ info.role, parts[] }). */

  async function fetchSummaryV1(sessionId: string): Promise<AssistantSummary | null> {
    try {
      const resp = await fetch(`${serverUrl}/session/${sessionId}/message?limit=100`)
      if (!resp.ok) return null
      const messages = (await resp.json()) as Array<{
        info?: { role?: string }
        parts?: Array<{ type?: string; text?: string; name?: string; tool?: string }>
      }>
      if (!Array.isArray(messages) || messages.length === 0) return null
      return buildRecentAssistantSummary(
        messages.map((m) => ({ role: m.info?.role, content: m.parts ?? [] })),
      )
    } catch {
      return null
    }
  }

  return {
    async getOrCreate(feishuKey, agent) {
      const existing = getStmt.get(feishuKey) as SessionMapping | null
      if (existing) {
        updateActiveStmt.run(Date.now(), feishuKey)
        return existing.session_id
      }

      const agentName = agent ?? defaultAgent
      logger.info(`Resolving session for ${feishuKey} (agent: ${agentName})`)

      const discovered = await discoverTuiSession()
      if (discovered) {
        const now = Date.now()
        upsertStmt.run(feishuKey, discovered.id, agentName, defaultModel, now, now, 1)

        logger.info(`Bound to TUI session: ${feishuKey} → ${discovered.id}`)

        return discovered.id
      }

      const sessionId = await createNewSession(feishuKey)
      const now = Date.now()
      upsertStmt.run(feishuKey, sessionId, agentName, defaultModel, now, now, 0)

      logger.info(`Session created: ${feishuKey} → ${sessionId}`)

      return sessionId
    },

    async getExisting(feishuKey) {
      const existing = getStmt.get(feishuKey) as SessionMapping | null
      return existing?.session_id
    },

    getSession(feishuKey) {
      return (getStmt.get(feishuKey) as SessionMapping | undefined) ?? null
    },

    deleteMapping(feishuKey) {
      const result = deleteMappingStmt.run(feishuKey)
      if (result.changes > 0) {
        logger.info(`Deleted session mapping for ${feishuKey}`)
      }
      return result.changes > 0
    },

    setMapping(feishuKey, sessionId, agent) {
      const existing = getStmt.get(feishuKey) as SessionMapping | null
      const sameSession = existing?.session_id === sessionId
      const agentName = agent ?? (sameSession ? existing?.agent : defaultAgent) ?? defaultAgent

      const now = Date.now()
      const nextModel = existing?.model ?? defaultModel

      const result = upsertStmt.run(feishuKey, sessionId, agentName, nextModel, now, now, 1)
      if (result.changes > 0) {
        logger.info(`Set session mapping: ${feishuKey} -> ${sessionId}`)
      }
      return result.changes > 0
    },

    setModel(feishuKey, model) {
      const now = Date.now()
      const result = updateModelStmt.run(model, now, feishuKey)
      if (result.changes > 0) {
        logger.info(`Updated model mapping for ${feishuKey}: ${model ?? "(cleared)"}`)
      }
      return result.changes > 0
    },

    findRecentSession,

    getRecentAssistantSummary,

    cleanup(maxAgeMs = 30 * 60 * 1000) {
      const cutoff = Date.now() - maxAgeMs
      const result = cleanupStmt.run(cutoff)
      if (result.changes > 0) {
        logger.info(`Cleaned up ${result.changes} expired session mappings`)
      }
      return result.changes
    },

    async validateAndCleanupStale() {
      const allMappingsStmt = db.prepare("SELECT * FROM feishu_sessions")
      const allMappings = allMappingsStmt.all() as SessionMapping[]
      let cleaned = 0

      for (const mapping of allMappings) {
        try {
          const exists = await sessionExistsOnServer(mapping.session_id)
          if (!exists) {
            deleteMappingStmt.run(mapping.feishu_key)
            cleaned++
            logger.info(`Startup cleanup: removed stale mapping ${mapping.feishu_key} -> ${mapping.session_id}`)
          }
        } catch (err) {
          logger.warn(`Startup cleanup: failed to validate ${mapping.session_id}: ${err}`)
        }
      }

      if (cleaned > 0) {
        logger.info(`Startup cleanup: removed ${cleaned} stale session mapping(s)`)
      } else if (allMappings.length > 0) {
        logger.info(`Startup cleanup: all ${allMappings.length} session mapping(s) valid`)
      }

      return cleaned
    },
  }
}
