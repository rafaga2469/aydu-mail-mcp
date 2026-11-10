// SPDX-License-Identifier: MIT

/**
 * In-process success-path checks for the write and read tools.
 *
 * No child process and no network: the server instance returned by
 * createServer() is connected to an in-memory transport and driven through the
 * SDK client, with a fake IMAP client and a fake SMTP transport injected as
 * factories. Signatures are read from a real temporary directory, because that
 * code path reads files.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
  const calls = { connect: 0, logout: 0, append: [], fetchOne: [], download: [] }
  return {
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
      return { path, exists: 1, ...(overrides.mailbox ?? {}) }
    },
    async append(path, mime, flags) {
      if (overrides.appendError) throw overrides.appendError
      calls.append.push({ path, mime, flags })
      return { uid: 42 }
    },
    async fetchAll(range, query, options) {
      return []
    },
    async fetchOne(sequence, query, options) {
      calls.fetchOne.push({ sequence, query, options })
      return overrides.message ?? null
    },
    async search(query, options) {
      return []
    },
    async download(uid, part, options) {
      calls.download.push({ uid, part, options })
      const buffers = [Buffer.from("Hola, mundo.\n\nCuerpo"), Buffer.from(" de prueba.")]
      async function* content() {
        for (const buffer of buffers) yield buffer
      }
      return { meta: {}, content: content() }
    },
  }
}

function fakeTransport(overrides = {}) {
  const calls = { sendMail: [], closed: 0 }
  return {
    calls,
    async sendMail(mail) {
      calls.sendMail.push(mail)
      return { messageId: "<sent@example.com>", accepted: ["pepe@example.com"] }
    },
    close() {
      calls.closed += 1
    },
  }
}

/**
 * Start one server instance in-process over an in-memory transport.
 *
 * The invocation mechanism is the documented SDK protocol client paired with
 * InMemoryTransport.createLinkedPair(), so calls travel through the real
 * tools/call request handler, schema coercion included, without stdio or
 * sockets.
 */
async function startServer(env, clientFactory, transportFactory) {
  const server = createServer({
    config: readConfig(env),
    createImapClient: clientFactory,
    createTransport: transportFactory,
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "aydu-mail-success-tests", version: "1.0.0" })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return client
}

async function withSignatureDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "aydu-success-signatures-"))
  await writeFile(join(dir, "firma.html"), "<p>Firma de prueba</p>", "utf8")
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const DRAFT = {
  to: "pepe@example.com",
  subject: "Hola",
  html: "<html><body><p>Cuerpo</p></body></html>",
  text: "Hola, mundo.\n\nCuerpo",
}

test("save_draft without signatures: no signature key at all, saved to the drafts mailbox", async () => {
  const fake = fakeImapClient()
  const client = await startServer(CREDENTIALS, () => fake)
  const result = await client.callTool({ name: "save_draft", arguments: DRAFT })
  assert.equal(result.isError, undefined, JSON.stringify(result))
  const payload = JSON.parse(result.content[0].text)

  assert.equal(Object.keys(payload).includes("signature"), false)
  assert.equal(payload.saved, true)
  assert.equal(payload.mailbox, "INBOX.Drafts")
  assert.equal(payload.uid, 42)
  assert.equal(fake.calls.append.length, 1)
  assert.deepEqual(fake.calls.append[0].flags, ["\\Draft"])
})

test("save_draft with a signature: the name travels and the MIME carries the signature", async () => {
  await withSignatureDir(async (dir) => {
    const fake = fakeImapClient()
    const client = await startServer({ ...CREDENTIALS, AYDU_MAIL_SIGNATURES_DIR: dir }, () => fake)
    const result = await client.callTool({
      name: "save_draft",
      arguments: { ...DRAFT, signature: "firma" },
    })
    assert.equal(result.isError, undefined, JSON.stringify(result))
    const payload = JSON.parse(result.content[0].text)

    assert.equal(payload.signature, "firma")
    const { mime } = fake.calls.append[0]
    assert.equal(mime.includes("<p>Firma de prueba</p>"), true, "the HTML part must carry the signature")
    assert.equal(/\n-- \r?\n/.test(mime), true, "the text part must carry the -- delimiter line")

    // the connection on the success path is closed too
    assert.equal(fake.calls.logout, 1)
  })
})

test("check_connection without signatures: no signatures key in the payload", async () => {
  const fake = fakeImapClient()
  const client = await startServer(CREDENTIALS, () => fake)
  const result = await client.callTool({ name: "check_connection", arguments: {} })
  assert.equal(result.isError, undefined, JSON.stringify(result))
  const payload = JSON.parse(result.content[0].text)

  assert.equal(Object.keys(payload).includes("signatures"), false)
  assert.equal(payload.connected, true)
  assert.equal(payload.draftsMailbox, "INBOX.Drafts")
})

test("send_email without a signature: the payload has no signature key", async () => {
  const fake = fakeImapClient()
  const transport = fakeTransport()
  const client = await startServer(
    { ...CREDENTIALS, AYDU_MAIL_ALLOW_SEND: "true" },
    () => fake,
    () => transport,
  )
  const result = await client.callTool({ name: "send_email", arguments: DRAFT })
  assert.equal(result.isError, undefined, JSON.stringify(result))
  const payload = JSON.parse(result.content[0].text)

  assert.equal(Object.keys(payload).includes("signature"), false)
  assert.equal(payload.sent, true)
  assert.equal(transport.calls.sendMail.length, 1)
  assert.deepEqual(transport.calls.sendMail[0].envelope.to, "pepe@example.com")
  assert.equal(typeof transport.calls.sendMail[0].raw, "string")
})

test("get_message format text returns the decoded body from download", async () => {
  const fake = fakeImapClient({
    mailboxes: [{ name: "INBOX", path: "INBOX", specialUse: null }],
    message: {
      uid: 7,
      envelope: { from: [{ address: "pepe@example.com" }], to: [{ address: "hola@example.com" }] },
      flags: new Set(["\\Seen"]),
      size: 128,
      bodyStructure: { type: "text/plain", disposition: undefined },
    },
  })
  const client = await startServer(CREDENTIALS, () => fake)
  const result = await client.callTool({
    name: "get_message",
    arguments: { uid: 7, format: "text" },
  })
  assert.equal(result.isError, undefined, JSON.stringify(result))
  const payload = JSON.parse(result.content[0].text)

  assert.equal(payload.format, "text")
  assert.equal(payload.body, "Hola, mundo.\n\nCuerpo de prueba.")
  assert.equal(payload.truncated, false)
  assert.equal(fake.calls.download[0].uid, "7")
})

test("a failing append is reported as Draft not saved and the connection is still closed", async () => {
  const fake = fakeImapClient({ appendError: new Error("mailbox is read only") })
  const client = await startServer(CREDENTIALS, () => fake)
  const result = await client.callTool({ name: "save_draft", arguments: DRAFT })

  assert.equal(result.isError, true)
  assert.equal(result.content[0].text.startsWith("Draft not saved: "), true)
  assert.equal(fake.calls.logout, 1)
})
