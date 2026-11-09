# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's private reporting: go to the [Security tab](https://github.com/rafaga2469/aydu-mail-mcp/security) and choose *Report a vulnerability*. That opens a private advisory visible only to the maintainer.

Please include:

- What the vulnerability allows an attacker to do
- Steps to reproduce, with a minimal tool call if applicable
- Node version and mail provider
- Whether `AYDU_MAIL_ALLOW_SEND` was enabled

You can expect an acknowledgement within 72 hours and an assessment within 7 days. If the report is valid, a fix is prepared privately and published with an advisory crediting you, unless you prefer otherwise.

## Scope

In scope, because this server handles credentials and outbound mail:

- Header injection reaching the envelope or the message (`\r`, `\n`, NUL in any header field)
- Credential disclosure through tool output, error messages, or logs
- Paths where a message is delivered when `AYDU_MAIL_ALLOW_SEND` is not enabled
- TLS verification being bypassed or downgraded
- Anything that lets a caller read a password back out of the process

Out of scope:

- The security of your mail provider
- Misconfiguration of your own environment (for example passing a password on a shared command line)
- Vulnerabilities in dependencies that do not affect this server — report those upstream, though a note here is welcome
- An agent choosing to call `send_email` when you enabled it. Enabling it is the authorization; if you need a human gate, leave it unset.

## Design decisions that bound the risk

These are deliberate and will not be relaxed:

1. **Sending is a separate tool, registered only when `AYDU_MAIL_ALLOW_SEND` is truthy.** Without it, `send_email` is absent from `tools/list`, not merely disabled.
2. **All header values are validated before a message is built.** CRLF and NUL are rejected; recipients must match an address pattern.
3. **`send_email` transmits the exact bytes `save_draft` would have stored.** One validated code path, so a message cannot pass validation as a draft and then diverge on send.
4. **Passwords are redacted from every error surfaced to a client.**
5. **Connections are closed on all paths, including failures.**

## Supported versions

The latest published revision on `master` receives fixes. This is a small project without long-term support branches; upgrade to the current commit.
