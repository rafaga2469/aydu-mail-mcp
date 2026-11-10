# html-signatures

Local HTML signatures, several configured side by side, selectable per message.
Branch: `feat/signatures-and-read-tools`.

## Specs

**S1** — The signature directory comes from `AYDU_MAIL_SIGNATURES_DIR`. When it is unset the capability is absent, not guarded: `list_signatures` is never registered, and no tool schema contains a `signature` field.

**S2** — Each signature is a file `<name>.html` inside that directory. `<name>` must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`. A name containing `/`, `\`, or `..`, or whose resolved real path escapes the directory (symlink included), is rejected. No signature file is ever written by this server. Only an omitted name means "no signature": an explicit empty or whitespace-only name is rejected with `Invalid signature name: an empty value is not a signature name; omit the argument to use the default`, so a caller cannot silently bypass `AYDU_MAIL_DEFAULT_SIGNATURE`.

**S3** — `list_signatures` returns, for each signature, `name`, `bytes`, and `hasTextVersion`. It never returns the HTML body.

**S4** — `save_draft` accepts an optional `signature` name and inserts that HTML immediately before the last `</body>` (case-insensitive) of the HTML body; when the body has no `</body>`, the signature is appended after one blank line.

**S5** — The plain-text alternative carries the signature after an RFC 3676 delimiter line `-- `. The text comes from `<name>.txt` when that file exists, otherwise from a tag-stripped, entity-decoded, whitespace-collapsed rendering of `<name>.html`.

**S6** — `AYDU_MAIL_DEFAULT_SIGNATURE` is applied when a call omits `signature`. A default that names a missing file is an error, never silently ignored.

**S7** — A signature file larger than 65536 bytes is rejected with `Signature too large: <name>`.

**S8** — An unknown name is rejected with `Unknown signature: <name>. Available: a, b, c`.

**S9** — `send_email` applies the signature through the same code path as `save_draft`, so the delivered bytes carry the same signature the draft would have.

## Tasks

| ID | Task | Specs | Route | Commit |
|---|---|---|---|---|
| T1 | `src/signatures.mjs`: discovery, name validation, size cap, HTML insertion, text rendering, `-- ` joining. Tests first in `test/signatures.test.mjs`. | S2-S8 | inline | 1 |
| T2 | Wire `list_signatures` and the conditional `signature` field into `server.mjs`; both write paths use one builder. | S1, S4, S9 | inline | 2 |
| T3 | `tools/list` end-to-end test via stdio JSON-RPC, proving the capability boundary per environment. | S1 | inline | 2 |
| T4 | README tools table, configuration table, signature setup section, CHANGELOG entry, CI syntax check. | S1-S9 | inline | 3 |

## Log

**L1** — The user's original request, verbatim: «Muestrane el listado de tools de este MCP, y sabiendo que es un MCP para gestion de correos electronicos, que me sugieres agregar»

**L2** — The user's follow-up, verbatim: «Me gustan tus propuestas, pero además agreguemos algo que suelo usar mucho, permitir al usuario que configure su firme HTML local, y pueda tener vairas configuradas»

**L3** — Decisions taken by the parent from L2, recorded so review can challenge them:
- Storage is a directory of files (`<name>.html`), not a JSON config, because the user asked for signatures "locales" that a human edits in place, and a directory of HTML files is the smallest editable surface.
- The plain-text alternative is a first-class concern: this server's whole value is a correct `multipart/alternative`, so a signature that only exists in HTML would ship a broken text part. Hence the optional `.txt` companion with a derived fallback.
- Absence of `AYDU_MAIL_SIGNATURES_DIR` removes the capability instead of failing calls, matching the existing `AYDU_MAIL_ALLOW_SEND` boundary.

**L4** — Delivery slices: commit `0bdfb74` holds `src/signatures.mjs`, `src/config.mjs` and their tests; commit `e9fca48` holds the `server.mjs` wiring and the stdio boundary test; the documentation commit closes the feature. Review them in that order.

**L5** — Review correction (findings `R1-empty-signature`, `R3-001`): `applySignature` treated an explicit empty name as "no signature", which let a caller bypass `AYDU_MAIL_DEFAULT_SIGNATURE` and still report success with `signature: null`. Only omission now means no signature; an empty or whitespace-only name is rejected. S2 was rewritten to state the rule.

**L6** — Second-round review correction (findings `R3-002`, `R3-001`): `describe()` and the `save_draft`/`send_email` results exposed the new capability on the unconfigured paths, changing the output of a baseline-valid call. Both are now conditional, so a server without `AYDU_MAIL_SIGNATURES_DIR` reports exactly the payload shape it reported before signatures existed. The lesson: adding a capability must not move the baseline contract.
