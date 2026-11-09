## What this changes

<!-- One paragraph. What behaviour is different after this, from a user's point of view? -->

## Why

<!-- Motivation. Link the issue if there is one. -->

## How it was verified

- [ ] `npm test` passes
- [ ] New behaviour has a test that fails without this change
- [ ] Documentation updated (`README.md`, `CHANGELOG.md`) if a tool, variable, or behaviour changed

## Capability boundary

- [ ] This change does **not** let the drafting path deliver mail
- [ ] `send_email` is still registered only when `AYDU_MAIL_ALLOW_SEND` is truthy
- [ ] No credential can reach tool output, error messages, or logs

## Notes for the reviewer

<!-- Trade-offs, follow-ups, anything you are unsure about. -->
