import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import os from "node:os"
import path from "node:path"

import { start } from "~/start"

async function unusedPort(): Promise<number> {
  const socket = createServer()
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve))
  const address = socket.address()
  if (!address || typeof address === "string") throw new Error("No test port")
  const port = address.port
  await new Promise<void>((resolve, reject) => {
    socket.close((error) => (error ? reject(error) : resolve()))
  })
  return port
}

describe("opt-in headless machine startup", () => {
  test("normal startup remains interactive by default", () => {
    const args: unknown = start.args
    if (!args || typeof args !== "object" || !("headless" in args)) {
      throw new Error("Headless CLI argument is missing")
    }
    const option = args.headless
    if (!option || typeof option !== "object" || !("default" in option)) {
      throw new Error("Headless CLI default is missing")
    }
    expect(option.default).toBe(false)
  })

  for (const configured of [false, true]) {
    test(
      configured ?
        "preserves an existing provider instead of invoking login"
      : "starts fresh node services without inventing provider credentials",
      async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "codey-headless-"))
        const port = await unusedPort()
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          HOME: root,
          CODEX_HOME: path.join(root, ".codex"),
          COPILOT_API_HOME: root,
        }
        for (const key of Object.keys(env)) {
          if (key.startsWith("COPILOT_API_CODEY_")) delete env[key]
        }
        if (configured) {
          await writeFile(
            path.join(root, "config.json"),
            JSON.stringify({
              providers: {
                test: {
                  enabled: true,
                  type: "openai-compatible",
                  baseUrl: "http://127.0.0.1:1",
                  apiKey: "test-only-not-used-for-inference",
                },
              },
            }),
          )
        }
        const child = Bun.spawn(
          [
            process.execPath,
            "run",
            "src/main.ts",
            "start",
            "--headless",
            "--host",
            "127.0.0.1",
            "--port",
            String(port),
          ],
          { env, stdout: "pipe", stderr: "pipe" },
        )
        const output = Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        try {
          let healthy = false
          for (let attempt = 0; attempt < 100; attempt++) {
            try {
              const response = await fetch(`http://127.0.0.1:${port}/`)
              healthy = response.status === 200
              if (healthy) break
            } catch {
              /* Wait for this isolated child, not a production service. */
            }
            await Bun.sleep(100)
          }
          expect(healthy).toBe(true)
          const config = JSON.parse(
            await readFile(path.join(root, "config.json"), "utf8"),
          ) as { providers?: Record<string, { apiKey?: string }> }
          if (configured) {
            expect(config.providers?.test.apiKey).toBe(
              "test-only-not-used-for-inference",
            )
          } else {
            expect(Object.keys(config.providers ?? {})).toHaveLength(0)
          }
        } finally {
          child.kill()
          await child.exited
          const logs = (await output).join("\n")
          expect(logs).not.toContain(
            "No enabled providers found. Setting one up",
          )
          await rm(root, { recursive: true, force: true })
        }
      },
      20000,
    )
  }
})
