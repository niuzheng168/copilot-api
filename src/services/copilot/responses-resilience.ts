import consola from "consola"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import type { ResponsesPayload } from "~/lib/types/responses"

import { PATHS } from "~/lib/paths"

type EncryptedHistoryItemType = "reasoning" | "compaction"

export interface EncryptedHistoryItem {
  encryptedContent: string
  hash: string
  index: number
  type: EncryptedHistoryItemType
}

interface StaleEncryptedContentEntry {
  firstSeenAt: string
  lastSeenAt: string
  recoveries: number
  type?: EncryptedHistoryItemType
}

interface StaleEncryptedContentState {
  version: 1
  updatedAt: string
  entries: Record<string, StaleEncryptedContentEntry>
}

export interface EncryptedHistoryStore {
  has(hash: string): boolean
  record(items: Array<EncryptedHistoryItem>): void
}

interface SanitizedEncryptedHistory<T> {
  payload: T
  removed: Array<EncryptedHistoryItem>
}

const RECOVERABLE_ITEM_TYPES = new Set<EncryptedHistoryItemType>([
  "reasoning",
  "compaction",
])
const RECOVERABLE_ERROR_PHRASES = [
  "encrypted content",
  "encrypted function output",
  "could not be decrypted",
  "could not be verified",
]
const MAX_STALE_ENTRIES = 100_000
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const DEFAULT_STORE_PATH = path.join(
  PATHS.APP_DIR,
  "invalid-encrypted-content.json",
)

export const hashEncryptedContent = (value: string): string =>
  createHash("sha256").update(value).digest("hex")

export const listEncryptedHistoryItems = (
  payload: unknown,
): Array<EncryptedHistoryItem> => {
  if (!isRecord(payload) || !Array.isArray(payload.input)) return []

  const items: Array<EncryptedHistoryItem> = []
  payload.input.forEach((item, index) => {
    if (!isRecord(item)) return
    if (item.type !== "reasoning" && item.type !== "compaction") {
      return
    }
    if (
      typeof item.encrypted_content !== "string"
      || item.encrypted_content.length === 0
    ) {
      return
    }

    items.push({
      encryptedContent: item.encrypted_content,
      hash: hashEncryptedContent(item.encrypted_content),
      index,
      type: item.type,
    })
  })
  return items
}

export const sanitizeEncryptedHistory = <T extends { input?: unknown }>(
  payload: T,
  shouldRemove: (item: EncryptedHistoryItem) => boolean = () => true,
): SanitizedEncryptedHistory<T> => {
  if (!Array.isArray(payload.input)) return { payload, removed: [] }

  const removableItems = listEncryptedHistoryItems(payload).filter(shouldRemove)
  if (removableItems.length === 0) return { payload, removed: [] }

  const removableIndexes = new Set(removableItems.map((item) => item.index))
  return {
    payload: {
      ...payload,
      input: payload.input.filter((_, index) => !removableIndexes.has(index)),
    },
    removed: removableItems,
  }
}

export const isRecoverableEncryptedHistoryError = (
  status: number,
  bodyText: string,
): boolean => {
  if (status !== 400) return false

  const normalizedBody = bodyText.toLowerCase()
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText) as unknown
  } catch {
    return (
      normalizedBody.includes("invalid_request_body")
      && RECOVERABLE_ERROR_PHRASES.some((phrase) =>
        normalizedBody.includes(phrase),
      )
    )
  }

  const error =
    isRecord(parsed) && isRecord(parsed.error) ? parsed.error : parsed
  if (!isRecord(error) || error.code !== "invalid_request_body") return false

  const hasMessage = Object.hasOwn(error, "message")
  const message = typeof error.message === "string" ? error.message : ""
  if (hasMessage && message.trim().length === 0) return true

  const normalizedMessage = message.toLowerCase()
  return RECOVERABLE_ERROR_PHRASES.some(
    (phrase) =>
      normalizedMessage.includes(phrase) || normalizedBody.includes(phrase),
  )
}

export class StaleEncryptedContentStore implements EncryptedHistoryStore {
  private readonly entries = new Map<string, StaleEncryptedContentEntry>()
  private readonly filePath: string
  private loaded = false

  constructor(filePath = DEFAULT_STORE_PATH) {
    this.filePath = filePath
  }

  get size(): number {
    this.load()
    return this.entries.size
  }

  has(hash: string): boolean {
    this.load()
    return this.entries.has(hash)
  }

  record(items: Array<EncryptedHistoryItem>): void {
    this.load()
    const now = new Date().toISOString()
    const uniqueItems = new Map(items.map((item) => [item.hash, item]))

    for (const item of uniqueItems.values()) {
      const existing = this.entries.get(item.hash)
      this.entries.set(item.hash, {
        firstSeenAt: existing?.firstSeenAt ?? now,
        lastSeenAt: now,
        recoveries: (existing?.recoveries ?? 0) + 1,
        type: existing?.type ?? item.type,
      })
    }

