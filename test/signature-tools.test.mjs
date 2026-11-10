// SPDX-License-Identifier: MIT

/**
 * list_signatures over the real protocol, against a real directory.
 *
 * The module has its own unit tests; this one proves the tool a client actually
 * calls is wired to it, and that the response stays names-and-sizes only.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { callTool } from "./mcp-client.mjs"

const CARD = "<div><p>Ana Pérez</p><p>AyDú Studio</p></div>"

async function withSignatures(files, run) {
  const dir = await mkdtemp(join(tmpdir(), "aydu-signature-tools-"))
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, "utf8")
  }
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("lists the configured signatures without returning their HTML", async () => {
  await withSignatures(
    { "work.html": CARD, "work.txt": "Ana Pérez", "personal.html": "<p>Personal</p>" },
    async (dir) => {
      const result = await callTool({ AYDU_MAIL_SIGNATURES_DIR: dir }, "list_signatures")
      assert.equal(result.isError, false)
      const body = JSON.parse(result.text)
      assert.deepEqual(body.signatures, [
        { name: "personal", bytes: 15, hasTextVersion: false },
        { name: "work", bytes: Buffer.byteLength(CARD), hasTextVersion: true },
      ])
      assert.equal(result.text.includes("AyDú Studio"), false, "the HTML must not travel")
    },
  )
})

test("reports the configured default signature", async () => {
  await withSignatures({ "work.html": CARD }, async (dir) => {
    const result = await callTool(
      { AYDU_MAIL_SIGNATURES_DIR: dir, AYDU_MAIL_DEFAULT_SIGNATURE: "work" },
      "list_signatures",
    )
    assert.equal(JSON.parse(result.text).default, "work")
  })
})

test("a missing signature directory fails loudly", async () => {
  const missing = join(tmpdir(), "aydu-signatures-absent-does-not-exist")
  const result = await callTool({ AYDU_MAIL_SIGNATURES_DIR: missing }, "list_signatures")
  assert.equal(result.isError, true)
  assert.match(result.text, /^Signature error: Signature directory not found: /)
})
