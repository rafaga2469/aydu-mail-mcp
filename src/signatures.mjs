// SPDX-License-Identifier: MIT

import { readdir, readFile, realpath } from "node:fs/promises"
import { join, sep } from "node:path"

/**
 * Local HTML signatures.
 *
 * A signature is a file `<name>.html` inside the directory named by
 * AYDU_MAIL_SIGNATURES_DIR, optionally paired with `<name>.txt` for the
 * plain-text alternative. This module only reads those files: the server never
 * writes a signature, so a compromised agent cannot leave one behind.
 */

/** A signature larger than this is refused rather than truncated. */
export const MAX_SIGNATURE_BYTES = 65536

/** RFC 3676 §4.3: the signature delimiter is exactly dash dash space. */
const TEXT_DELIMITER = "-- "

// A name is a plain file stem: no separators, no leading dot, no whitespace.
const VALID_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Raised for anything wrong with a signature: name, location, or size. */
export class SignatureError extends Error {
  constructor(message) {
    super(message)
    this.name = "SignatureError"
  }
}

export function isValidSignatureName(name) {
  return typeof name === "string" && VALID_NAME.test(name)
}

/**
 * Resolve `<dir>/<name><extension>` and refuse it unless it lands inside `dir`.
 * realpath on both sides is what catches a symlink pointing out of the tree.
 */
async function resolveInside(dir, name, extension) {
  if (!isValidSignatureName(name)) {
    throw new SignatureError(`Invalid signature name: ${String(name)}`)
  }

  let dirReal
  try {
    dirReal = await realpath(dir)
  } catch {
    throw new SignatureError(`Signature directory not found: ${dir}`)
  }

  let fileReal
  try {
    fileReal = await realpath(join(dirReal, `${name}${extension}`))
  } catch {
    return undefined
  }

  if (!fileReal.startsWith(dirReal + sep)) {
    throw new SignatureError(`Signature path escapes the signature directory: ${name}`)
  }
  return fileReal
}

async function readCapped(path, name) {
  const bytes = await readFile(path)
  if (bytes.length > MAX_SIGNATURE_BYTES) {
    throw new SignatureError(`Signature too large: ${name}`)
  }
  return bytes.toString("utf8")
}

/** Every usable signature, sorted by name. Bodies are never returned here. */
export async function listSignatures(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    throw new SignatureError(`Signature directory not found: ${dir}`)
  }

  const stems = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
    .map((entry) => entry.name.slice(0, -".html".length))
    .filter(isValidSignatureName)
    .sort()

  const hasTextVersion = new Set(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".txt"))
      .map((entry) => entry.name.slice(0, -".txt".length)),
  )

  return Promise.all(
    stems.map(async (name) => {
      const bytes = await readFile(join(dir, `${name}.html`))
      return { name, bytes: bytes.length, hasTextVersion: hasTextVersion.has(name) }
    }),
  )
}

/** Read one signature, preferring its text companion over a derived rendering. */
export async function loadSignature(dir, name) {
  if (!isValidSignatureName(name)) {
    throw new SignatureError(`Invalid signature name: ${String(name)}`)
  }

  const htmlPath = await resolveInside(dir, name, ".html")
  if (htmlPath === undefined) {
    const available = (await listSignatures(dir)).map((entry) => entry.name)
    throw new SignatureError(
      `Unknown signature: ${name}. Available: ${available.length > 0 ? available.join(", ") : "(none)"}`,
    )
  }

  const html = await readCapped(htmlPath, name)
  const textPath = await resolveInside(dir, name, ".txt")
  const text = textPath === undefined ? deriveSignatureText(html) : await readCapped(textPath, name)

  return { name, html, text }
}

const BLOCK_TAGS = "p|div|li|ul|ol|tr|td|th|table|thead|tbody|h[1-6]|blockquote|section|article|header|footer|hr"
const BLOCK_BOUNDARY = new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, "gi")

const ENTITIES = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
}

function decodeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos|#39);/g, (entity) => ENTITIES[entity])
}

/**
 * Render a signature as plain text.
 *
 * Style and script bodies are dropped entirely: their contents are not prose and
 * would otherwise leak CSS into the text part of the message.
 */
export function deriveSignatureText(html) {
  const stripped = html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\b[^>]*>/gi, "\n")
    .replace(BLOCK_BOUNDARY, "\n")
    .replace(/<[^>]*>/g, "")

  return decodeEntities(stripped)
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
}

/** Place the signature HTML at the end of the visual body. */
export function insertSignatureHtml(html, signatureHtml) {
  const index = html.toLowerCase().lastIndexOf("</body>")
  if (index === -1) return `${html}\n\n${signatureHtml}`
  return `${html.slice(0, index)}\n${signatureHtml}${html.slice(index)}`
}

/** Append the signature to the plain-text alternative behind the delimiter. */
export function joinTextBody(text, signatureText) {
  return `${text}\n\n${TEXT_DELIMITER}\n${signatureText}`
}

/**
 * Merge a chosen signature into both message parts.
 *
 * `dir` is undefined when the capability is not configured. A name in that state
 * is a caller bug and fails loudly; asking for no signature is always a no-op.
 */
export async function applySignature({ dir, name, html, text }) {
  if (name === undefined || name === null) {
    return { html, text, signature: null }
  }
  if (typeof name === "string" && name.trim() === "") {
    throw new SignatureError(
      "Invalid signature name: an empty value is not a signature name; omit the argument to use the default",
    )
  }
  if (dir === undefined || dir === null || dir === "") {
    throw new SignatureError(
      "Signature support is not configured: set AYDU_MAIL_SIGNATURES_DIR",
    )
  }

  const loaded = await loadSignature(dir, name)
  return {
    html: insertSignatureHtml(html, loaded.html),
    text: joinTextBody(text, loaded.text),
    signature: loaded.name,
  }
}
