// SPDX-License-Identifier: MIT

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ImapFlow } from "imapflow"
import nodemailer from "nodemailer"
import { readConfig, requireCredentials } from "./config.mjs"
import { createServer } from "./tools.mjs"

const config = readConfig()

/** Build the real IMAP client, but only after checking credentials are present. */
function createImapClient() {
  requireCredentials(config)
  return new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: { user: config.user, pass: config.pass },
    logger: false,
  })
}

const server = createServer({
  config,
  createImapClient,
  createTransport: (options) => nodemailer.createTransport(options),
})

await server.connect(new StdioServerTransport())
