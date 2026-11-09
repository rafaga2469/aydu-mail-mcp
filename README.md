# aydu-mail-mcp

A minimal [Model Context Protocol](https://modelcontextprotocol.io) server for a single IMAP/SMTP mailbox.

It does two things well:

- **`save_draft`** — prepares a message with correct MIME (HTML plus a plain-text alternative, both UTF-8) and appends it to the account's `Drafts` folder.
- **`send_email`** — sends over SMTP. **Off by default.** See [Sending is opt-in](#sending-is-opt-in).

That asymmetry is the design. Most email MCP servers treat compose and send as one capability, which means an agent that can write a message can also deliver it. Here they are separate tools, and the destructive one does not exist unless you ask for it.

## Why this exists

I audited the popular email MCP servers for a job that only needed drafts. None fit:

| Server | Saves drafts | Correct HTML + UTF-8 | Notes |
|---|---|---|---|
| `imap-mcp` | yes | **no** | builds headers by hand: no `Content-Type`, no `MIME-Version`, no charset, so HTML lands as raw text and accents break; also vulnerable to header injection |
| `mcp-mail-server` | no | n/a | compose means send; no draft path |
| `@n24q02m/email` | no | yes | excellent engineering, but zero draft support |

Drafts are the interesting case: a human reviews the message in their real mail client before anything leaves the building. So this server does that one thing properly by handing the message to Nodemailer's `MailComposer`, then `APPEND`ing it with the `\Draft` flag — and exposes sending separately, behind an explicit opt-in.

## Tools

| Tool | Available | Purpose |
|---|---|---|
| `save_draft` | always | Builds a `multipart/alternative` message and appends it to Drafts |
| `check_connection` | always | Verifies IMAP connectivity and reports which mailbox would receive drafts |
| `send_email` | **only when `AYDU_MAIL_ALLOW_SEND` is truthy** | Sends the same validated message over SMTP |

When sending is not enabled the `send_email` tool is **not registered at all** — it does not appear in `tools/list`, so a client cannot call it and an agent never sees it. This is a capability boundary, not a guard clause.

## Sending is opt-in

```bash
AYDU_MAIL_ALLOW_SEND=true   # register send_email
```

Without it, drafting is the only write path. Enable it when you actually want an agent to deliver mail.

`send_email` is irreversible outbound mail. If your workflow requires a human to press send, leave the variable unset and use `save_draft`.

## Requirements

- Node.js 20 or newer
- An IMAP account with a `Drafts` folder (any provider)
- Optional: `secret-tool` (libsecret) if you want the launcher to read the password from your OS keyring

## Install

```bash
git clone https://github.com/rafaga2469/aydu-mail-mcp.git
cd aydu-mail-mcp
npm install
```

## Configuration

Everything comes from the environment. Nothing is read from a config file.

| Variable | Required | Default | Description |
|---|---|---|---|
| `AYDU_MAIL_USER` | yes | — | Full mailbox address; used as IMAP/SMTP user and as `From` |
| `AYDU_MAIL_PASS` | yes | — | Mailbox password or app password |
| `AYDU_MAIL_ALLOW_SEND` | no | unset (**off**) | Set truthy (`true`, `1`, `yes`, `on`) to register `send_email` |
| `AYDU_MAIL_HOST` | no | `imap.secureserver.net` | IMAP host |
| `AYDU_MAIL_PORT` | no | `993` | IMAP port |
| `AYDU_MAIL_SECURE` | no | `true` | Set `false` for plaintext/STARTTLS |
| `AYDU_SMTP_HOST` | no | `smtpout.secureserver.net` | SMTP host |
| `AYDU_SMTP_PORT` | no | `465` | SMTP port |
| `AYDU_SMTP_SECURE` | no | `true` | Set `false` on port 587 to require STARTTLS |

The defaults target GoDaddy (Professional Email / Workspace Email), which is what this was first written for. Point them anywhere: Gmail with an app password, Fastmail, a corporate relay.

A non-numeric port falls back to the default rather than producing `NaN`.

### Keeping the password out of config files

MCP client configs are frequently plain text and frequently committed. The bundled launcher reads the password from the OS keyring instead:

```bash
secret-tool store --label='mailbox' service aydu-mail account you@example.com
```

A password supplied through `AYDU_MAIL_PASS` takes precedence, which keeps the launcher usable from a shell, CI job, or systemd unit.

## MCP client setup

```jsonc
{
  "mcpServers": {
    "mail": {
      "command": "/absolute/path/to/aydu-mail-mcp/bin/aydu-mail-mcp",
      "args": []
    }
  }
}
```

Or skip the launcher and pass the environment directly:

```jsonc
{
  "mcpServers": {
    "mail": {
      "command": "node",
      "args": ["/absolute/path/to/aydu-mail-mcp/src/server.mjs"],
      "env": {
        "AYDU_MAIL_USER": "you@example.com",
        "AYDU_MAIL_PASS": "app-password"
      }
    }
  }
}
```

## Usage

Draft the message and let a human send it:

> Draft the delivery email to diana@example.com with subject "Delivery final" and save it as a draft — don't send it.

`save_draft` returns the mailbox path and server-assigned UID:

```json
{
  "saved": true,
  "mailbox": "Drafts",
  "uid": 4212,
  "to": "diana@example.com",
  "subject": "Delivery final"
}
```

With `AYDU_MAIL_ALLOW_SEND=true`, `send_email` returns delivery facts instead:

```json
{
  "sent": true,
  "messageId": "<...@example.com>",
  "accepted": ["diana@example.com"],
  "to": "diana@example.com",
  "subject": "Delivery final"
}
```

## Security notes

- **Send is a separate, opt-in capability.** Not a flag inside a compose tool: the tool is absent unless enabled.
- **Header injection is rejected.** Any `\r`, `\n`, or NUL in a header value fails with `DraftInputError` before a message is built, so a crafted subject cannot inject `Bcc:` or rewrite the envelope.
- **Recipients are validated** against an address pattern; malformed addresses are refused rather than passed through.
- **Send reuses the drafted bytes.** `send_email` builds the message with the same validated code path and sends it as `raw`, so the delivered bytes match what a draft would have contained.
- **Passwords are redacted** from error messages, so a failed connection never echoes a credential into an agent transcript.
- **Connections are always closed**, including on error paths.

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## Tests

```bash
npm test
```

Covers MIME structure, UTF-8 handling, accent round-tripping, configuration defaults, the send opt-in rule, and rejection of header-injection attempts. No mail server required.

## Limitations

- One mailbox per process. Run separate instances for separate accounts.
- Plain-text and HTML bodies only; no attachments yet.
- Drafts are appended, never edited. Re-drafting the same message creates a second draft.
- `send_email` does not thread replies (no `In-Reply-To`/`References`).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

MIT — see [LICENSE](LICENSE). Every source file carries an SPDX identifier.
