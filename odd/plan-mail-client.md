# Mail client parity plan

What this server needs to behave like a mail client, in what order, and what it
deliberately will not do.

Status: proposal, not started. Every phase below is one pull request.

## Scope, stated honestly

"Full mail client parity" is the wrong target. A client has a UI, push
notifications and a local index; an agent needs operations. A client also has
permanent deletion, which in the hands of a model is the only irreversible
action in the whole set.

So this plan is organised by capability, with safety ahead of features.

## Safety model

Each capability stays a switch that registers or removes tools at startup. With
mailbox writes, the switches also encode a hierarchy of damage:

| Level | Switch | What it permits | Reversible |
|---|---|---|---|
| 0 | none | read mailboxes, bodies, attachments to disk | yes |
| 1 | `AYDU_MAIL_ALLOW_ORGANIZE` | flags, move, copy, archive | yes |
| 2 | `AYDU_MAIL_ALLOW_FOLDERS` | create, rename, delete folders | delete is not fully |
| 3 | `AYDU_MAIL_ALLOW_TRASH` | move to Trash | yes, from a client |
| 4 | `AYDU_MAIL_ALLOW_PERMANENT_DELETE` | real deletion | **no** |

Rules that hold across every phase:

- **No global `EXPUNGE`, ever.** Destructive operations take an explicit UID
  list, capped at 50 per call, and report exactly what they touched.
- **Level 4 is never inherited.** It is not implied by TRASH, by ORGANIZE, or by
  any combination. It is asked for by its own name.
- **The README describes what the agent can reach, not what a tool accepts.**
  This was the blocker review found in `send_draft`: `save_draft` is always
  registered, so a switch that only narrows one tool does not narrow the agent.
  With ORGANIZE and TRASH on, an agent can make a mailbox unrecognisable. That
  sentence belongs in the README, not in a footnote.

## Phases

### Phase 1 — Threads and attachment reading

No new switches. Nothing here can modify a mailbox, and it is where the daily
value is.

- `get_thread` builds a conversation from `Message-ID`, `References` and
  `In-Reply-To`: search by header for the message id, then walk the `References`
  chain upward, with a bounded depth and a bounded message count. It is
  heuristic and will be documented as such: IMAP has no threading, and Gmail's
  `X-GM-THRID` is a provider extension we will not assume.
- `list_attachments` enumerates parts from the fetched `bodyStructure`:
  part id, filename, content type, size, disposition.
- `get_attachment` downloads one part to a configured directory
  (`AYDU_MAIL_DOWNLOAD_DIR`), with a sanitised filename, a size cap, a
  confinement check on the resolved path, and no overwriting of an existing
  file — a collision gets a numbered suffix instead.

Tests: thread assembly and filename sanitisation are pure functions with their
own suite; the download path is exercised against the fake client.

### Phase 2 — Reversible organisation

Switch: `AYDU_MAIL_ALLOW_ORGANIZE`.

- `mark_messages` sets and clears `\Seen`, `\Flagged` and `\Answered` on a UID
  list. Marking read and unread is the same tool with a different flag.
- `move_messages` uses `MOVE` when the server advertises it. The fallback is
  `COPY` + `STORE +FLAGS (\Deleted)` + `UID EXPUNGE` scoped to exactly those
  UIDs, never a mailbox-wide expunge.
- `copy_messages` is `COPY` and touches nothing else.
- `archive_messages` moves to the folder carrying the `\Archive` special-use
  flag; when the account has none it reports that instead of guessing a name.

Prerequisite built here, before the first mutating tool lands: the fake client
grows into a small in-memory mailbox — folder tree, messages with flags, MIME
parts, observable `EXPUNGE`. Every mutation below is tested against it. Without
that, these tools would ship with the same blind spot the signature field had.

### Phase 3 — Folders

Switch: `AYDU_MAIL_ALLOW_FOLDERS`.

- `create_folder`, `rename_folder`, `delete_folder`, `subscribe_folder`.
- The hierarchy separator comes from the server's `LIST`; it is never assumed to
  be `/`. Nested creation is a path in that dialect.
- `delete_folder` refuses `INBOX`, refuses any folder with a special-use flag,
  and refuses a non-empty folder unless `force: true` is passed — and then it
  reports how many messages were in it.
- Every path is checked for traversal before it reaches the wire.

### Phase 4 — Drafts and replies

- `update_draft` replaces a draft instead of appending a second one, which is
  the behaviour that annoys first: today re-drafting duplicates.
- `reply_draft` sets `In-Reply-To` and `References` from the original and quotes
  the body, so replies land in the conversation instead of beside it.
- `forward_draft` for completeness.

This phase depends on Phase 1: without a thread, a "reply" is just a message
with a header.

### Phase 5 — Attachments when composing

Extends the existing `AYDU_MAIL_ALLOW_SEND` and `AYDU_MAIL_ALLOW_SEND_DRAFT`.

- `save_draft` and `send_email` accept `attachments: [{ path }]`, resolved
  inside the configured upload directory with a per-file and total size cap, and
  RFC 2231 encoding for non-ASCII filenames.
- Attachments already inside a draft travel with `send_draft` untouched, so this
  phase only covers composition.

### Phase 6 — Deletion

- `trash_messages` under `AYDU_MAIL_ALLOW_TRASH`: a move to the `\Trash` folder.
- `delete_permanently` under `AYDU_MAIL_ALLOW_PERMANENT_DELETE`: explicit UID
  list, UID-scoped expunge, and a response that echoes what was destroyed.

Last on purpose. It should not exist while the phases above are unproven.

## Risk register

| Risk | Where | Mitigation |
|---|---|---|
| Irreversible data loss | `delete_permanently`, `delete_folder force` | own switch, explicit UIDs, echo of the outcome |
| Silent expunge of unrelated mail | move fallback | `UID EXPUNGE` scoped to the moved set |
| Writing outside the intended directory | attachment download and upload | resolved-path confinement, sanitised names, no overwrite |
| A switch that reads narrower than it is | every new switch | README states reach, not acceptance; the claim is a review target |
| Folder dialect differences | Phase 3 | delimiter from `LIST`, never hardcoded |
| Thread heuristic wrong | Phase 1 | labelled as heuristic, bounded, never used for deletion decisions |

## Refused by design

- **`IDLE` and push notifications.** They need a long-lived process; this server
  is request and response. Out of scope until someone asks for it seriously.
- **A local search index.** It duplicates the mailbox, creates state that drifts,
  and the server's own `SEARCH` already does the work.
- **A generic `run_imap_command` tool.** It would bypass every rule above in one
  line.
- **Permanent deletion on by default, in any combination.**

## Delivery

One pull request per phase, each under the ~400 authored-line review slice:
shaping and pure logic first with their tests, then the wiring, then the docs.
The phases are ordered so that nothing destructive exists before the harness
that can prove it does the right thing.
