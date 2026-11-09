// SPDX-License-Identifier: MIT

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SignatureError,
  MAX_SIGNATURE_BYTES,
  isValidSignatureName,
  listSignatures,
  loadSignature,
  insertSignatureHtml,
  deriveSignatureText,
  joinTextBody,
  applySignature,
} from "../src/signatures.mjs"

const CARD = `<div style="font-family:Arial">
<style>.x{color:red}</style>
<p><strong>Ana Pérez</strong></p>
<p>Directora &amp; socia<br>AyDú Studio</p>
<p><a href="https://ay-du.com">ay-du.com</a></p>
</div>`

const CARD_TEXT = ["Ana Pérez", "Directora & socia", "AyDú Studio", "ay-du.com"].join("\n")

/** Build a throwaway signature directory and return {dir, dispose}. */
async function signatureDir(files) {
  const dir = await mkdtemp(join(tmpdir(), "aydu-signatures-"))
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, "utf8")
  }
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) }
}

test("accepts names that are a plain file stem", () => {
  for (const name of ["work", "Work", "work.2024", "a-b_c", "0"]) {
    assert.equal(isValidSignatureName(name), true, name)
  }
})

test("rejects names that could escape or hide", () => {
  for (const name of ["", ".hidden", "_work", "a/b", "a\\b", "..", "a b", "café"]) {
    assert.equal(isValidSignatureName(name), false, name)
  }
})

test("lists every signature with its size and text-version flag", async () => {
  const { dir, dispose } = await signatureDir({
    "work.html": CARD,
    "work.txt": "Ana Pérez\nAyDú Studio",
    "personal.html": "<p>Personal</p>",
    // Not signatures: wrong extension, invalid stem, or a dotfile.
    "notes.md": "ignore me",
    ".hidden.html": "<p>hidden</p>",
    "_bad.html": "<p>bad</p>",
  })
  try {
    const listed = await listSignatures(dir)
    assert.deepEqual(
      listed.map((entry) => ({ ...entry })),
      [
        { name: "personal", bytes: Buffer.byteLength("<p>Personal</p>"), hasTextVersion: false },
        { name: "work", bytes: Buffer.byteLength(CARD), hasTextVersion: true },
      ],
    )
  } finally {
    await dispose()
  }
})

test("never returns the signature body from listSignatures", async () => {
  const { dir, dispose } = await signatureDir({ "work.html": CARD })
  try {
    const listed = await listSignatures(dir)
    assert.equal(listed.length, 1)
    assert.equal(Object.prototype.hasOwnProperty.call(listed[0], "html"), false)
  } finally {
    await dispose()
  }
})

test("an empty directory lists no signatures", async () => {
  const { dir, dispose } = await signatureDir({})
  try {
    assert.deepEqual(await listSignatures(dir), [])
  } finally {
    await dispose()
  }
})

test("rejects a name that escapes the directory", async () => {
  const { dir, dispose } = await signatureDir({ "work.html": CARD })
  const outside = join(dir, "..", "escaped-signature.html")
  await writeFile(outside, "<p>escaped</p>", "utf8")
  try {
    for (const name of ["../../etc/passwd", "../escaped-signature", ".."]) {
      await assert.rejects(() => loadSignature(dir, name), SignatureError, name)
    }
  } finally {
    await rm(outside, { force: true })
    await dispose()
  }
})

test("rejects a symlink that points outside the directory", async () => {
  const { dir, dispose } = await signatureDir({})
  const outside = await mkdtemp(join(tmpdir(), "aydu-outside-"))
  const target = join(outside, "real.html")
  await writeFile(target, "<p>outside</p>", "utf8")
  await symlink(target, join(dir, "link.html"))
  try {
    await assert.rejects(() => loadSignature(dir, "link"), SignatureError)
  } finally {
    await rm(outside, { recursive: true, force: true })
    await dispose()
  }
})

test("names every available signature when the request is unknown", async () => {
  const { dir, dispose } = await signatureDir({ "work.html": CARD, "personal.html": "<p>P</p>" })
  try {
    await assert.rejects(
      () => loadSignature(dir, "nope"),
      { name: "SignatureError", message: "Unknown signature: nope. Available: personal, work" },
    )
  } finally {
    await dispose()
  }
})

