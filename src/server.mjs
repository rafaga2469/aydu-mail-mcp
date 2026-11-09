// SPDX-License-Identifier: MIT

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ImapFlow } from "imapflow"
import nodemailer from "nodemailer"
import { z } from "zod"
import { buildDraftMime, parseRecipients, DraftInputError } from "./mime.mjs"
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

const BODY_SCHEMA = {
  to: z.string().describe("Recipient address list, comma separated"),
  subject: z.string().describe("Subject line"),
  html: z.string().describe("HTML body"),
  text: z.string().describe("Plain-text alternative body"),
  cc: z.string().optional().describe("CC address list, comma separated"),
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
  const kind = error instanceof DraftInputError ? "Invalid input" : prefix
  return { isError: true, content: [{ type: "text", text: `${kind}: ${redact(error?.message ?? error, CONFIG)}` }] }
}

const server = new McpServer({ name: "aydu-mail", version: "1.1.0" })

server.tool(
  "save_draft",
  "Save an email as a draft in the account's Drafts folder. It does not send: a human reviews and sends it. " +
    "Provide both an HTML body and a plain-text alternative.",
  BODY_SCHEMA,
  async ({ to, subject, html, text, cc }) => {
    let client
    try {
      const mime = await buildDraftMime({ from: CONFIG.user, to, cc, subject, html, text })

      client = newImapClient()
      await client.connect()
      const draftsPath = await resolveDraftsPath(client)
      const result = await client.append(draftsPath, mime, ["\\Draft"])

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { saved: true, mailbox: draftsPath, uid: result?.uid ?? null, to, subject },
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

// Sending exists for other consumers of this server, never by default.
if (sendEnabled(CONFIG)) {
  server.tool(
    "send_email",
    "Send an email immediately over SMTP. This is irreversible outbound mail; prefer save_draft unless the " +
      "human has explicitly asked for delivery.",
    BODY_SCHEMA,
    async ({ to, subject, html, text, cc }) => {
      let transport
      try {
        // Building the message first applies the same validation as the draft
        // path, so anything rejected there can never be sent from here.
        const mime = await buildDraftMime({ from: CONFIG.user, to, cc, subject, html, text })

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
                { sent: true, messageId: info.messageId, accepted: info.accepted, to, subject },
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
