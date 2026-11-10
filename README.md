# aydu-mail-mcp

A minimal [Model Context Protocol](https://modelcontextprotocol.io) server for a single IMAP/SMTP mailbox.

It does four things well:

- **`save_draft`** — prepares a message with correct MIME (HTML plus a plain-text alternative, both UTF-8) and appends it to the account's `Drafts` folder.
- **`list_mailboxes`, `list_messages`, `get_message`, `search_messages`** — the read side, so an agent can see a mailbox instead of composing blind. See [Reading mail](#reading-mail).
- **`send_email`** — sends over SMTP. **Off by default.** See [Sending is opt-in](#sending-is-opt-in).
- **`list_signatures`** — several local HTML signatures, chosen per message. **Only when configured.** See [Signatures](#signatures).

That asymmetry is the design. Most email MCP servers treat compose and send as one capability, which means an agent that can write a message can also deliver it. Here they are separate tools, and the destructive one does not exist unless you ask for it. The same rule governs signatures: no configured directory, no signature capability.

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
| `list_mailboxes` | always | Mailbox paths with message and unseen counts |
| `list_messages` | always | Message metadata, newest first, never a body |
| `get_message` | always | One message: headers, text, or HTML |
| `search_messages` | always | IMAP search across a mailbox |
| `list_signatures` | **only when `AYDU_MAIL_SIGNATURES_DIR` is set** | Lists the configured local signatures by name |
| `send_draft` | **only when `AYDU_MAIL_ALLOW_SEND_DRAFT` is truthy** | Delivers an existing draft by uid, exactly as stored |
| `send_email` | **only when `AYDU_MAIL_ALLOW_SEND` is truthy** | Sends the same validated message over SMTP |

Each opt-in tool is **not registered at all** when its variable is absent — it does not appear in `tools/list`, so a client cannot call it and an agent never sees it. This is a capability boundary, not a guard clause. `test/tools-list.test.mjs` asserts it over the real stdio protocol.

## Sending is opt-in

```bash
AYDU_MAIL_ALLOW_SEND=true   # register send_email
```

Without it, drafting is the only write path. Enable it when you actually want an agent to deliver mail.

`send_email` is irreversible outbound mail. If your workflow requires a human to press send, leave the variable unset and use `save_draft`.

### Three ways out, in order of how much the agent can do alone

| Path | Switch | What the agent controls |
|---|---|---|
| `save_draft` | always on | the whole message, but nothing leaves the building |
| `send_draft` | `AYDU_MAIL_ALLOW_SEND_DRAFT` | nothing except which existing draft to deliver |
| `send_email` | `AYDU_MAIL_ALLOW_SEND` | the whole message, and its delivery |

`send_draft` is the middle rung, and the one that fits a review workflow. It takes a single uid and nothing else: no recipient, no subject, no body. The message is delivered exactly as it sits in Drafts, with the envelope read from its own headers, so whatever you edited in your mail client is what arrives.

Two consequences worth knowing before you enable it. The draft is **not** deleted or moved after sending, so calling it twice delivers twice. And the switches are independent: setting `AYDU_MAIL_ALLOW_SEND` does not register `send_draft`, and setting `AYDU_MAIL_ALLOW_SEND_DRAFT` does not register `send_email`.

## Reading mail

Four read-only tools, registered in every configuration:

| Tool | Returns |
|---|---|
| `list_mailboxes` | path, name, special-use flag, message count, unseen count |
| `list_messages` | metadata for one page of messages, newest first |
| `get_message` | one message as headers, text, or HTML |
| `search_messages` | metadata for messages matching `from`, `to`, `subject`, `text`, `since`, `before`, `unseen` |

Metadata and bodies are separate calls on purpose. `list_messages` never returns a body: a triage call that dumped fifty full messages would consume a model's context and tell it nothing useful. Fetch one message only when you need it.

Paging is UID-based, so it stays stable while new mail arrives. The `uid` of the oldest message on a page is the `beforeUid` of the next one:

> Show me the last 10 messages in INBOX, then the 10 before those.

Limits are enforced, not trusted: `limit` defaults to 20 and is capped at 50, and one body is cut at 100000 bytes with `truncated: true`.

Reading never modifies mail. Each read opens the mailbox with `EXAMINE` and fetches with `BODY.PEEK`, so nothing is marked as read and no flag changes. There is no tool that moves, flags, or deletes a message.

## Signatures

Keep several signatures on disk and choose one per message. Nothing is stored in this repository: a signature is a file you edit in place.

```bash
mkdir -p ~/.config/aydu-mail/signatures
$EDITOR ~/.config/aydu-mail/signatures/work.html      # the HTML variant
$EDITOR ~/.config/aydu-mail/signatures/personal.html
```

```bash
AYDU_MAIL_SIGNATURES_DIR=/home/you/.config/aydu-mail/signatures
AYDU_MAIL_DEFAULT_SIGNATURE=work                        # optional
```

The name is the file stem. `work.html` is the signature `work`.

- `list_signatures` returns the names and sizes; it never returns the HTML. Setting the directory registers the tool, and until then the `signature` argument does not exist in any schema.
- `save_draft` and `send_email` accept `signature`. Omitted, `AYDU_MAIL_DEFAULT_SIGNATURE` is applied. If neither is set, no signature is added.
- The HTML is inserted just before `</body>`; the plain-text alternative gets it after the `-- ` delimiter, so both halves of the `multipart/alternative` carry the signature.

Pair the HTML with a plain text version when the markup would render badly as text:

```bash
$EDITOR ~/.config/aydu-mail/signatures/work.txt
```

Without that file the text part is derived from the HTML: tags dropped, entities decoded, whitespace collapsed, `<style>` and `<script>` discarded. Good enough for a footer, not for a layout you care about.

A file larger than 64 KiB is refused rather than truncated, a name that would escape the directory is rejected, and a `.txt` companion that resolves outside it is refused too.

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
| `AYDU_MAIL_ALLOW_SEND_DRAFT` | no | unset (**off**) | Set truthy to register `send_draft`, independent of the switch above |
| `AYDU_MAIL_SIGNATURES_DIR` | no | unset (**off**) | Directory of `<name>.html` signatures; setting it registers `list_signatures` |
| `AYDU_MAIL_DEFAULT_SIGNATURE` | no | unset | Signature applied when a tool call omits `signature` |
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
- **Reading cannot write.** Read tools open mailboxes with `EXAMINE` and fetch with `BODY.PEEK`; no read path calls STORE, and no tool moves or deletes a message.
- **Signature files are read, never written.** The server has no code that creates or edits a signature, so an agent cannot leave one behind. Names are plain file stems and every resolved path is checked with `realpath`, so a symlink cannot read a file outside the configured directory.
- **Connections are always closed**, including on error paths.

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## Tests

```bash
npm test
```

Covers MIME structure, UTF-8 handling, accent round-tripping, configuration defaults, signature resolution and rendering, the read-side shaping, the send opt-in rule, and rejection of header-injection attempts. No mail server required.

Two suites speak the real MCP protocol over stdio: `test/tools-list.test.mjs` asserts which tools a client can see in each configuration, and `test/read-tools.test.mjs` exercises the read handlers on the paths that provably cannot reach a server (validation, missing credentials, refused connection). CI has no mailbox, so the IMAP wire calls themselves are not under test — everything that decides what a caller sees is.

## Limitations

- One mailbox per process. Run separate instances for separate accounts.
- Plain-text and HTML bodies only. Attachments are detected but cannot be fetched.
- Drafts are appended, never edited. Re-drafting the same message creates a second draft.
- `send_email` does not thread replies (no `In-Reply-To`/`References`).
- `send_draft` does not remove or move the draft after delivering it, so a repeated call sends the message again.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

MIT — see [LICENSE](LICENSE). Every source file carries an SPDX identifier.
