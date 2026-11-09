// SPDX-License-Identifier: MIT

/**
 * Pure shaping for the read-only mail tools.
 *
 * Everything here is a decision about what a caller sees, taken away from the
 * IMAP client so it can be tested without a mail server: pagination, address
 * formatting, attachment detection, body truncation, and search compilation.
 */

/** Messages returned by default when a caller does not ask for a size. */
export const DEFAULT_LIMIT = 20

/** Hard ceiling on messages per call, so one call cannot flood a model context. */
export const MAX_LIMIT = 50

/** A single body larger than this is cut, never sent whole. */
export const MAX_BODY_BYTES = 100000

/** Raised for a read request that cannot be turned into a valid IMAP command. */
export class MailError extends Error {
  constructor(message) {
    super(message)
    this.name = "MailError"
  }
}

export function clampLimit(value) {
  const parsed = Math.trunc(Number(value))
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT
  return Math.min(parsed, MAX_LIMIT)
}

export function normalizeMailbox(value) {
  const trimmed = typeof value === "string" ? value.trim() : ""
  return trimmed.length > 0 ? trimmed : "INBOX"
}

/** Render an envelope address list the way a mail client displays it. */
export function formatAddresses(addresses) {
  if (!Array.isArray(addresses)) return ""
  return addresses
    .filter((entry) => entry && (entry.address || entry.name))
    .map((entry) =>
      entry.name && entry.address ? `${entry.name} <${entry.address}>` : entry.address || entry.name,
    )
    .join(", ")
}

function leafNodes(node, collected = []) {
  if (!node) return collected
  if (Array.isArray(node.childNodes) && node.childNodes.length > 0) {
    for (const child of node.childNodes) leafNodes(child, collected)
    return collected
  }
  collected.push(node)
  return collected
}

function isAttachmentPart(node) {
  return (
    node.disposition === "attachment" ||
    Boolean(node.dispositionParameters?.filename) ||
    Boolean(node.parameters?.name)
  )
}

/** True when any leaf part is an attachment, by disposition or by filename. */
export function hasAttachments(bodyStructure) {
  if (!bodyStructure) return false
  return leafNodes(bodyStructure).some((node) => isAttachmentPart(node))
}

/**
 * The IMAP part name holding the readable body for a format.
 *
 * A part that is itself an attachment is never chosen: its content is a file,
 * not the message text. A single-part message has no part number, and the
 * IMAP name for its content is TEXT.
 */
export function findBodyPart(bodyStructure, format) {
  const wanted = format === "html" ? "text/html" : "text/plain"
  const node = leafNodes(bodyStructure).find(
    (candidate) =>
      !isAttachmentPart(candidate) &&
      candidate.type === wanted &&
      (candidate.disposition === undefined ||
        candidate.disposition === null ||
        candidate.disposition === "inline"),
  )
  if (node === undefined) return undefined
  return node.part ?? "TEXT"
}

function isoDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  if (typeof value === "string") {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  return null
}

function flagList(flags) {
  if (flags instanceof Set) return [...flags].map(String).sort()
  if (Array.isArray(flags)) return [...flags].map(String).sort()
  return []
}

/** Metadata for one message. Never includes body content. */
export function shapeMessage(message) {
  const envelope = message.envelope ?? {}
  return {
    uid: message.uid ?? null,
    from: formatAddresses(envelope.from),
    to: formatAddresses(envelope.to),
    subject: envelope.subject ?? "(no subject)",
    date: isoDate(envelope.date),
    messageId: envelope.messageId ?? null,
    flags: flagList(message.flags),
    size: message.size ?? null,
    hasAttachments: hasAttachments(message.bodyStructure),
  }
}

/** Newest-first page, bounded by a UID cursor so paging stays stable. */
export function selectPage(uids, { limit, beforeUid }) {
  const cursor =
    beforeUid === undefined || beforeUid === null || beforeUid === "" ? Infinity : Number(beforeUid)
  const filtered = uids.filter((uid) => uid < cursor)
  return filtered.slice(-clampLimit(limit)).reverse()
}

function parseSearchDate(field, value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof value === "string") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
    if (match) {
      const [, year, month, day] = match
      const date = new Date(Number(year), Number(month) - 1, Number(day))
      // Reject 2026-02-31 instead of silently rolling into March.
      if (date.getDate() === Number(day) && date.getMonth() === Number(month) - 1) return date
    }
  }
  throw new MailError(`Invalid date for ${field}: ${value}`)
}

const TEXT_CRITERIA = ["from", "to", "subject", "text"]
const DATE_CRITERIA = ["since", "before"]

/** Translate tool criteria into an IMAP search query. */
export function buildSearchQuery(criteria) {
  const query = {}
  for (const key of TEXT_CRITERIA) {
    const value = criteria[key]
    if (typeof value === "string" && value.trim().length > 0) query[key] = value.trim()
  }
  if (criteria.unseen === true) query.seen = false
  for (const key of DATE_CRITERIA) {
    const value = criteria[key]
    if (value !== undefined && value !== null && value !== "") {
      query[key] = parseSearchDate(key, value)
    }
  }

  if (Object.keys(query).length === 0) {
    throw new MailError("search_messages requires at least one criterion")
  }
  return query
}

/** Cut a body to the byte ceiling without leaving half a character behind. */
export function truncateBody(text) {
  const value = typeof text === "string" ? text : ""
  const bytes = Buffer.from(value, "utf8")
  if (bytes.length <= MAX_BODY_BYTES) return { body: value, truncated: false }
  const cut = bytes
    .subarray(0, MAX_BODY_BYTES)
    .toString("utf8")
    .replace(/\uFFFD+$/u, "")
  return { body: cut, truncated: true }
}
