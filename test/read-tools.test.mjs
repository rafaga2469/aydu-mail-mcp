// SPDX-License-Identifier: MIT

/**
 * Functional checks for the read tools over the real protocol.
 *
 * There is no mail server here, and there is not going to be one in CI. These
 * calls therefore exercise the paths that provably cannot reach a server: input
 * validation, missing credentials, and a refused connection. They still run the
 * registered handler, so they prove the wiring and the error surface a client
 * actually receives.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { callTool } from "./mcp-client.mjs"

const CREDENTIALS = {
  AYDU_MAIL_USER: "hola@example.com",
  AYDU_MAIL_PASS: "super-secret-value",
}

// Port 1 on loopback refuses immediately, so the test never waits on a timeout.
const UNREACHABLE = { ...CREDENTIALS, AYDU_MAIL_HOST: "127.0.0.1", AYDU_MAIL_PORT: "1" }

test("search_messages rejects a call with no criterion before connecting", async () => {
  const result = await callTool({}, "search_messages", { mailbox: "INBOX" })
  assert.equal(result.isError, true)
  assert.match(result.text, /search_messages requires at least one criterion/)
})

test("get_message rejects a uid that is not a positive message number", async () => {
  for (const uid of [0, -4]) {
    const result = await callTool({}, "get_message", { uid })
    assert.equal(result.isError, true, String(uid))
    assert.match(result.text, /Invalid uid/)
  }
})

test("get_message rejects a fractional uid at the schema boundary", async () => {
  const result = await callTool({}, "get_message", { uid: 1.5 })
  assert.equal(result.text.includes("Expected integer"), true)
})

test("list_mailboxes names the missing credentials instead of failing obscurely", async () => {
  const result = await callTool({}, "list_mailboxes")
  assert.equal(result.isError, true)
  assert.match(result.text, /Missing credentials: AYDU_MAIL_USER, AYDU_MAIL_PASS/)
})

test("a refused connection is reported without leaking the password", async () => {
  const result = await callTool(UNREACHABLE, "list_mailboxes")
  assert.equal(result.isError, true)
  assert.match(result.text, /^Mailboxes not listed: /)
  assert.equal(result.text.includes(CREDENTIALS.AYDU_MAIL_PASS), false)
})

test("every read tool reports a refused connection under its own prefix", async () => {
  const calls = [
    ["list_messages", { mailbox: "INBOX" }, /^Messages not listed: /],
    ["get_message", { uid: 3 }, /^Message not read: /],
    ["search_messages", { subject: "Cierre" }, /^Search failed: /],
  ]
  for (const [name, args, prefix] of calls) {
    const result = await callTool(UNREACHABLE, name, args)
    assert.equal(result.isError, true, name)
    assert.match(result.text, prefix, name)
    assert.equal(result.text.includes(CREDENTIALS.AYDU_MAIL_PASS), false, name)
  }
})
