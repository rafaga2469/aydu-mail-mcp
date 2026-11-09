// SPDX-License-Identifier: MIT

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ImapFlow } from "imapflow"
import nodemailer from "nodemailer"
import { z } from "zod"
import { buildDraftMime, parseRecipients, DraftInputError } from "./mime.mjs"
import { applySignature, listSignatures, SignatureError } from "./signatures.mjs"
import { readConfig, requireCredentials, sendEnabled, redact } from "./config.mjs"

/**
 * aydu-mail MCP server.
 *
 * Two write paths, deliberately asymmetric:
 *
 *  - save_draft writes to the Drafts folder and is always available.
 *  - send_email is registered only when AYDU_MAIL_ALLOW_SEND is explicitly
 *    truthy. Without it the tool does not exist in the tool list at all, so a
 *    client cannot call it by mistake and an agent never sees it.
 */

const CONFIG = readConfig()

// Signatures exist only when a directory was configured; without it the field is
// absent from every schema and no signature code path can be reached.
const SIGNATURES = CONFIG.signatures.dir !== undefined

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
  if (!SIGNATURES) return { html, text, signature: null }
  return applySignature({
    dir: CONFIG.signatures.dir,
    name: signature ?? CONFIG.signatures.defaultName,
    html,
    text,
  })
}

function newImapClient() {
  requireCredentials(CONFIG)
  return new ImapFlow({
    host: CONFIG.imap.host,
    port: CONFIG.imap.port,
    secure: CONFIG.imap.secure,
    auth: { user: CONFIG.user, pass: CONFIG.pass },
    logger: false,
  })
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

function failure(prefix, error) {
  let kind = prefix
  if (error instanceof DraftInputError) kind = "Invalid input"
  else if (error instanceof SignatureError) kind = "Signature error"
  return { isError: true, content: [{ type: "text", text: `${kind}: ${redact(error?.message ?? error, CONFIG)}` }] }
}

const server = new McpServer({ name: "aydu-mail", version: "1.1.0" })

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
        from: CONFIG.user,
        to,
        cc,
        subject,
        html: signed.html,
        text: signed.text,
      })

      client = newImapClient()
      await client.connect()
      const draftsPath = await resolveDraftsPath(client)
      const result = await client.append(draftsPath, mime, ["\\Draft"])

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                saved: true,
                mailbox: draftsPath,
                uid: result?.uid ?? null,
                to,
                subject,
                signature: signed.signature,
              },
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
      client = newImapClient()
      await client.connect()
      const draftsPath = await resolveDraftsPath(client)
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { connected: true, ...CONFIG.describe(), draftsMailbox: draftsPath },
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
                  directory: CONFIG.signatures.dir,
                  default: CONFIG.signatures.defaultName ?? null,
                  signatures: await listSignatures(CONFIG.signatures.dir),
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
if (sendEnabled(CONFIG)) {
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
          from: CONFIG.user,
          to,
          cc,
          subject,
          html: signed.html,
          text: signed.text,
        })

        const envelope = { from: CONFIG.user, to: parseRecipients("to", to) }
        if (cc !== undefined) envelope.cc = parseRecipients("cc", cc)

        transport = nodemailer.createTransport({
          host: CONFIG.smtp.host,
          port: CONFIG.smtp.port,
          secure: CONFIG.smtp.secure,
          auth: { user: CONFIG.user, pass: CONFIG.pass },
        })

        // Sending the prepared raw message guarantees the delivered bytes match
        // what the draft path would have stored.
        const info = await transport.sendMail({ envelope, raw: mime })

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { sent: true, messageId: info.messageId, accepted: info.accepted, to, subject, signature: signed.signature },
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

await server.connect(new StdioServerTransport())
