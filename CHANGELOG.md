# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-11-09

### Added

- `send_email` tool for outbound SMTP delivery, registered only when `AYDU_MAIL_ALLOW_SEND` is truthy. Without that variable the tool is absent from `tools/list`, so drafting remains the only write path.
- SMTP configuration through `AYDU_SMTP_HOST`, `AYDU_SMTP_PORT`, and `AYDU_SMTP_SECURE`.
- `src/config.mjs` centralising environment reading, port/boolean coercion, credential checks, and password redaction.
- `describe()` representation of the configuration that omits the password, used by `check_connection`.
- Documentation: `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, this changelog, issue and pull-request templates, and CI workflow.
- SPDX license identifiers on every source file.

### Changed

- `send_email` delivers the exact message bytes produced by the shared MIME builder, so the send path and the draft path cannot diverge.
- `check_connection` reports the effective configuration (without the password) alongside the resolved Drafts mailbox.
- README rewritten around the draft/send distinction and the opt-in model.

### Security

- Header validation is now shared with the send path: any input rejected for a draft is also rejected for delivery.
- A non-numeric port value falls back to the documented default instead of yielding `NaN`.

## [1.0.0] - 2026-11-09

### Added

- `save_draft` tool: builds a `multipart/alternative` message (HTML plus plain-text alternative, both UTF-8) with Nodemailer's `MailComposer` and appends it to the resolved Drafts folder with the `\Draft` flag.
- `check_connection` tool: verifies IMAP connectivity and reports the mailbox that would receive drafts.
- Drafts mailbox resolution through the `\Drafts` SPECIAL-USE flag, with a name-based fallback.
- Rejection of CRLF and NUL in header values, and validation of recipient addresses, before any message is built.
- Password redaction in all client-facing error output.
- Launcher script that reads the mailbox password from the OS keyring (libsecret), keeping secrets out of MCP client configuration.
- Test suite covering MIME structure, UTF-8 handling, accent round-tripping, and header-injection rejection, with no mail server required.

[Unreleased]: https://github.com/rafaga2469/aydu-mail-mcp/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/rafaga2469/aydu-mail-mcp/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/rafaga2469/aydu-mail-mcp/releases/tag/v1.0.0
