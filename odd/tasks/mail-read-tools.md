# mail-read-tools

Read-only mail tools so the agent can see a mailbox instead of composing blind.
Branch: `feat/signatures-and-read-tools`.

## Specs

**S1** — `list_mailboxes` returns `name`, `path`, `specialUse`, and `{exists, unseen}` for every selectable mailbox. Always registered; reading is not a destructive capability.

**S2** — `list_messages` returns metadata only: `uid`, `from`, `to`, `subject`, `date`, `messageId`, `flags`, `size`, `hasAttachments`. It never returns a message body.

**S3** — `limit` defaults to 20 and is capped at 50. Results are newest first. `beforeUid` pages to older messages: only UIDs strictly lower than the given value are returned, so the oldest uid of a page is the cursor for the next one.

**S4** — `get_message` returns one message with `format` of `headers` (default), `text`, or `html`, plus `cc`, `replyTo`, and `inReplyTo`. A body longer than 100000 bytes is cut and reported with `truncated: true`. A requested part that the message does not have is an error naming the missing type.

**S5** — `search_messages` maps `from`, `to`, `subject`, `since`, `before`, `unseen`, and `text` to an IMAP SEARCH. A call with no criterion is rejected with `search_messages requires at least one criterion`.

**S6** — `mailbox` defaults to `INBOX`. A mailbox that cannot be opened is reported as `Mailbox not found: <name>`.

**S7** — Reading never sets `\Seen`: fetches use `BODY.PEEK`.

**S8** — Every read tool closes its IMAP connection, including on error paths, and redacts the password from any error text.

**S9** — The pure logic lives in `src/read.mjs` and is covered by `test/read.test.mjs` without a mail server; `server.mjs` keeps only connection wiring.

## Tasks

| ID | Task | Specs | Route | Commit |
|---|---|---|---|---|
| T1 | `src/read.mjs`: limit clamping, uid cursor predicate, address flattening, envelope shaping, attachment detection, text extraction, search-query building. Tests first in `test/read.test.mjs`. | S2-S5, S9 | inline | 4 |
| T2 | Wire the four tools into `server.mjs` with one connection helper and structured errors. | S1-S8 | inline | 5 |
| T3 | README tools table, configuration, and CHANGELOG; CI syntax check for the new module. | S1-S9 | inline | 6 |

## Log

**L1** — Parent's proposal approved by the user: «Me gustan tus propuestas».

**L2** — Decisions taken by the parent, recorded so review can challenge them:
- Metadata and bodies are separate tools (`list_messages` vs `get_message`) so a triage never dumps 50 full messages into the model context.
- Pagination is UID-based (`beforeUid`) because IMAP UIDs are stable and monotonic within a mailbox; sequence numbers are not.
- The IMAP I/O stays thin and untested; the shaping logic is pure and tested. The repository has no mail server in CI and that does not change.

**L3** — Delivery slices: commit `src/read.mjs` with `test/read.test.mjs` first, then the `server.mjs` wiring with `test/mcp-client.mjs`, `test/tools-list.test.mjs` and `test/read-tools.test.mjs`, then documentation.

**L4** — The IMAP wiring is exercised only on paths that provably cannot reach a server (validation, missing credentials, refused connection), because CI has no mail server. Everything that shapes output is covered by `test/read.test.mjs` without a network. This is a deliberate limit, not an oversight: adding a fake IMAP server would test the fake, not the server.
