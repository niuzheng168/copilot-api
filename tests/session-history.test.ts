import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import assert from "node:assert/strict"
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import type { SqliteDatabase } from "~/lib/sqlite"
import { SessionHistoryService } from "~/lib/session-history"
import { createSessionHistoryRoutes } from "~/routes/session-history/route"

let root: string
let codexHome: string
let database: Database
let service: SessionHistoryService

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "copilot-api-session-history-"))
  codexHome = path.join(root, ".codex")
  const sessions = path.join(codexHome, "sessions")
  const archivedSessions = path.join(codexHome, "archived_sessions")
  await Promise.all([
    mkdir(sessions, { recursive: true }),
    mkdir(archivedSessions, { recursive: true }),
  ])

  const activeRollout = path.join(sessions, "active.jsonl")
  const archivedRollout = path.join(archivedSessions, "archived.jsonl")
  await Promise.all([
    writeFile(
      activeRollout,
      [
        {
          timestamp: "2026-08-15T00:00:00Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Active question" },
        },
        {
          timestamp: "2026-08-15T00:00:01Z",
          type: "event_msg",
          payload: { type: "agent_message", message: "Active answer" },
        },
        {
          timestamp: "2026-08-15T00:00:02Z",
          type: "event_msg",
          payload: { type: "task_started", message: "Ignored event" },
        },
      ]
        .map((value) => JSON.stringify(value))
        .join("\n") + "\n",
    ),
    writeFile(archivedRollout, ""),
  ])

  await writeFile(path.join(codexHome, "state_5.sqlite"), "")
  database = new Database(":memory:")
  database.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      title TEXT,
      cwd TEXT,
      archived INTEGER,
      rollout_path TEXT,
      updated_at INTEGER
    );
  `)
  database
    .prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)")
    .run(
      "active-session",
      "Active title",
      "/work/active",
      0,
      activeRollout,
      200,
    )
  database
    .prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)")
    .run(
      "archived-session",
      "Archived title",
      "/work/old",
      1,
      archivedRollout,
      100,
    )
  const databaseAdapter: SqliteDatabase = {
    exec: database.exec.bind(database),
    prepare: database.prepare.bind(database),
  }
  service = new SessionHistoryService({
    codexHome,
    openDatabase: () => Promise.resolve(databaseAdapter),
  })
})

afterEach(async () => {
  database.close()
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  })
})

describe("Codex session history service", () => {
  test("a new machine returns empty history without creating a fake Codex database", async () => {
    const freshHome = path.join(root, "fresh-codex")
    let opens = 0
    const fresh = new SessionHistoryService({
      codexHome: freshHome,
      openDatabase: () => {
        opens++
        return Promise.reject(
          new Error("An absent database must not be opened or initialized"),
        )
      },
    })
    const result = await fresh.list({ limit: 10, offset: 0 })
    expect(result.items).toEqual([])
    expect(result.total).toBe(0)
    expect(result.has_more).toBe(false)
    expect(opens).toBe(0)
    await assert.rejects(fresh.detail("active", "unknown"), {
      status: 404,
    })
  })

  test("missing history is not cached after Codex creates its real database", async () => {
    await rm(path.join(codexHome, "state_5.sqlite"))
    expect((await service.list()).items).toEqual([])
    await writeFile(path.join(codexHome, "state_5.sqlite"), "")
    expect((await service.list()).total).toBe(2)
  })

  test.skipIf(process.platform === "win32")(
    "permission failures are not misreported as an empty new machine",
    async () => {
      await chmod(codexHome, 0o000)
      try {
        await assert.rejects(service.list(), { status: 503 })
      } finally {
        await chmod(codexHome, 0o700)
      }
    },
  )

  test("filters and paginates local Codex threads before reading rollout metadata", async () => {
    const all = await service.list({ state: "all", limit: 1 })
    expect(all.total).toBe(2)
    expect(all.has_more).toBe(true)
    expect(all.items.map((item) => item.session_name)).toEqual([
      "active-session",
    ])
    expect(all.items[0]?.timestamp_ms).toBe(200_000)
    expect(all.items[0]?.archive_size_bytes).toBeGreaterThan(0)

    const recent = await service.list({
      state: "all",
      startAtMs: 150_000,
      limit: 10,
    })
    expect(recent.total).toBe(1)
    expect(recent.items[0]?.session_name).toBe("active-session")

    const archived = await service.list({
      state: "archived",
      query: "old",
      limit: 10,
    })
    expect(archived.total).toBe(1)
    expect(archived.items[0]?.state).toBe("archived")
  })

  test("returns a bounded transcript and rejects state mismatches", async () => {
    const detail = await service.detail("active", "active-session")

    expect(detail.transport).toBe("copilot-api")
    expect(detail.transcript.messages.map((message) => message.text)).toEqual([
      "Active question",
      "Active answer",
    ])
    expect(detail.transcript.truncated).toBe(false)
    const stateMismatch = await service
      .detail("archived", "active-session")
      .catch((error: unknown) => error)
    expect(stateMismatch).toMatchObject({ status: 404 })
    const unsafeId = await service
      .detail("active", "../state_5.sqlite")
      .catch((error: unknown) => error)
    expect(unsafeId).toMatchObject({ status: 400 })
  })
})

describe("Codex session history route", () => {
  test("requires its dedicated key and validates query parameters", async () => {
    const routes = createSessionHistoryRoutes({
      getApiKeys: () => ["session-secret"],
      service,
    })

    expect((await routes.request("/")).status).toBe(401)
    const authorized = await routes.request(
      "/?state=all&start_at_ms=150000&limit=10",
      { headers: { "x-api-key": "session-secret" } },
    )
    expect(authorized.status).toBe(200)
    const payload = (await authorized.json()) as { total: number }
    expect(payload.total).toBe(1)

    const invalid = await routes.request("/?start_at_ms=tomorrow", {
      headers: { "x-api-key": "session-secret" },
    })
    expect(invalid.status).toBe(400)
  })

  test("does not become public when no session key is configured", async () => {
    const routes = createSessionHistoryRoutes({
      getApiKeys: () => [],
      service,
    })
    expect((await routes.request("/")).status).toBe(401)
  })
})
