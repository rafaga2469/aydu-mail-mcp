import { createRequire } from "node:module"

// nodemailer ships MailComposer as CommonJS. We borrow only the composer, never
// the SMTP transport: this server has no way to send mail.
const require = createRequire(import.meta.url)
const MailComposer = require("nodemailer/lib/mail-composer")

/** Raised when caller input could corrupt headers or is not a usable address. */
export class DraftInputError extends Error {
  constructor(message) {
    super(message)
    this.name = "DraftInputError"
  }
}

// CRLF and NUL are the characters that let a value escape its own header.
const CONTROL_CHARS = /[\r\n\u0000]/
const SINGLE_ADDRESS = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/

function assertHeaderSafe(field, value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DraftInputError(`${field} must be a non-empty string`)
  }
  if (CONTROL_CHARS.test(value)) {
    throw new DraftInputError(`${field} must not contain line breaks or control characters`)
  }
}

function parseAddressList(field, value) {
  assertHeaderSafe(field, value)
  const addresses = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)

  if (addresses.length === 0) {
    throw new DraftInputError(`${field} must contain at least one address`)
  }
  for (const address of addresses) {
    if (!SINGLE_ADDRESS.test(address)) {
      throw new DraftInputError(`${field} contains an invalid email address: ${address}`)
    }
  }
  return addresses.join(", ")
}

/**
 * Build a complete RFC 5322 message for an IMAP draft.
 *
 * Produces multipart/alternative with a plain-text part and an HTML part, both
 * declared as UTF-8, so accents survive and the HTML template renders instead
 * of showing raw markup.
 */
export async function buildDraftMime({ from, to, cc, subject, html, text }) {
  assertHeaderSafe("from", from)
  if (!SINGLE_ADDRESS.test(from.trim())) {
    throw new DraftInputError("from must be a single valid email address")
  }
  const toList = parseAddressList("to", to)
  const ccList = cc === undefined ? undefined : parseAddressList("cc", cc)
  assertHeaderSafe("subject", subject)

  if (typeof text !== "string" || text.trim().length === 0) {
    throw new DraftInputError("text must be a non-empty string")
  }
  if (typeof html !== "string" || html.trim().length === 0) {
    throw new DraftInputError("html must be a non-empty string")
  }

  const mail = {
    from: from.trim(),
    to: toList,
    subject,
    text,
    html,
    date: new Date(),
  }
  if (ccList) mail.cc = ccList

  const message = await new Promise((resolve, reject) => {
    new MailComposer(mail).compile().build((error, buffer) => {
      if (error) reject(error)
      else resolve(buffer)
    })
  })

  return message.toString("utf8")
}
