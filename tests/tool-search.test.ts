import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import {
  createMcpToolSearchSentinel,
  hasDeferredMcpNamespaceTool,
  parseMcpToolSearchSentinel,
  resolveBridgeToolSearchName,
  selectDeferredToolsByNames,
  shouldEnableResponsesToolSearch,
} from "~/lib/tool-search"
import { createMcpToolSearchServer, runMcpServer } from "~/mcp"

describe("tool search helpers", () => {
  test("detects eligible Responses tool search requests", () => {
    expect(
      shouldEnableResponsesToolSearch({
        model: "gpt-5.4",
        tools: [
          { name: "mcp__tool_search__search" },
          { name: "mcp__fetch__fetch" },
        ],
      }),
    ).toBe(true)

    expect(
      shouldEnableResponsesToolSearch({
        model: "gpt-5.4",
        tools: [{ name: "tool_search_search" }, { name: "mcp__fetch__fetch" }],
      }),
    ).toBe(true)

    expect(
      shouldEnableResponsesToolSearch({
        model: "gpt-5",
        tools: [
          { name: "mcp__tool_search__search" },
          { name: "mcp__fetch__fetch" },
        ],
      }),
    ).toBe(false)

    expect(
      shouldEnableResponsesToolSearch({
        model: "gpt-5.4",
        tools: [{ name: "mcp__fetch__fetch" }],
      }),
    ).toBe(false)

    expect(
      shouldEnableResponsesToolSearch({
        model: "gpt-5.4",
        tools: [{ name: "mcp__tool_search__search" }],
      }),
    ).toBe(false)

    expect(
      shouldEnableResponsesToolSearch({
        model: "gpt-5.4",
        tools: [{ name: "mcp__tool_search__search" }, { name: "TaskCreate" }],
      }),
    ).toBe(true)

    expect(
      shouldEnableResponsesToolSearch({
        model: "gpt-5.4",
        tools: [
          { name: "mcp__tool_search__search" },
          { name: "chrome-devtools_click" },
        ],
      }),
    ).toBe(true)

    expect(
      shouldEnableResponsesToolSearch({
        model: "gpt-5.4",
        tools: [{ name: "mcp__tool_search__search" }, { name: "bash" }],
      }),
    ).toBe(false)

    expect(
      shouldEnableResponsesToolSearch({
        model: "gpt-5.4",
        tools: [
          { name: "mcp__tool_search__search" },
          { name: "EnterPlanMode" },
          { name: "ExitPlanMode" },
          { name: "WebFetch" },
        ],
      }),
    ).toBe(false)
  })

  test("round-trips MCP bridge sentinel payloads", () => {
    const sentinel = createMcpToolSearchSentinel(
      "mcp__fetch__fetch, TaskList, TaskList",
    )

    expect(parseMcpToolSearchSentinel(sentinel)).toEqual({
      type: "copilot_api_tool_search",
      names: ["mcp__fetch__fetch", "TaskList"],
    })
  })

  test("prefers the configured bridge tool search alias", () => {
    expect(
      resolveBridgeToolSearchName([
        { name: "tool_search_search" },
        { name: "mcp__fetch__fetch" },
      ]),
    ).toBe("tool_search_search")

    expect(resolveBridgeToolSearchName(undefined)).toBe(
      "mcp__tool_search__search",
    )
  })

  test("selects only named deferred tools", () => {
    const matches = selectDeferredToolsByNames(
      "chrome-devtools_click,TaskList,mcp__fetch__fetch,Read,TodoWrite,Unknown",
      [
        {
          name: "mcp__tool_search__search",
          description: "Bridge",
        },
        {
          name: "chrome-devtools_click",
          description: "Click an element",
        },
        {
          name: "mcp__fetch__fetch",
          description: "Fetch a URL",
        },
        {
          name: "Read",
          description: "Read files",
        },
        {
          name: "TodoWrite",
          description: "Update the todo list",
        },
        {
          name: "TaskList",
          description: "List tasks",
        },
      ],
    )

    expect(matches.map((tool) => tool.name)).toEqual([
      "chrome-devtools_click",
      "TaskList",
      "mcp__fetch__fetch",
    ])
  })

  test("detects translated deferred namespaces", () => {
    expect(
      hasDeferredMcpNamespaceTool([
        {
          type: "namespace",
          name: "mcp__fetch__fetch",
          tools: [
            {
              type: "function",
              name: "mcp__fetch__fetch",
              defer_loading: true,
            },
          ],
        },
      ]),
    ).toBe(true)

    expect(
      hasDeferredMcpNamespaceTool([
        {
          type: "namespace",
          name: "chrome-devtools_click",
          tools: [
            {
              type: "function",
              name: "chrome-devtools_click",
              defer_loading: true,
            },
          ],
        },
      ]),
    ).toBe(true)
  })

  test("exports an mcp CLI command", () => {
    expect(typeof runMcpServer).toBe("function")
  })

  test("registers the search bridge tool as read-only", async () => {
    const server = createMcpToolSearchServer()
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "tool-search-test", version: "0.0.1" })

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ])

    try {
      const { tools } = await client.listTools()
      const search = tools.find((tool) => tool.name === "search")
      expect(search?.annotations?.readOnlyHint).toBe(true)
    } finally {
      await client.close()
      await server.close()
    }
  })
})