test("reports an empty directory in the unknown-signature message", async () => {
  const { dir, dispose } = await signatureDir({})
  try {
    await assert.rejects(() => loadSignature(dir, "work"), {
      message: "Unknown signature: work. Available: (none)",
    })
  } finally {
    await dispose()
  }
})

test("rejects a signature larger than the cap", async () => {
  const big = `<p>${"x".repeat(MAX_SIGNATURE_BYTES)}</p>`
  const { dir, dispose } = await signatureDir({ "big.html": big })
  try {
    await assert.rejects(() => loadSignature(dir, "big"), {
      message: "Signature too large: big",
    })
  } finally {
    await dispose()
  }
})

test("loads html and the text companion", async () => {
  const { dir, dispose } = await signatureDir({
    "work.html": CARD,
    "work.txt": "Ana Pérez\nAyDú Studio",
  })
  try {
    assert.deepEqual(await loadSignature(dir, "work"), {
      name: "work",
      html: CARD,
      text: "Ana Pérez\nAyDú Studio",
    })
  } finally {
    await dispose()
  }
})

test("derives the text version when there is no companion", async () => {
  const { dir, dispose } = await signatureDir({ "work.html": CARD })
  try {
    assert.equal((await loadSignature(dir, "work")).text, CARD_TEXT)
  } finally {
    await dispose()
  }
})

test("derives text by dropping markup, scripts and styles", () => {
  assert.equal(deriveSignatureText(CARD), CARD_TEXT)
  assert.equal(
    deriveSignatureText("<script>alert('x')</script><p>Hola&nbsp;mundo</p>"),
    "Hola mundo",
  )
})

test("inserts the signature before the last body close tag", () => {
  assert.equal(
    insertSignatureHtml("<html><body><p>Hola</p></body></html>", "<p>Firma</p>"),
    "<html><body><p>Hola</p>\n<p>Firma</p></body></html>",
  )
})

test("matches a body close tag in any case", () => {
  assert.equal(
    insertSignatureHtml("<P>Hola</P></BODY>", "<p>Firma</p>"),
    "<P>Hola</P>\n<p>Firma</p></BODY>",
  )
})

test("appends the signature after a blank line when there is no body tag", () => {
  assert.equal(insertSignatureHtml("<p>Hola</p>", "<p>Firma</p>"), "<p>Hola</p>\n\n<p>Firma</p>")
})

test("joins the text body and signature behind an RFC 3676 delimiter", () => {
  assert.equal(joinTextBody("Hola.", CARD_TEXT), `Hola.\n\n-- \n${CARD_TEXT}`)
})

test("applySignature returns the same html when no signature is requested", async () => {
  const { dir, dispose } = await signatureDir({ "work.html": CARD })
  try {
    assert.deepEqual(
      await applySignature({ dir, name: undefined, html: "<p>Hola</p>", text: "Hola" }),
      { html: "<p>Hola</p>", text: "Hola", signature: null },
    )
  } finally {
    await dispose()
  }
})

test("applySignature merges both parts of the chosen signature", async () => {
  const { dir, dispose } = await signatureDir({ "work.html": CARD })
  try {
    const result = await applySignature({
      dir,
      name: "work",
      html: "<html><body><p>Hola</p></body></html>",
      text: "Hola.",
    })
    assert.equal(result.signature, "work")
    assert.equal(result.html, `<html><body><p>Hola</p>\n${CARD}</body></html>`)
    assert.equal(result.text, `Hola.\n\n-- \n${CARD_TEXT}`)
  } finally {
    await dispose()
  }
})

test("applySignature is a no-op when nothing asks for a signature", async () => {
  assert.deepEqual(
    await applySignature({ dir: undefined, html: "<p>Hola</p>", text: "Hola" }),
    { html: "<p>Hola</p>", text: "Hola", signature: null },
  )
})

test("applySignature refuses a name while signatures are not configured", async () => {
  await assert.rejects(
    () => applySignature({ dir: undefined, name: "work", html: "<p>Hola</p>", text: "Hola" }),
    { message: "Signature support is not configured: set AYDU_MAIL_SIGNATURES_DIR" },
  )
})

test("loadSignature refuses a directory that does not exist", async () => {
  const dir = join(tmpdir(), "aydu-signatures-missing-does-not-exist")
  await mkdir(dir, { recursive: true })
  await rm(dir, { recursive: true, force: true })
  await assert.rejects(() => loadSignature(dir, "work"), SignatureError)
})
