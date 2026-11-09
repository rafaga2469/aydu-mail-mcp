import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ImapFlow } from "imapflow"
import { z } from "zod"
import { buildDraftMime, DraftInputError } from "./mime.mjs"

/**
 * ay-du draft server.
 *
 * Deliberately exposes no send capability: outbound mail is a human decision.
 * This server can only append a message to the account's Drafts folder.
 */

const CONFIG = {
  host: process.env.AYDU_MAIL_HOST || "imap.secureserver.net",
  port: Number(process.env.AYDU_MAIL_PORT || 993),
  secure: (process.env.AYDU_MAIL_SECURE || "true") !== "false",
  user: process.env.AYDU_MAIL_USER,
  pass: process.env.AYDU_MAIL_PASS,
}

function requireConfig() {
  if (!CONFIG.user || !CONFIG.pass) {
    throw new Error(
      "Missing credentials: AYDU_MAIL_USER and AYDU_MAIL_PASS must be set (the wrapper reads them from the system keyring).",
    )
  }
}

function newClient() {
  requireConfig()
  return new ImapFlow({
    host: CONFIG.host,
    port: CONFIG.port,
    secure: CONFIG.secure,
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

/** Strip anything that could echo the password back through an error message. */
function safeMessage(error) {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.split(CONFIG.pass || "\u0000").join("[redacted]")
}

const server = new McpServer({ name: "aydu-mail", version: "1.0.0" })

server.tool(
  "save_draft",
  "Save an email as a draft in the account's Drafts folder. It never sends mail: a human reviews and sends it. " +
    "Provide both an HTML body and a plain-text alternative.",
  {
    to: z.string().describe("Recipient address list, comma separated"),
    subject: z.string().describe("Subject line"),
    html: z.string().describe("HTML body"),
    text: z.string().describe("Plain-text alternative body"),
    cc: z.string().optional().describe("CC address list, comma separated"),
  },
  async ({ to, subject, html, text, cc }) => {
    let client
    try {
      const mime = await buildDraftMime({ from: CONFIG.user, to, cc, subject, html, text })

      client = newClient()
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
              },
              null,
              2,
            ),
          },
        ],
      }
    } catch (error) {
      const isInput = error instanceof DraftInputError
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `${isInput ? "Invalid input" : "Draft not saved"}: ${safeMessage(error)}`,
          },
        ],
      }
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
      client = newClient()
      await client.connect()
      const draftsPath = await resolveDraftsPath(client)
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { connected: true, host: CONFIG.host, port: CONFIG.port, user: CONFIG.user, draftsMailbox: draftsPath },
              null,
              2,
            ),
          },
        ],
      }
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: `Connection failed: ${safeMessage(error)}` }] }
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

await server.connect(new StdioServerTransport())
