// SPDX-License-Identifier: MIT

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  MailError,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_BODY_BYTES,
  clampLimit,
  normalizeMailbox,
  formatAddresses,
  hasAttachments,
  findBodyPart,
  shapeMessage,
  selectPage,
  buildSearchQuery,
  truncateBody,
} from "../src/read.mjs"

const ALTERNATIVE = {
  type: "multipart/alternative",
  childNodes: [
    { part: "1", type: "text/plain", encoding: "quoted-printable", size: 120 },
    { part: "2", type: "text/html", encoding: "quoted-printable", size: 400 },
  ],
}

const WITH_ATTACHMENT = {
  type: "multipart/mixed",
  childNodes: [
    {
      type: "multipart/alternative",
      childNodes: [
        { part: "1.1", type: "text/plain", size: 10 },
        { part: "1.2", type: "text/html", size: 30 },
      ],
    },
    {
      part: "2",
      type: "application/pdf",
      disposition: "attachment",
      dispositionParameters: { filename: "contrato.pdf" },
      size: 900,
    },
  ],
}

const ENVELOPE = {
  date: new Date("2026-11-08T15:04:05.000Z"),
  subject: "Cierre de etapa",
  messageId: "<abc@example.com>",
  from: [{ name: "Diana Reyes", address: "diana@example.com" }],
  to: [{ name: "", address: "hola@ay-du.com" }, { name: "Nate", address: "nate@example.com" }],
}

test("limit defaults and never exceeds the cap", () => {
  assert.equal(DEFAULT_LIMIT, 20)
  assert.equal(MAX_LIMIT, 50)
  assert.equal(clampLimit(undefined), DEFAULT_LIMIT)
  assert.equal(clampLimit(5), 5)
  assert.equal(clampLimit(0), DEFAULT_LIMIT)
  assert.equal(clampLimit(-3), DEFAULT_LIMIT)
  assert.equal(clampLimit(500), MAX_LIMIT)
  assert.equal(clampLimit("12"), 12)
  assert.equal(clampLimit("nonsense"), DEFAULT_LIMIT)
  assert.equal(clampLimit(7.9), 7)
})

test("mailbox defaults to INBOX and trims a given name", () => {
  assert.equal(normalizeMailbox(undefined), "INBOX")
  assert.equal(normalizeMailbox("   "), "INBOX")
  assert.equal(normalizeMailbox(" Proyectos/AyDú "), "Proyectos/AyDú")
})

test("formats addresses the way a mail client does", () => {
  assert.equal(
    formatAddresses([{ name: "Diana Reyes", address: "diana@example.com" }]),
    "Diana Reyes <diana@example.com>",
  )
  assert.equal(formatAddresses([{ name: "", address: "hola@ay-du.com" }]), "hola@ay-du.com")
  assert.equal(
    formatAddresses([
      { name: "Nate", address: "nate@example.com" },
      { name: "", address: "hola@ay-du.com" },
    ]),
    "Nate <nate@example.com>, hola@ay-du.com",
  )
  assert.equal(formatAddresses(undefined), "")
  assert.equal(formatAddresses([]), "")
})

test("detects attachments through the disposition and the filename", () => {
  assert.equal(hasAttachments(undefined), false)
  assert.equal(hasAttachments(ALTERNATIVE), false)
  assert.equal(hasAttachments(WITH_ATTACHMENT), true)
  assert.equal(
    hasAttachments({
      type: "multipart/mixed",
      childNodes: [{ part: "1", type: "image/png", parameters: { name: "logo.png" } }],
    }),
    true,
    "a filename in the Content-Type parameters is an attachment",
  )
  assert.equal(
    hasAttachments({
      type: "multipart/related",
      childNodes: [{ part: "1", type: "text/html" }],
    }),
    false,
  )
})

test("finds the text part of a simple alternative", () => {
  assert.equal(findBodyPart(ALTERNATIVE, "text"), "1")
  assert.equal(findBodyPart(ALTERNATIVE, "html"), "2")
})

test("finds a nested text part and skips attachments", () => {
  assert.equal(findBodyPart(WITH_ATTACHMENT, "text"), "1.1")
  assert.equal(findBodyPart(WITH_ATTACHMENT, "html"), "1.2")
})

test("ignores a text part that is itself an attachment", () => {
  assert.equal(
    findBodyPart(
      {
        type: "multipart/mixed",
        childNodes: [
          { part: "1", type: "text/plain", disposition: "attachment" },
          { part: "2", type: "text/plain" },
        ],
      },
      "text",
    ),
    "2",
  )
  assert.equal(findBodyPart({ type: "text/plain", part: "1" }, "html"), undefined)
})

