import { test } from "node:test"
import assert from "node:assert/strict"
import { buildDraftMime, DraftInputError } from "../src/mime.mjs"

const base = {
  from: "hola@ay-du.com",
  to: "diana@example.com, nate@example.com",
  subject: "Cierre de etapa · Entrega final",
  html: "<p>Hola, ya está <strong>publicada</strong>.</p>",
  text: "Hola, ya está publicada.",
}

test("declares MIME version and multipart/alternative structure", async () => {
  const mime = await buildDraftMime(base)
  assert.match(mime, /^MIME-Version: 1\.0/m)
  assert.match(mime, /^Content-Type: multipart\/alternative;/m)
})

test("html part declares utf-8 and carries the markup", async () => {
  const mime = await buildDraftMime(base)
  assert.match(mime, /Content-Type: text\/html; charset=utf-8/i)
  assert.match(mime, /publicada/)
})

test("plain-text alternative part declares utf-8", async () => {
  const mime = await buildDraftMime(base)
  assert.match(mime, /Content-Type: text\/plain; charset=utf-8/i)
})

test("preserves Spanish accents through encoding", async () => {
  const mime = await buildDraftMime({
    ...base,
    subject: "Próximos pasos para la entrega",
    html: "<p>Señora Díaz, la página está diseñada.</p>",
    text: "Señora Díaz, la página está diseñada.",
  })
  // The subject must round-trip as valid UTF-8 once decoded, not be mangled.
  const decoded = decodeEncodedWords(mime)
  assert.match(decoded, /Próximos pasos para la entrega/)
})

test("from and to headers are present", async () => {
  const mime = await buildDraftMime(base)
  assert.match(mime, /^From: hola@ay-du\.com/m)
  assert.match(mime, /^To: .*diana@example\.com/m)
})

test("rejects CRLF header injection in subject", async () => {
  await assert.rejects(
    () => buildDraftMime({ ...base, subject: "Normal\r\nBcc: attacker@evil.com" }),
    DraftInputError,
  )
})

test("rejects CRLF header injection in recipient", async () => {
  await assert.rejects(
    () => buildDraftMime({ ...base, to: "a@b.com\r\nBcc: attacker@evil.com" }),
    DraftInputError,
  )
})

test("rejects a recipient that is not an email address", async () => {
  await assert.rejects(() => buildDraftMime({ ...base, to: "not-an-email" }), DraftInputError)
})

// Minimal RFC 2047 decoder: enough to prove accents survive encoding.
function decodeEncodedWords(mime) {
  return mime.replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (_m, enc, payload) => {
    if (enc.toLowerCase() === "b") return Buffer.from(payload, "base64").toString("utf8")
    return Buffer.from(
      payload.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_x, hex) =>
        String.fromCharCode(parseInt(hex, 16)),
      ),
      "binary",
    ).toString("utf8")
  })
}
