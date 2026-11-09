# Contributing

Thanks for taking the time. This is a small server and the bar is straightforward: keep it small, keep it correct, keep it honest about what it can do.

## Getting started

```bash
git clone https://github.com/rafaga2469/aydu-mail-mcp.git
cd aydu-mail-mcp
npm install
npm test
```

Node.js 20 or newer. There is no build step — the source runs directly.

## Before you open a pull request

1. `npm test` passes. Fifteen tests, no mail server needed.
2. New behaviour comes with a test that fails without your change. Write the test first if you can: the suite is fast enough that RED/GREEN costs seconds.
3. Documentation matches the code. If you add a variable, a tool, or a behaviour, update `README.md` and `CHANGELOG.md`.
4. Every new source file starts with an SPDX identifier:

   ```js
   // SPDX-License-Identifier: MIT
   ```

## What belongs here

In scope:

- Correctness of MIME generation and IMAP/SMTP handling
- Input validation, especially anything that could reach a header
- Portability across mail providers
- Documentation clarity

Out of scope, by design:

- Making sending happen implicitly. `send_email` stays a separate tool behind `AYDU_MAIL_ALLOW_SEND`. A change that lets a draft path deliver mail will be declined.
- Adding a dependency where the standard library or an existing dependency already does the job.
- Multi-account support in one process. Run one instance per mailbox.

## Style

- ES modules, no transpiler.
- Prefer a small pure function over a class. `src/mime.mjs` and `src/config.mjs` are deliberately testable without a network.
- Comments explain *why*, not *what*. The code already says what.
- Errors returned to an MCP client must never include a credential. Use `redact()` from `src/config.mjs`.
- Always close a connection in a `finally` block.

## Commits

[Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.

Keep the subject imperative and under 72 characters. Explain motivation in the body when it is not obvious from the diff.

## Reporting bugs

Open an issue with the template. Include:

- Node version
- Mail provider and IMAP/SMTP host
- The exact tool call and the error text (with any credential removed)
- Whether `send_email` was enabled, if relevant

For a security issue, do **not** open an issue — follow [SECURITY.md](SECURITY.md).
