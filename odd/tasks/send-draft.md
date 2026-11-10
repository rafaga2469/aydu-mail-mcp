# send-draft

Send an existing draft by UID, so a human can edit the message in their own mail client and the agent delivers exactly those bytes.
Branch: `feat/send-draft`.

## Specs

**S1** — `send_draft` is registered only when `AYDU_MAIL_ALLOW_SEND_DRAFT` is truthy. Unset, the tool is absent from `tools/list`. It is a separate switch from `AYDU_MAIL_ALLOW_SEND`, which governs free composition. It is, however, a delivery switch and not a review gate: `save_draft` is always registered, so once this switch is on, a draft the agent wrote itself is equally deliverable. The tool constrains what a single call may accept, not what the agent can reach.

**S2** — The tool takes a single required argument, `uid`: the UID of a message in the account's Drafts folder, resolved by the SPECIAL-USE `\Drafts` flag with the same name fallback `save_draft` uses. There is no way to name another mailbox, a body, a recipient or a subject.

**S3** — The message is fetched with `source: true` under `BODY.PEEK`, so reading the draft does not clear its `\Draft` flag, and the bytes sent are the bytes stored.

**S4** — Delivery passes those raw bytes to SMTP unchanged. The envelope is derived by nodemailer from the message headers; the tool composes nothing.

**S5** — A UID that does not exist in Drafts is refused with `Draft not found: <uid>`.

**S6** — The draft is left exactly as it was: not deleted, not moved, flags untouched. The result reports `sent`, `messageId`, `accepted`, `mailbox` and `uid`.

**S7** — Any failure reports `Draft not sent: <reason>` and still closes the SMTP transport and the IMAP connection.

**S8** — The safety argument must hold in tests: a call that sends performs no `append`, no flag change and no delete on the mailbox.

## Tasks

| ID | Task | Specs | Route | Commit |
|---|---|---|---|---|
| T1 | `sendDraftEnabled` in `src/config.mjs` with its test. | S1 | inline | 1 |
| T2 | The tool in `src/tools.mjs`, gated at registration, with the same connection and `finally` discipline as the other tools. | S1-S7 | worker | 1 |
| T3 | In-process tests on the fake client and fake transport, including the no-mutation assertion. | S3-S8 | worker | 1 |
| T4 | README, CHANGELOG, tools table and config table. | S1-S8 | inline | 1 |

## Log

**L1** — The user's choice, verbatim: «Empezar send_draft(uid)». It came from the backlog the user approved earlier: `send_draft(uid)` was described as the piece that closes the loop where a human reviews the draft in their real client and the agent delivers what was reviewed.

**L2** — Decisions taken by the parent, recorded so review can challenge them:
- A separate switch, because this is a third capability, not a variant of `send_email`. The first pass described it as strictly narrower, which review disproved: `send_draft` cannot compose, but `save_draft` can, so the pair reaches the same destination as `send_email`. The switch was kept because choosing delivery explicitly still has value, and the claim was corrected everywhere it appeared.
- Only `uid`. Every other input would widen the surface: a recipient, a subject or a body would let the tool compose, which is exactly what `send_email` already does under a different switch.
- The draft stays in Drafts. Moving it to Sent or clearing `\Draft` would be a write the user did not ask for, and mail clients disagree on how to represent "sent". A message can be sent twice if the caller repeats the call; that is a real risk and it is documented rather than papered over.
- The envelope comes from nodemailer's header parsing, not from a parser of ours. Writing a third address parser to re-validate bytes we produced ourselves would add a failure mode without removing one.

**L3** — Review correction (finding `R1-send-draft-capability-escalation`): the README, the CHANGELOG and L2 above claimed this switch grants only "which existing draft to deliver". It does not. `save_draft` is always registered, so the agent can append a message it composed and then deliver it by uid with `AYDU_MAIL_ALLOW_SEND` unset. The code is unchanged: enforcing the original claim would mean refusing drafts the agent wrote, which breaks the workflow this tool exists for. What changed is the claim, in all four places it was made, plus the tool description.