test("never picks a text part that carries a Content-Type filename", () => {
  const structure = {
    type: "multipart/mixed",
    childNodes: [
      { part: "1", type: "text/plain", parameters: { name: "notas.txt" } },
      { part: "2", type: "text/plain" },
    ],
  }
  assert.equal(findBodyPart(structure, "text"), "2")
  assert.equal(hasAttachments(structure), true)
})

test("never picks a lone text part carrying a disposition filename", () => {
  const structure = {
    part: "1",
    type: "text/plain",
    dispositionParameters: { filename: "notas.txt" },
  }
  assert.equal(findBodyPart(structure, "text"), undefined)
  assert.equal(hasAttachments(structure), true)
})

test("uses the TEXT part name for a single-part message", () => {
  assert.equal(findBodyPart({ type: "text/plain" }, "text"), "TEXT")
})

test("shapes a message without any body content", () => {
  const shaped = shapeMessage({
    uid: 4212,
    envelope: ENVELOPE,
    flags: new Set(["\\Seen", "\\Flagged"]),
    size: 5230,
    bodyStructure: WITH_ATTACHMENT,
  })
  assert.deepEqual(shaped, {
    uid: 4212,
    from: "Diana Reyes <diana@example.com>",
    to: "hola@ay-du.com, Nate <nate@example.com>",
    subject: "Cierre de etapa",
    date: "2026-11-08T15:04:05.000Z",
    messageId: "<abc@example.com>",
    flags: ["\\Flagged", "\\Seen"],
    size: 5230,
    hasAttachments: true,
  })
})

test("shapes a message that is missing envelope fields", () => {
  const shaped = shapeMessage({ uid: 7, flags: new Set(), size: 0 })
  assert.deepEqual(shaped, {
    uid: 7,
    from: "",
    to: "",
    subject: "(no subject)",
    date: null,
    messageId: null,
    flags: [],
    size: 0,
    hasAttachments: false,
  })
})

test("shapes an unparseable date as null instead of an invalid string", () => {
  const shaped = shapeMessage({ uid: 1, envelope: { date: "not a date" }, flags: new Set() })
  assert.equal(shaped.date, null)
})

test("pages newest first and honours the uid cursor", () => {
  const uids = [1, 2, 3, 4, 5, 6]
  assert.deepEqual(selectPage(uids, { limit: 3 }), [6, 5, 4])
  assert.deepEqual(selectPage(uids, { limit: 3, beforeUid: 5 }), [4, 3, 2])
  assert.deepEqual(selectPage(uids, { limit: 3, beforeUid: 1 }), [])
  assert.deepEqual(selectPage([], { limit: 3 }), [])
})

test("builds a search query from the given criteria", () => {
  assert.deepEqual(buildSearchQuery({ from: "diana@example.com", subject: "Cierre" }), {
    from: "diana@example.com",
    subject: "Cierre",
  })
})

test("maps unseen to the inverse seen flag", () => {
  assert.deepEqual(buildSearchQuery({ unseen: true }), { seen: false })
  // `unseen: false` is not a criterion: it must not invent a `seen: true` filter.
  assert.deepEqual(buildSearchQuery({ unseen: false, from: "diana@example.com" }), {
    from: "diana@example.com",
  })
})

test("turns day strings into local midnight dates", () => {
  const { since, before } = buildSearchQuery({ since: "2026-11-01", before: "2026-11-09" })
  assert.equal(since.getFullYear(), 2026)
  assert.equal(since.getMonth(), 10)
  assert.equal(since.getDate(), 1)
  assert.equal(since.getHours(), 0)
  assert.equal(before.getDate(), 9)
  assert.equal(before.getHours(), 0)
})

test("rejects an unparseable date instead of sending a wrong one", () => {
  assert.throws(() => buildSearchQuery({ since: "ayer" }), {
    name: "MailError",
    message: "Invalid date for since: ayer",
  })
})

test("rejects a search with no criterion", () => {
  assert.throws(() => buildSearchQuery({}), {
    name: "MailError",
    message: "search_messages requires at least one criterion",
  })
  assert.throws(() => buildSearchQuery({ unseen: false }), MailError)
})

test("keeps a short body untouched", () => {
  assert.deepEqual(truncateBody("Hola."), { body: "Hola.", truncated: false })
})

test("cuts a long body on a byte boundary and reports it", () => {
  const long = `a${"á".repeat(MAX_BODY_BYTES)}`
  const { body, truncated } = truncateBody(long)
  assert.equal(truncated, true)
  assert.ok(Buffer.byteLength(body, "utf8") <= MAX_BODY_BYTES)
  assert.ok(!body.includes("\uFFFD"), "a split character must not survive as a replacement char")
  assert.ok(body.startsWith("aá"))
})

test("treats an absent body as empty", () => {
  assert.deepEqual(truncateBody(undefined), { body: "", truncated: false })
})
