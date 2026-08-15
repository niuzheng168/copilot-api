import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { openSqliteDatabase, type SqliteDatabase } from "./sqlite"

const MAX_THREAD_ROWS = 20_000
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024
const MAX_TRANSCRIPT_CHARS = 2 * 1024 * 1024
const MAX_TRANSCRIPT_MESSAGES = 300
const MAX_MESSAGE_CHARS = 65_536
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

const THREAD_COLUMNS = [
  "id",
  "title",
  "name",
  "preview",
  "first_user_message",
  "cwd",
  "archived",
  "rollout_path",
  "created_at",
  "updated_at",
  "created_at_ms",
  "updated_at_ms",
  "recency_at",
  "recency_at_ms",
  "cli_version",
  "model",
  "model_provider",
  "git_branch",
  "git_sha",
] as const

const TIMESTAMP_COLUMNS = [
  "recency_at_ms",
  "updated_at_ms",
  "recency_at",
  "updated_at",
  "created_at_ms",
  "created_at",
] as const

type SessionHistoryState = "active" | "all" | "archived"
type SqliteRow = Record<string, unknown>

export interface SessionHistoryListOptions {
  limit?: number
  offset?: number
  query?: string
  startAtMs?: number
  state?: SessionHistoryState
}

export interface SessionHistoryServiceOptions {
  codexHome?: string
  openDatabase?: (dbPath: string) => Promise<SqliteDatabase>
}

export class SessionHistoryRequestError extends Error {
  readonly status: 400 | 404 | 503

  constructor(message: string, status: 400 | 404 | 503) {
    super(message)
    this.name = "SessionHistoryRequestError"
    this.status = status
  }
}

function asRow(value: unknown): SqliteRow {
  return value !== null && typeof value === "object" && !Array.isArray(value) ?
      (value as SqliteRow)
    : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function timestampMs(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value > 1_000_000_000_000 ? value : value * 1000)
  }
  if (typeof value !== "string" || !value.trim()) {
    return fallback
  }
  const raw = value.trim()
  const numeric = Number(raw)
  if (Number.isFinite(numeric)) {
    return Math.trunc(numeric > 1_000_000_000_000 ? numeric : numeric * 1000)
  }
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

function rowTimestampMs(row: SqliteRow, fallback = 0): number {
  for (const column of TIMESTAMP_COLUMNS) {
    if (row[column] !== null && row[column] !== undefined) {
      return timestampMs(row[column], fallback)
    }
  }
  return fallback
}

function isArchived(row: SqliteRow): boolean {
  return Number(row.archived ?? 0) !== 0
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir()
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2))
  }
  return value
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === ""
    || (!relative.startsWith("..") && !path.isAbsolute(relative))
  )
}

async function resolveRollout(
  codexHome: string,
  rawPath: unknown,
): Promise<{ path: string; size: number; mtimeMs: number } | null> {
  const requestedPath = text(rawPath)
  if (!requestedPath) return null

  try {
    const [root, candidate] = await Promise.all([
      fs.realpath(codexHome),
      fs.realpath(path.resolve(expandHome(requestedPath))),
    ])
    if (!isWithinRoot(root, candidate)) return null
    const stat = await fs.stat(candidate)
    if (!stat.isFile()) return null
    return { path: candidate, size: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return null
  }
}

function summaryFor(row: SqliteRow): string {
  return (
    text(row.title)
    || text(row.name)
    || text(row.preview)
    || text(row.first_user_message)
    || (text(row.cwd) ? `Workspace: ${text(row.cwd)}` : "Codex session")
  )
}

function primitiveMetadata(
  row: SqliteRow,
): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(row).filter(
      (entry): entry is [string, string | number | boolean | null] =>
        entry[1] === null
        || ["string", "number", "boolean"].includes(typeof entry[1]),
    ),
  )
}

async function readTranscript(
  rolloutPath: string,
  rolloutSize: number,
): Promise<{
  message_count: number
  messages: Array<{
    role: "assistant" | "user"
    text: string
    timestamp: unknown
  }>
  truncated: boolean
}> {
  const start = Math.max(0, rolloutSize - MAX_TRANSCRIPT_BYTES)
  const length = rolloutSize - start
  const handle = await fs.open(rolloutPath, "r")
  let contents: string
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    contents = buffer.subarray(0, bytesRead).toString("utf8")
  } finally {
    await handle.close()
  }

  if (start > 0) {
    const firstNewline = contents.indexOf("\n")
    contents = firstNewline >= 0 ? contents.slice(firstNewline + 1) : ""
  }

  const messages: Array<{
    role: "assistant" | "user"
    text: string
    timestamp: unknown
  }> = []
  let totalChars = 0
  let truncated = start > 0

  for (const line of contents.split("\n")) {
    if (!line) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    const event = asRow(value)
    if (event.type !== "event_msg") continue
    const payload = asRow(event.payload)
    const role =
      payload.type === "user_message" ? "user"
      : payload.type === "agent_message" ? "assistant"
      : null
    if (role === null || typeof payload.message !== "string") continue
    const message = payload.message.trim()
    if (!message) continue
    const boundedMessage = message.slice(0, MAX_MESSAGE_CHARS)
    messages.push({
      role,
      text: boundedMessage,
      timestamp: event.timestamp ?? null,
    })
    totalChars += boundedMessage.length
    while (
      messages.length > MAX_TRANSCRIPT_MESSAGES
      || totalChars > MAX_TRANSCRIPT_CHARS
    ) {
      const removed = messages.shift()
      if (!removed) break
      totalChars -= removed.text.length
      truncated = true
    }
  }

  return {
    messages,
    message_count: messages.length,
    truncated,
  }
}