    this.prune()
    this.flush(now)
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true

    let raw: string
    try {
      raw = fs.readFileSync(this.filePath, "utf8")
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        consola.warn("Failed to read stale encrypted-content state", error)
      }
      return
    }

    try {
      const parsed = JSON.parse(raw) as unknown
      this.loadState(parsed)
      this.prune()
    } catch (error) {
      consola.warn("Failed to parse stale encrypted-content state", error)
    }
  }

  private loadState(value: unknown): void {
    if (!isRecord(value) || value.version !== 1) return

    if (Array.isArray(value.hashes)) {
      const timestamp =
        typeof value.updated_at === "string" ?
          value.updated_at
        : new Date(0).toISOString()
      for (const hash of value.hashes) {
        if (typeof hash !== "string" || !SHA256_PATTERN.test(hash)) continue
        this.entries.set(hash, {
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          recoveries: 1,
        })
      }
      return
    }

    if (!isRecord(value.entries)) return
    for (const [hash, entry] of Object.entries(value.entries)) {
      if (!SHA256_PATTERN.test(hash) || !isRecord(entry)) continue
      const firstSeenAt =
        typeof entry.firstSeenAt === "string" ?
          entry.firstSeenAt
        : new Date(0).toISOString()
      const lastSeenAt =
        typeof entry.lastSeenAt === "string" ? entry.lastSeenAt : firstSeenAt
      const recoveries =
        (
          typeof entry.recoveries === "number"
          && Number.isFinite(entry.recoveries)
        ) ?
          Math.max(0, Math.floor(entry.recoveries))
        : 0
      const type =
        (
          typeof entry.type === "string"
          && RECOVERABLE_ITEM_TYPES.has(entry.type as EncryptedHistoryItemType)
        ) ?
          (entry.type as EncryptedHistoryItemType)
        : undefined

      this.entries.set(hash, {
        firstSeenAt,
        lastSeenAt,
        recoveries,
        ...(type ? { type } : {}),
      })
    }
  }

  private prune(): void {
    if (this.entries.size <= MAX_STALE_ENTRIES) return

    const oldest = [...this.entries.entries()].sort(
      ([, left], [, right]) =>
        Date.parse(left.lastSeenAt) - Date.parse(right.lastSeenAt),
    )
    const removeCount = oldest.length - MAX_STALE_ENTRIES
    for (const [hash] of oldest.slice(0, removeCount)) {
      this.entries.delete(hash)
    }
  }

  private flush(updatedAt: string): void {
    const state: StaleEncryptedContentState = {
      version: 1,
      updatedAt,
      entries: Object.fromEntries(this.entries),
    }
    const directory = path.dirname(this.filePath)
    const temporaryPath = `${this.filePath}.tmp-${process.pid}`

    fs.mkdirSync(directory, { mode: 0o700, recursive: true })
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      })
      fs.renameSync(temporaryPath, this.filePath)
    } finally {
      if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath)
    }
  }
}

export const staleEncryptedContentStore = new StaleEncryptedContentStore()

export const fetchCopilotResponsesWithRecovery = async (
  payload: ResponsesPayload,
  send: (nextPayload: ResponsesPayload) => Promise<Response>,
  store: EncryptedHistoryStore = staleEncryptedContentStore,
): Promise<Response> => {
  const proactive = sanitizeEncryptedHistory(payload, (item) =>
    store.has(item.hash),
  )
  if (proactive.removed.length > 0) {
    consola.info(
      `Removed ${proactive.removed.length} known stale encrypted history item(s)`,
    )
  }

  const firstResponse = await send(proactive.payload)
  if (firstResponse.status !== 400) return firstResponse

  const firstBody = await readResponseBody(firstResponse)
  if (
    firstBody === null
    || !isRecoverableEncryptedHistoryError(firstResponse.status, firstBody)
  ) {
    return firstResponse
  }

  const retry = sanitizeEncryptedHistory(proactive.payload)
  if (retry.removed.length === 0) return firstResponse

  consola.warn(
    `Retrying Copilot Responses without ${retry.removed.length} stale encrypted history item(s)`,
  )
  await cancelResponseBody(firstResponse)
  const retryResponse = await send(retry.payload)

  if (retryResponse.status < 400) {
    try {
      store.record(retry.removed)
    } catch (error) {
      consola.warn("Failed to persist stale encrypted-content state", error)
    }
  }

  return retryResponse
}

const readResponseBody = async (response: Response): Promise<string | null> => {
  try {
    return await response.clone().text()
  } catch (error) {
    consola.warn("Failed to inspect Copilot Responses error body", error)
    return null
  }
}

const cancelResponseBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel()
  } catch (error) {
    consola.debug("Failed to cancel rejected Copilot Responses body", error)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)

const isNodeError = (value: unknown): value is NodeJS.ErrnoException =>
  value instanceof Error && "code" in value
