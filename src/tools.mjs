// SPDX-License-Identifier: MIT

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { buildDraftMime, parseRecipients, DraftInputError } from "./mime.mjs"
import { applySignature, listSignatures, SignatureError } from "./signatures.mjs"
import {
  MailError,
  buildSearchQuery,
  findBodyPart,
  formatAddresses,
  normalizeMailbox,
  selectPage,
  shapeMessage,
  truncateBody,
} from "./read.mjs"
import { sendEnabled, redact } from "./config.mjs"

/**
 * aydu-mail MCP toolset.
 *
 * Two write paths, deliberately asymmetric:
 *
 *  - save_draft writes to the Drafts folder and is always available.
 *  - send_email is registered only when AYDU_MAIL_ALLOW_SEND is explicitly
 *    truthy. Without it the tool does not exist in the tool list at all, so a
 *    client cannot call it by mistake and an agent never sees it.
 *
 * Everything external arrives through the `createServer` arguments: the
 * configuration object, an IMAP client factory, and an SMTP transport factory.
 * No factory here touches process.env or constructs a real client, so the whole
 * surface can be exercised in-process with fakes.
 */
export function createServer({ config, createImapClient, createTransport }) {
  // Signatures exist only when a directory was configured; without it the field is
  // absent from every schema and no signature code path can be reached.
  const SIGNATURES = config.signatures.dir !== undefined

  function bodySchema(withSignature) {
    const schema = {
      to: z.string().describe("Recipient address list, comma separated"),
      subject: z.string().describe("Subject line"),
      html: z.string().describe("HTML body"),
      text: z.string().describe("Plain-text alternative body"),
      cc: z.string().optional().describe("CC address list, comma separated"),
    }
    if (withSignature) {
      schema.signature = z
        .string()
        .optional()
        .describe("Signature name from list_signatures; when omitted the configured default is used")
    }
    return schema
  }

  const BODY_SCHEMA = bodySchema(SIGNATURES)

  /** Merge the chosen (or default) signature into both parts before MIME building. */
  async function signBody({ html, text, signature }) {
    if (!SIGNATURES) return { html, text }
    return applySignature({
      dir: config.signatures.dir,
      name: signature ?? config.signatures.defaultName,
      html,
      text,
    })
  }

  /**
   * Result payload for a send or save: the signature name appears only when a
   * signature was actually applied, keeping the unconfigured output identical to
   * the shape this server had before signature support.
   */
  function withOptionalSignature(payload, signature) {
    if (!signature) return payload
    return { ...payload, signature }
  }

  /** Locate the Drafts mailbox via the SPECIAL-USE \Drafts flag, with a name fallback. */
  async function resolveDraftsPath(client) {
    const mailboxes = await client.list()
    const byFlag = mailboxes.find((box) => (box.specialUse || "").toLowerCase() === "\\drafts")
    if (byFlag) return byFlag.path

    const byName = mailboxes.find((box) => /(^|[./])drafts$/i.test(box.path))
    if (byName) return byName.path

    throw new Error("No Drafts mailbox found on this account")
  }

  //
  // Read-only path.
  //
  // Every read opens the mailbox with EXAMINE, so a server that ignores PEEK still
  // cannot mark a message as read. This block adds no capability that changes
  // stored mail: it opens, fetches, and closes.
  //

  /** Connect, run one read, and always close the connection. */
  async function withConnection(run) {
    let client
    try {
      client = createImapClient()
      await client.connect()
      return await run(client)
    } finally {
      if (client) {
        try {
          await client.logout()
        } catch {
          // The read outcome is already decided; a failed logout is not actionable.
        }
      }
    }
  }

  /** Resolve a caller mailbox name to a real path, refusing an unknown one by name. */
  async function openMailbox(client, requested) {
    const path = normalizeMailbox(requested)
    const mailboxes = await client.list()
    const target =
      mailboxes.find((box) => box.path === path) ??
      mailboxes.find((box) => box.path.toLowerCase() === path.toLowerCase())
    if (target === undefined) throw new MailError(`Mailbox not found: ${path}`)
    const mailbox = await client.mailboxOpen(target.path, { readOnly: true })
    return { path: target.path, mailbox }
  }

  const METADATA_QUERY = { envelope: true, flags: true, size: true, bodyStructure: true }

  function jsonResult(value) {
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }
  }

  function requireUid(value) {
    const uid = Number(value)
    if (!Number.isInteger(uid) || uid <= 0) throw new MailError(`Invalid uid: ${value}`)
    return uid
  }

  /** Fetch metadata for a page of UIDs and keep the caller's newest-first order. */
  async function fetchPage(client, page) {
    if (page.length === 0) return []
    const messages = await client.fetchAll(page, METADATA_QUERY, { uid: true })
    const byUid = new Map(messages.map((message) => [message.uid, message]))
    return page.filter((uid) => byUid.has(uid)).map((uid) => shapeMessage(byUid.get(uid)))
  }

  async function readStream(stream) {
    const chunks = []
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return Buffer.concat(chunks).toString("utf8")
  }

  /** Case-insensitive flag test: servers are inconsistent about flag case. */
  function hasBoxFlag(box, name) {
    if (!(box.flags instanceof Set)) return false
    for (const flag of box.flags) {
      if (String(flag).toLowerCase() === name) return true
    }
    return false
  }

  const READ_FORMATS = ["headers", "text", "html"]

  function failure(prefix, error) {
    let kind = prefix
    if (error instanceof DraftInputError) kind = "Invalid input"
    else if (error instanceof MailError) kind = "Mail error"
    else if (error instanceof SignatureError) kind = "Signature error"
    return { isError: true, content: [{ type: "text", text: `${kind}: ${redact(error?.message ?? error, config)}` }] }
  }

  const server = new McpServer({ name: "aydu-mail", version: "1.2.0" })

  server.tool(
    "save_draft",
    "Save an email as a draft in the account's Drafts folder. It does not send: a human reviews and sends it. " +
      "Provide both an HTML body and a plain-text alternative.",
    BODY_SCHEMA,
    async ({ to, subject, html, text, cc, signature }) => {
      let client
      try {
        const signed = await signBody({ html, text, signature })
        const mime = await buildDraftMime({
          from: config.user,
          to,
          cc,
          subject,
          html: signed.html,
          text: signed.text,
        })

        client = createImapClient()
        await client.connect()
        const draftsPath = await resolveDraftsPath(client)
        const result = await client.append(draftsPath, mime, ["\\Draft"])

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                withOptionalSignature(
                  {
                    saved: true,
                    mailbox: draftsPath,
                    uid: result?.uid ?? null,
                    to,
                    subject,
                  },
                  signed.signature,
                ),
                null,
                2,
              ),
            },
          ],
        }
      } catch (error) {
        return failure("Draft not saved", error)
      } finally {
        if (client) {
          try {
            await client.logout()
          } catch {
            // The draft outcome is already decided; a failed logout is not actionable.
          }
        }
      }
    },
  )

  server.tool(
    "check_connection",
    "Verify IMAP connectivity and report which mailbox would receive drafts. Sends nothing.",
    {},
    async () => {
      let client
      try {
        client = createImapClient()
        await client.connect()
        const draftsPath = await resolveDraftsPath(client)
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { connected: true, ...config.describe(), draftsMailbox: draftsPath },
                null,
                2,
              ),
            },
          ],
        }
      } catch (error) {
        return failure("Connection failed", error)
      } finally {
        if (client) {
          try {
            await client.logout()
          } catch {
            // Nothing to recover here; the reported state is already accurate.
          }
        }
      }
    },
  )

  server.tool(
    "list_mailboxes",
    "List this account's mailboxes with their message counts. Reading only: nothing is marked as read.",
    {},
    async () => {
      try {
        return jsonResult(
          await withConnection(async (client) => {
            const boxes = await client.list({ statusQuery: { messages: true, unseen: true } })
            return {
              mailboxes: boxes
                .filter((box) => !hasBoxFlag(box, "\\noselect") && !hasBoxFlag(box, "\\nonexistent"))
                .map((box) => ({
                  name: box.name ?? box.path,
                  path: box.path,
                  specialUse: box.specialUse ?? null,
                  exists: box.status?.messages ?? null,
                  unseen: box.status?.unseen ?? null,
                })),
            }
          }),
        )
      } catch (error) {
        return failure("Mailboxes not listed", error)
      }
    },
  )

  server.tool(
    "list_messages",
    "List message metadata from a mailbox, newest first. Returns headers only: uid, sender, recipients, " +
      "subject, date, flags, size and whether the message carries attachments. Never returns a body.",
    {
      mailbox: z.string().optional().describe("Mailbox path; defaults to INBOX"),
      limit: z.number().int().optional().describe("Messages per page; defaults to 20, capped at 50"),
      beforeUid: z
        .number()
        .int()
        .optional()
        .describe("Return only messages older than this uid, for paging"),
    },
    async ({ mailbox, limit, beforeUid }) => {
      try {
        return jsonResult(
          await withConnection(async (client) => {
            const opened = await openMailbox(client, mailbox)
            // The complete UID set is needed to page on a stable cursor; only the
            // selected page is then fetched, so the wire cost stays bounded.
            const uids =
              opened.mailbox.exists === 0 ? [] : await client.search({ all: true }, { uid: true })
            const page = selectPage(uids, { limit, beforeUid })
            return {
              mailbox: opened.path,
              total: opened.mailbox.exists,
              messages: await fetchPage(client, page),
            }
          }),
        )
      } catch (error) {
        return failure("Messages not listed", error)
      }
    },
  )

  server.tool(
    "get_message",
    "Read one message. format=headers returns metadata only; format=text or format=html returns the body " +
      "of that kind, cut at the byte ceiling. Reading never marks the message as read.",
    {
      mailbox: z.string().optional().describe("Mailbox path; defaults to INBOX"),
      uid: z.number().int().describe("Message uid inside that mailbox"),
      format: z
        .enum(READ_FORMATS)
        .optional()
        .describe("headers (default), text, or html"),
    },
    async ({ mailbox, uid, format }) => {
      try {
        const messageUid = requireUid(uid)
        const wanted = format ?? "headers"
        return jsonResult(
          await withConnection(async (client) => {
            const opened = await openMailbox(client, mailbox)
            const message = await client.fetchOne(String(messageUid), METADATA_QUERY, { uid: true })
            if (!message) throw new MailError(`Message not found: ${messageUid}`)

            const shaped = shapeMessage(message)
            const envelope = message.envelope ?? {}
            const result = {
              mailbox: opened.path,
              format: wanted,
              ...shaped,
              cc: formatAddresses(envelope.cc),
              replyTo: formatAddresses(envelope.replyTo),
              inReplyTo: envelope.inReplyTo ?? null,
            }
            if (wanted === "headers") return result

            const part = findBodyPart(message.bodyStructure, wanted)
            if (part === undefined) {
              throw new MailError(`Message ${messageUid} has no ${wanted === "html" ? "text/html" : "text/plain"} part`)
            }
            const { content } = await client.download(String(messageUid), part, { uid: true })
            const { body, truncated } = truncateBody(await readStream(content))
            return { ...result, body, truncated }
          }),
        )
      } catch (error) {
        return failure("Message not read", error)
      }
    },
  )

  server.tool(
    "search_messages",
    "Search a mailbox and return the matching messages' metadata, newest first. Accepts from, to, subject, " +
      "text, since, before and unseen; at least one criterion is required.",
    {
      mailbox: z.string().optional().describe("Mailbox path; defaults to INBOX"),
      limit: z.number().int().optional().describe("Messages per page; defaults to 20, capped at 50"),
      from: z.string().optional().describe("Match the From header"),
      to: z.string().optional().describe("Match the To header"),
      subject: z.string().optional().describe("Match the Subject header"),
      text: z.string().optional().describe("Match anywhere in the message"),
      since: z.string().optional().describe("Only messages on or after this day (YYYY-MM-DD)"),
      before: z.string().optional().describe("Only messages before this day (YYYY-MM-DD)"),
      unseen: z.boolean().optional().describe("Restrict to unread messages"),
    },
    async ({ mailbox, limit, ...criteria }) => {
      try {
        const query = buildSearchQuery(criteria)
        return jsonResult(
          await withConnection(async (client) => {
            const opened = await openMailbox(client, mailbox)
            const uids = await client.search(query, { uid: true })
            const page = selectPage(uids, { limit })
            return {
              mailbox: opened.path,
              query,
              matched: uids.length,
              messages: await fetchPage(client, page),
            }
          }),
        )
      } catch (error) {
        return failure("Search failed", error)
      }
    },
  )

  // Signature selection exists only when a signatures directory was configured.
  if (SIGNATURES) {
    server.tool(
      "list_signatures",
      "List the local HTML signatures configured for this account. Returns names only, never the HTML; " +
        "pass one of them as the signature argument of save_draft or send_email.",
      {},
      async () => {
        try {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    directory: config.signatures.dir,
                    default: config.signatures.defaultName ?? null,
                    signatures: await listSignatures(config.signatures.dir),
                  },
                  null,
                  2,
                ),
              },
            ],
          }
        } catch (error) {
          return failure("Signatures unavailable", error)
        }
      },
    )
  }

  // Sending exists for other consumers of this server, never by default.
  if (sendEnabled(config)) {
    server.tool(
      "send_email",
      "Send an email immediately over SMTP. This is irreversible outbound mail; prefer save_draft unless the " +
        "human has explicitly asked for delivery.",
      BODY_SCHEMA,
      async ({ to, subject, html, text, cc, signature }) => {
        let transport
        try {
          // Building the message first applies the same validation as the draft
          // path, so anything rejected there can never be sent from here.
          const signed = await signBody({ html, text, signature })
          const mime = await buildDraftMime({
            from: config.user,
            to,
            cc,
            subject,
            html: signed.html,
            text: signed.text,
          })

          const envelope = { from: config.user, to: parseRecipients("to", to) }
          if (cc !== undefined) envelope.cc = parseRecipients("cc", cc)

          transport = createTransport({
            host: config.smtp.host,
            port: config.smtp.port,
            secure: config.smtp.secure,
            auth: { user: config.user, pass: config.pass },
          })

          // Sending the prepared raw message guarantees the delivered bytes match
          // what the draft path would have stored.
          const info = await transport.sendMail({ envelope, raw: mime })

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  withOptionalSignature(
                    { sent: true, messageId: info.messageId, accepted: info.accepted, to, subject },
                    signed.signature,
                  ),
                  null,
                  2,
                ),
              },
            ],
          }
        } catch (error) {
          return failure("Message not sent", error)
        } finally {
          if (transport) transport.close()
        }
      },
    )
  }

  return server
}