export class SessionHistoryService {
  readonly codexHome: string
  private readonly openDatabase: (dbPath: string) => Promise<SqliteDatabase>

  constructor(options: SessionHistoryServiceOptions = {}) {
    this.codexHome = path.resolve(
      options.codexHome
        ?? process.env.CODEX_HOME?.trim()
        ?? path.join(os.homedir(), ".codex"),
    )
    this.openDatabase = options.openDatabase ?? openSqliteDatabase
  }

  async list(options: SessionHistoryListOptions = {}) {
    const state = options.state ?? "all"
    const query = (options.query ?? "").trim().toLocaleLowerCase()
    const limit = options.limit ?? 50
    const offset = options.offset ?? 0
    const startAtMs = options.startAtMs ?? 0

    const rows = await this.withDatabase((db) => {
      const columns = this.threadColumns(db)
      const selected = THREAD_COLUMNS.filter((column) => columns.has(column))
      if (!selected.includes("id")) {
        throw new SessionHistoryRequestError(
          "Codex threads table does not contain id",
          503,
        )
      }
      return db
        .prepare(`SELECT ${selected.join(", ")} FROM threads LIMIT ?`)
        .all(MAX_THREAD_ROWS + 1)
        .map(asRow)
    })
    if (rows.length > MAX_THREAD_ROWS) {
      throw new SessionHistoryRequestError(
        `Codex session history exceeds the ${MAX_THREAD_ROWS} row safety limit`,
        503,
      )
    }

    const filtered = rows
      .map((row) => ({ row, timestamp_ms: rowTimestampMs(row) }))
      .filter(({ row, timestamp_ms }) => {
        if (state !== "all" && isArchived(row) !== (state === "archived")) {
          return false
        }
        if (startAtMs > 0 && timestamp_ms < startAtMs) return false
        if (!query) return true
        return [row.id, row.title, row.name, row.cwd].some((value) =>
          text(value).toLocaleLowerCase().includes(query),
        )
      })
      .sort(
        (left, right) =>
          right.timestamp_ms - left.timestamp_ms
          || text(right.row.id).localeCompare(text(left.row.id)),
      )

    const items = await Promise.all(
      filtered
        .slice(offset, offset + limit)
        .map(async ({ row, timestamp_ms }) => {
          const rollout = await resolveRollout(this.codexHome, row.rollout_path)
          return {
            session_name: text(row.id),
            source_session_id: text(row.id),
            state: isArchived(row) ? "archived" : "active",
            title: text(row.title) || text(row.name),
            cwd: text(row.cwd),
            timestamp_ms: timestamp_ms || rollout?.mtimeMs || 0,
            archive_size_bytes: rollout?.size ?? 0,
            handoff_summary: summaryFor(row),
          }
        }),
    )

    return {
      items,
      total: filtered.length,
      limit,
      offset,
      has_more: offset + limit < filtered.length,
      permissions: { can_manage: false },
      transport: "copilot-api",
    }
  }

  async detail(state: Exclude<SessionHistoryState, "all">, sessionId: string) {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new SessionHistoryRequestError("Session ID is invalid", 400)
    }
    const row = await this.withDatabase((db) =>
      asRow(
        db.prepare("SELECT * FROM threads WHERE id = ? LIMIT 1").get(sessionId),
      ),
    )
    if (!text(row.id) || isArchived(row) !== (state === "archived")) {
      throw new SessionHistoryRequestError("Session was not found", 404)
    }
    const rollout = await resolveRollout(this.codexHome, row.rollout_path)
    if (!rollout) {
      throw new SessionHistoryRequestError("Session rollout was not found", 404)
    }
    const transcript = await readTranscript(rollout.path, rollout.size)
    const timestamp = rowTimestampMs(row, rollout.mtimeMs)
    return {
      session: {
        ...primitiveMetadata(row),
        session_name: sessionId,
        source_session_id: sessionId,
        state,
        timestamp_ms: timestamp,
        archive_size_bytes: rollout.size,
        handoff_summary: summaryFor(row),
      },
      transcript,
      transcript_error: null,
      permissions: { can_manage: false },
      transport: "copilot-api",
    }
  }

  private threadColumns(db: SqliteDatabase): Set<string> {
    return new Set(
      db
        .prepare("PRAGMA table_info(threads)")
        .all()
        .map((value) => text(asRow(value).name))
        .filter(Boolean),
    )
  }

  private async withDatabase<T>(
    operation: (db: SqliteDatabase) => T,
  ): Promise<T> {
    const dbPath = path.join(this.codexHome, "state_5.sqlite")
    try {
      await fs.access(dbPath)
    } catch {
      throw new SessionHistoryRequestError(
        "Codex session database is unavailable",
        503,
      )
    }

    const db = await this.openDatabase(dbPath)
    try {
      return operation(db)
    } finally {
      db.close?.()
    }
  }
}

export const sessionHistoryInternals = Object.freeze({
  MAX_TRANSCRIPT_BYTES,
  SESSION_ID_PATTERN,
  timestampMs,
})
