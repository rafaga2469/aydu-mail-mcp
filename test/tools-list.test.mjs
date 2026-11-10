// SPDX-License-Identifier: MIT

/**
 * Capability-boundary tests through the public MCP interface.
 *
 * The server's core promise is that a disabled capability is absent from
 * tools/list, not merely refused at call time. Asserting on the real protocol
 * response is the only way to test that promise: importing the module would
 * connect a transport and prove nothing about what a client actually sees.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { listTools } from "./mcp-client.mjs"

const names = (tools) => tools.map((tool) => tool.name).sort()

const inputProps = (tools, name) => {
  const tool = tools.find((candidate) => candidate.name === name)
  assert.ok(tool, `${name} must be registered`)
  return Object.keys(tool.inputSchema?.properties ?? {}).sort()
}

// Registered in every environment: reading is not a destructive capability.
const READ_TOOLS = ["get_message", "list_mailboxes", "list_messages", "search_messages"]

test("ships drafting, reading and connection checks without exposing sending", async () => {
  const tools = await listTools({})
  assert.deepEqual(names(tools), [...READ_TOOLS, "check_connection", "save_draft"].sort())
})

test("read tools never depend on an opt-in variable", async () => {
  const tools = await listTools({ AYDU_MAIL_ALLOW_SEND: "false", AYDU_MAIL_SIGNATURES_DIR: "" })
  for (const tool of READ_TOOLS) {
    assert.ok(names(tools).includes(tool), `${tool} must always be registered`)
  }
})

test("send_email appears only when sending is enabled", async () => {
  const tools = await listTools({ AYDU_MAIL_ALLOW_SEND: "true" })
  assert.deepEqual(
    names(tools),
    [...READ_TOOLS, "check_connection", "save_draft", "send_email"].sort(),
  )
})

test("signature selection is absent until a signature directory is configured", async () => {
  const tools = await listTools({})
  assert.deepEqual(inputProps(tools, "save_draft"), ["cc", "html", "subject", "text", "to"])
})

test("configuring signatures exposes the tool and the schema field", async () => {
  const tools = await listTools({ AYDU_MAIL_SIGNATURES_DIR: "/tmp/aydu-signatures" })
  assert.deepEqual(
    names(tools),
    [...READ_TOOLS, "check_connection", "list_signatures", "save_draft"].sort(),
  )
  assert.deepEqual(inputProps(tools, "save_draft"), [
    "cc",
    "html",
    "signature",
    "subject",
    "text",
    "to",
  ])
})

test("sending and signatures can be enabled at the same time", async () => {
  const tools = await listTools({
    AYDU_MAIL_ALLOW_SEND: "1",
    AYDU_MAIL_SIGNATURES_DIR: "/tmp/aydu-signatures",
  })
  assert.deepEqual(
    names(tools),
    [...READ_TOOLS, "check_connection", "list_signatures", "save_draft", "send_email"].sort(),
  )
  assert.deepEqual(inputProps(tools, "send_email"), [
    "cc",
    "html",
    "signature",
    "subject",
    "text",
    "to",
  ])
})

test("read tools expose no argument that could write", async () => {
  const tools = await listTools({})
  assert.deepEqual(inputProps(tools, "list_mailboxes"), [])
  assert.deepEqual(inputProps(tools, "list_messages"), ["beforeUid", "limit", "mailbox"])
  assert.deepEqual(inputProps(tools, "get_message"), ["format", "mailbox", "uid"])
  assert.deepEqual(inputProps(tools, "search_messages"), [
    "before",
    "from",
    "limit",
    "mailbox",
    "since",
    "subject",
    "text",
    "to",
    "unseen",
  ])
})
