// SPDX-License-Identifier: MIT

/**
 * In-process checks for the send_draft tool against the fake client and fake
 * transport mechanisms used by tools-success.test.mjs. Copied here so the
 * existing test file stays untouched.
 *
 * No child process and no network: the server instance returned by
 * createServer() is connected to an in-memory transport and driven through the
 * SDK client, with a fake IMAP client and a fake SMTP transport injected as
 * factories.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createServer } from "../src/tools.mjs"
import { readConfig } from "../src/config.mjs"

const CREDENTIALS = {
  AYDU_MAIL_USER: "hola@example.com",
  AYDU_MAIL_PASS: "super-secret-value",
}

const DRAFTS_MAILBOXES = [
  { name: "INBOX", path: "INBOX", specialUse: null },
  { name: "Drafts", path: "INBOX.Drafts", specialUse: "\\Drafts" },
]

/** The handler surface the tools actually touch, with every call recorded. */
function fakeImapClient(overrides = {}) {
  const calls = { connect: 0, logout: 0, append: [], mailboxOpen: [], fetchOne: [], mutations: [] }
  const client = {
    calls,
    async connect() {
      calls.connect += 1
    },
    async logout() {
      calls.logout += 1
    },
    async list(_options) {
      return overrides.mailboxes ?? DRAFTS_MAILBOXES
    },
    async mailboxOpen(path, options) {
      calls.mailboxOpen.push({ path, options })
      return { path, exists: 1, ...(overrides.mailbox ?? {}) }
    },
    async append(path, mime, flags) {
      if (overrides.appendError) throw overrides.appendError
      calls.append.push({ path, mime, flags })
      return { uid: 42 }
    },
    async fetchOne(sequence, query, options) {
      calls.fetchOne.push({ sequence, query, options })
      return overrides.message ?? null
    },
    async download(uid, part, options) {
      calls.download.push({ uid, part, options })
      return { meta: {}, content: (async function* () {})() }
    },
  }
  // Mutating trap methods: the fake records the attempt and throws, so any
  // write this server performs is caught immediately by the caller.
  for (const name of ["messageDelete", "messageMove", "messageFlagsAdd", "messageFlagsRemove"]) {
    client[name] = async (...args) => {
      calls.mutations.push({ name, args })
      throw new Error(`unexpected mutating call: ${name}`)
    }
  }
  return client
}

function fakeTransport(overrides = {}) {
  const calls = { sendMail: [], closed: 0 }
  return {
    calls,
    async sendMail(mail) {
      if (overrides.sendError) throw overrides.sendError
      calls.sendMail.push(mail)
      return { messageId: "<sent@example.com>", accepted: ["pepe@example.com"] }
    },
    close() {
      calls.closed += 1
    },
  }
}

/**
 * Start one server instance in-process over an in-memory transport. Calls
 * travel through the real tools/call request handler, schema coercion
 * included, without stdio or sockets.
 */
async function startServer(env, clientFactory, transportFactory) {
  const server = createServer({
    config: readConfig(env),
    createImapClient: clientFactory,
    createTransport: transportFactory,
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "aydu-send-draft-tests", version: "1.0.0" })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return client
}

const DRAFT_SOURCE = Buffer.from("From: hola@example.com\r\nTo: pepe@example.com\r\nSubject: Hola\r\n\r\nCuerpo")

test("send_draft is absent from tools/list without the switch", async () => {
  const client = await startServer(CREDENTIALS, () => fakeImapClient(), () => fakeTransport())
  const tools = await client.listTools()
  assert.equal(tools.tools.map((tool) => tool.name).includes("send_draft"), false)
})

test("send_draft is present with AYDU_MAIL_ALLOW_SEND_DRAFT=true", async () => {
  const client = await startServer(
    { ...CREDENTIALS, AYDU_MAIL_ALLOW_SEND_DRAFT: "true" },
    () => fakeImapClient(),
    () => fakeTransport(),
  )
  const tools = await client.listTools()
  assert.equal(tools.tools.map((tool) => tool.name).includes("send_draft"), true)
})

test("the compose switch alone does not register send_draft", async () => {
  const client = await startServer(
    { ...CREDENTIALS, AYDU_MAIL_ALLOW_SEND: "true" },
    () => fakeImapClient(),
    () => fakeTransport(),
  )
  const tools = await client.listTools()
  assert.equal(tools.tools.map((tool) => tool.name).includes("send_draft"), false)
})

