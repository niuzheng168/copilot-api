import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { ResponsesPayload } from "~/lib/types/responses"

import {
  fetchCopilotResponsesWithRecovery,
  hashEncryptedContent,
  isRecoverableEncryptedHistoryError,
  sanitizeEncryptedHistory,
  StaleEncryptedContentStore,
  type EncryptedHistoryItem,
  type EncryptedHistoryStore,
} from "~/services/copilot/responses-resilience"

const tempDirectories: Array<string> = []

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true })
  }
})

describe("Copilot Responses encrypted-history recovery", () => {
  test("sanitizes only encrypted reasoning and compaction items", () => {
    const payload: ResponsesPayload = {
      input: [
        { content: "keep", role: "user" },
        {
          encrypted_content: "reasoning-ciphertext",
          id: "reasoning-1",
          summary: [],
          type: "reasoning",
        },
        {
          encrypted_content: "compaction-ciphertext",
          id: "compaction-1",
          type: "compaction",
        },
        { type: "compaction_trigger" },
        {
          call_id: "call-1",
          output: "encrypted function output",
          type: "function_call_output",
        },
      ],
      model: "gpt-test",
    }

    const sanitized = sanitizeEncryptedHistory(payload)

    expect(sanitized.removed.map((item) => item.type)).toEqual([
      "reasoning",
      "compaction",
    ])
    expect(sanitized.payload.input).toEqual([
      { content: "keep", role: "user" },
      { type: "compaction_trigger" },
      {
        call_id: "call-1",
        output: "encrypted function output",
        type: "function_call_output",
      },
    ])
    expect(payload.input).toHaveLength(5)
  })

  test("matches only recoverable invalid encrypted-history errors", () => {
    expect(
      isRecoverableEncryptedHistoryError(
        400,
        JSON.stringify({
          error: {
            code: "invalid_request_body",
            message: "Encrypted content could not be decrypted",
          },
        }),
      ),
    ).toBe(true)
    expect(
      isRecoverableEncryptedHistoryError(
        400,
        JSON.stringify({
          error: { code: "invalid_request_body", message: "" },
        }),
      ),
    ).toBe(true)
    expect(
      isRecoverableEncryptedHistoryError(
        400,
        JSON.stringify({
          error: { code: "invalid_request_body", message: "Invalid model" },
        }),
      ),
    ).toBe(false)
    expect(
      isRecoverableEncryptedHistoryError(
        500,
        "invalid_request_body: encrypted content",
      ),
    ).toBe(false)
  })

  test("proactively removes known hashes and learns successful retries", async () => {
    const knownCiphertext = "known-stale"
    const newCiphertext = "new-stale"
    const recorded: Array<EncryptedHistoryItem> = []
    const knownHashes = new Set([hashEncryptedContent(knownCiphertext)])
    const store: EncryptedHistoryStore = {
      has: (hash) => knownHashes.has(hash),
      record: (items) => {
        recorded.push(...items)
      },
    }
    const payload = createRecoveryPayload(knownCiphertext, newCiphertext)
    const sentPayloads: Array<ResponsesPayload> = []

    const response = await fetchCopilotResponsesWithRecovery(
      payload,
      (nextPayload) => {
        sentPayloads.push(nextPayload)
        if (sentPayloads.length === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: {
                  code: "invalid_request_body",
                  message: "Encrypted content could not be verified",
                },
              }),
              { status: 400 },
            ),
          )
        }
        return Promise.resolve(new Response("ok", { status: 200 }))
      },
      store,
    )

    expect(response.status).toBe(200)
    expect(sentPayloads).toHaveLength(2)
    expect(sentPayloads[0]?.input).toHaveLength(2)
    expect(sentPayloads[1]?.input).toEqual([
      { content: "continue", role: "user" },
    ])
    expect(recorded.map((item) => item.encryptedContent)).toEqual([
      newCiphertext,
    ])
  })

  test("returns a failed retry without learning its hashes", async () => {
    const recorded: Array<EncryptedHistoryItem> = []
    const store: EncryptedHistoryStore = {
      has: () => false,
      record: (items) => {
        recorded.push(...items)
      },
    }
    let attempts = 0

    const response = await fetchCopilotResponsesWithRecovery(
      createRecoveryPayload("reasoning", "compaction"),
      () => {
        attempts += 1
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: "invalid_request_body",
                message: "Encrypted content could not be verified",
              },
              attempt: attempts,
            }),
            { status: 400 },
          ),
        )
      },
      store,
    )

    expect(attempts).toBe(2)
    expect((await response.json()) as { attempt: number }).toMatchObject({
      attempt: 2,
    })
    expect(recorded).toEqual([])
  })

  test("persists fingerprints without storing encrypted content", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot-api-resilience-"),
    )
    tempDirectories.push(directory)
    const storePath = path.join(directory, "stale.json")
    const ciphertext = "sensitive-ciphertext"
    const item: EncryptedHistoryItem = {
      encryptedContent: ciphertext,
      hash: hashEncryptedContent(ciphertext),
      index: 0,
      type: "reasoning",
    }

    const store = new StaleEncryptedContentStore(storePath)
    store.record([item])

    const serialized = fs.readFileSync(storePath, "utf8")
    expect(serialized).not.toContain(ciphertext)
    expect(serialized).toContain(item.hash)

    const reloaded = new StaleEncryptedContentStore(storePath)
    expect(reloaded.has(item.hash)).toBe(true)
    expect(reloaded.size).toBe(1)
  })
})

const createRecoveryPayload = (
  reasoningCiphertext: string,
  compactionCiphertext: string,
): ResponsesPayload => ({
  input: [
    { content: "continue", role: "user" },
    {
      encrypted_content: reasoningCiphertext,
      id: "reasoning-1",
      summary: [],
      type: "reasoning",
    },
    {
      encrypted_content: compactionCiphertext,
      id: "compaction-1",
      type: "compaction",
    },
  ],
  model: "gpt-test",
})
