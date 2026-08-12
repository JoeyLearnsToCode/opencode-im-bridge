# session/

Thread-to-session binding and progress feedback. Knows which opencode session a Feishu thread is talking to, and shows "thinking..." cards while the agent works.

## Files

### `session-manager.ts`
The source of truth for thread→session mappings.

Key methods:
- `getOrCreate(threadKey)` — returns the session bound to a thread, creating a new binding if none exists. When creating, it queries the opencode API to discover live sessions for the configured working directory, then picks the most recently active one.
- `getExisting(threadKey)` — returns the current session ID for a thread without creating anything. Returns `undefined` if the thread isn't connected. Use this for read-only operations (e.g. `/sessions` command) to avoid accidentally spawning sessions.
- `findRecentSession(directory)` — queries the opencode global API (`/api/session?directory=...`) for the most recently active root session in the given directory, returning its ID or `null` when none exists. Used by `/projects` to reuse an existing project's latest session instead of creating a new one.
- `getRecentAssistantSummary(sessionId)` — fetches the newest page of messages via the paginated v2 endpoint (`/api/session/{id}/message?order=desc&limit=200`, so the server returns the most recent messages first without scanning all history) and summarizes the most recent assistant turn: walks messages newest-first, stops at the first user message, keeps text parts (capped at `MAX_ASSISTANT_SUMMARY_LENGTH` = 500 CJK chars + words) and deduplicated tool names (not counted toward the cap). Used by `/connect` and `/projects` to show what the agent last said when resuming a session.

Mappings are persisted in SQLite (via `src/utils/db.ts`) so bindings survive process restarts. A thread stays bound to its session until explicitly disconnected (via `/new` or `/connect`).

The thread key format is `{chatId}:{rootId}` for threaded group chats, `{chatId}:{messageId}` for non-threaded group messages, or just `{chatId}` for p2p chats.

### `progress-tracker.ts`
Sends a "thinking..." placeholder card to Feishu when the agent starts processing, then clears or updates it once the response begins streaming. Prevents the Feishu chat from looking unresponsive during long agent turns.

Lifecycle:
1. `show(threadKey)` — sends the placeholder card, stores the `cardId`
2. `update(threadKey, text)` — replaces the card content (used for tool progress)
3. `dismiss(threadKey)` — removes or replaces with final content

## Gotchas

- `getOrCreate` talks to the opencode API during its "discover sessions" step. If opencode is unreachable, it throws. Catch this at the call site in `MessageHandler`.
- SQLite writes are synchronous in bun. Don't call session methods in a tight loop.
- Two Feishu threads can share the same opencode session (e.g. after `/connect`). The mapping is many-threads-to-one-session.
- If no live opencode sessions exist for the CWD, `getOrCreate` creates a new session via the opencode API. It only throws if the HTTP request itself fails.