test("a successful call sends the exact stored bytes from the Drafts mailbox", async () => {
  const fake = fakeImapClient({ message: { uid: 7, source: DRAFT_SOURCE } })
  const transport = fakeTransport()
  const client = await startServer(
    { ...CREDENTIALS, AYDU_MAIL_ALLOW_SEND_DRAFT: "true" },
    () => fake,
    () => transport,
  )
  const result = await client.callTool({ name: "send_draft", arguments: { uid: 7 } })
  assert.equal(result.isError, undefined, JSON.stringify(result))
  const payload = JSON.parse(result.content[0].text)

  // the bytes handed to SMTP are the exact fetched Buffer, not a re-encoding
  assert.equal(transport.calls.sendMail.length, 1)
  assert.ok(Object.is(transport.calls.sendMail[0].raw, DRAFT_SOURCE))
  assert.deepEqual(transport.calls.sendMail[0], { raw: DRAFT_SOURCE })

  // fetched by uid, source only
  assert.deepEqual(fake.calls.fetchOne[0], { sequence: "7", query: { source: true }, options: { uid: true } })

  // the mailbox is the resolved Drafts path, opened read-only
  assert.equal(payload.mailbox, "INBOX.Drafts")
  assert.deepEqual(fake.calls.mailboxOpen[0], { path: "INBOX.Drafts", options: { readOnly: true } })
})

test("the payload has exactly the five documented keys", async () => {
  const fake = fakeImapClient({ message: { uid: 7, source: DRAFT_SOURCE } })
  const client = await startServer(
    { ...CREDENTIALS, AYDU_MAIL_ALLOW_SEND_DRAFT: "true" },
    () => fake,
    () => fakeTransport(),
  )
  const result = await client.callTool({ name: "send_draft", arguments: { uid: 7 } })
  assert.equal(result.isError, undefined, JSON.stringify(result))
  const payload = JSON.parse(result.content[0].text)

  assert.deepEqual(
    Object.keys(payload).sort(),
    ["accepted", "mailbox", "messageId", "sent", "uid"],
    JSON.stringify(payload),
  )
})

test("an unknown uid fails with Draft not found and never touches SMTP", async () => {
  const fake = fakeImapClient({ message: false })
  const transport = fakeTransport()
  const client = await startServer(
    { ...CREDENTIALS, AYDU_MAIL_ALLOW_SEND_DRAFT: "true" },
    () => fake,
    () => transport,
  )
  const result = await client.callTool({ name: "send_draft", arguments: { uid: 7 } })

  assert.equal(result.isError, true)
  assert.equal(result.content[0].text, "Draft not found: 7")
  assert.equal(transport.calls.sendMail.length, 0)
})

test("a successful send performs no mutating operation on the mailbox", async () => {
  const fake = fakeImapClient({ message: { uid: 7, source: DRAFT_SOURCE } })
  const client = await startServer(
    { ...CREDENTIALS, AYDU_MAIL_ALLOW_SEND_DRAFT: "true" },
    () => fake,
    () => fakeTransport(),
  )
  const result = await client.callTool({ name: "send_draft", arguments: { uid: 7 } })
  assert.equal(result.isError, undefined, JSON.stringify(result))

  assert.equal(fake.calls.append.length, 0)
  assert.equal(fake.calls.mutations.length, 0, JSON.stringify(fake.calls.mutations))
  assert.equal(fake.calls.fetchOne.length, 1)
})

test("a transport failure reports Draft not sent and still closes the transport", async () => {
  const fake = fakeImapClient({ message: { uid: 7, source: DRAFT_SOURCE } })
  const transport = fakeTransport({ sendError: new Error("relay refused") })
  const client = await startServer(
    { ...CREDENTIALS, AYDU_MAIL_ALLOW_SEND_DRAFT: "true" },
    () => fake,
    () => transport,
  )
  const result = await client.callTool({ name: "send_draft", arguments: { uid: 7 } })

  assert.equal(result.isError, true)
  assert.equal(result.content[0].text.startsWith("Draft not sent: "), true)
  assert.equal(transport.calls.closed, 1)
  assert.equal(fake.calls.logout, 1)
})
