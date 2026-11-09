# aydu-mail-mcp

A minimal [Model Context Protocol](https://modelcontextprotocol.io) server that saves email **drafts** into an IMAP `Drafts` folder.

It has **no send capability**. Not disabled, not guarded, not behind a flag — the code path does not exist. Composing outbound mail stays a human decision, which is the point: an agent can prepare a polished, review-ready draft, and a person opens the mailbox and sends it.

## Why

Plenty of email MCP servers exist. When I audited the popular ones for this exact job, none fit:

| Server | Saves drafts | Correct HTML + UTF-8 | Can send | Notes |
|---|---|---|---|---|
| `imap-mcp` | yes | **no** | no | builds headers by hand: no `Content-Type`, no `MIME-Version`, no charset — HTML lands as raw text and accents break; also vulnerable to header injection |
| `mcp-mail-server` | no | n/a | yes | compose means send |
| `@n24q02m/email` | no | yes | yes | excellent engineering, but zero draft support |

So this server does one thing properly: it hands the message to Nodemailer's `MailComposer` for correct MIME, then `APPEND`s it with the `\Draft` flag.

## Tools

| Tool | Purpose |
|---|---|
| `save_draft` | Builds a `multipart/alternative` message (HTML + plain-text) and appends it to Drafts |
| `check_connection` | Verifies IMAP connectivity and reports which mailbox would receive drafts |

Both are non-destructive. Neither transmits mail.

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

Credentials come from the environment. Nothing is read from a config file.

| Variable | Required | Default | Description |
|---|---|---|---|
| `AYDU_MAIL_USER` | yes | — | Full mailbox address, used as both the IMAP user and the `From` address |
| `AYDU_MAIL_PASS` | yes | — | Mailbox password or app password |
| `AYDU_MAIL_HOST` | no | `imap.secureserver.net` | IMAP host |
| `AYDU_MAIL_PORT` | no | `993` | IMAP port |
| `AYDU_MAIL_SECURE` | no | `true` | Set `false` only for a plaintext/STARTTLS endpoint |

The default host is GoDaddy's (Professional Email / Workspace Email), which is what this was first written for. Point it anywhere.

### Keeping the password out of config files

MCP client configs are frequently plain text and frequently shared. The bundled launcher reads the password from the OS keyring instead, so it never appears in `mcp.json`:

```bash
secret-tool store --label='mailbox' service aydu-mail account you@example.com
```

A password supplied via `AYDU_MAIL_PASS` takes precedence, which keeps the launcher usable from a shell, CI job, or systemd unit.

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

Or bypass the launcher and pass the environment directly:

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

Ask your agent to draft the message and save it:

> Draft the delivery email to diana@example.com with subject "Delivery final" and save it as a draft — don't send it.

`save_draft` returns the mailbox path and the server-assigned UID:

```json
{
  "saved": true,
  "mailbox": "Drafts",
  "uid": 4212,
  "to": "diana@example.com",
  "subject": "Delivery final"
}
```

The message is then waiting in your mail client, ready to review and send.

## Security notes

- **No send capability.** Outbound mail is not implemented anywhere in the source.
- **Header injection is rejected.** Any `\r`, `\n`, or NUL in a header value fails with `DraftInputError` before a message is built, so a crafted subject cannot inject `Bcc:` or rewrite the envelope.
- **Recipients are validated** against an address pattern; malformed addresses are refused rather than passed through.
- **Passwords are redacted** from error messages, so a failed connection never echoes a credential into an agent transcript.
- **Connections are always closed**, including on error paths.

## Tests

```bash
npm test
```

The suite asserts the properties that matter for a draft: correct MIME structure, UTF-8 declared on both parts, Spanish accents surviving encoding, and rejection of header-injection attempts. It runs without a mail server.

## Limitations

- One mailbox per process. Run separate instances for separate accounts.
- Plain-text and HTML bodies only; no attachments yet.
- Drafts are appended, never edited. Re-drafting the same message creates a second draft.

## License

MIT — see [LICENSE](LICENSE).
