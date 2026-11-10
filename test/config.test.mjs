// SPDX-License-Identifier: MIT

import { test } from "node:test"
import assert from "node:assert/strict"
import { readConfig, sendDraftEnabled, sendEnabled } from "../src/config.mjs"

const base = {
  AYDU_MAIL_USER: "hola@example.com",
  AYDU_MAIL_PASS: "secret-value",
}

test("sending is off unless explicitly enabled", () => {
  assert.equal(sendEnabled(readConfig(base)), false)
  assert.equal(sendEnabled(readConfig({ ...base, AYDU_MAIL_ALLOW_SEND: "false" })), false)
  assert.equal(sendEnabled(readConfig({ ...base, AYDU_MAIL_ALLOW_SEND: "0" })), false)
  assert.equal(sendEnabled(readConfig({ ...base, AYDU_MAIL_ALLOW_SEND: "" })), false)
})

test("sending turns on only for an explicit truthy value", () => {
  for (const value of ["true", "TRUE", "1", "yes"]) {
    assert.equal(sendEnabled(readConfig({ ...base, AYDU_MAIL_ALLOW_SEND: value })), true, value)
  }
})

test("IMAP defaults target GoDaddy over implicit TLS", () => {
  const config = readConfig(base)
  assert.equal(config.imap.host, "imap.secureserver.net")
  assert.equal(config.imap.port, 993)
  assert.equal(config.imap.secure, true)
})

test("SMTP defaults target GoDaddy over implicit TLS", () => {
  const config = readConfig(base)
  assert.equal(config.smtp.host, "smtpout.secureserver.net")
  assert.equal(config.smtp.port, 465)
  assert.equal(config.smtp.secure, true)
})

test("explicit overrides win over defaults", () => {
  const config = readConfig({
    ...base,
    AYDU_MAIL_HOST: "imap.example.org",
    AYDU_MAIL_PORT: "143",
    AYDU_MAIL_SECURE: "false",
    AYDU_SMTP_HOST: "smtp.example.org",
    AYDU_SMTP_PORT: "587",
    AYDU_SMTP_SECURE: "false",
  })
  assert.equal(config.imap.host, "imap.example.org")
  assert.equal(config.imap.port, 143)
  assert.equal(config.imap.secure, false)
  assert.equal(config.smtp.host, "smtp.example.org")
  assert.equal(config.smtp.port, 587)
  assert.equal(config.smtp.secure, false)
})

test("credentials are carried but never surfaced by describe()", () => {
  const config = readConfig(base)
  assert.equal(config.user, "hola@example.com")
  assert.equal(config.pass, "secret-value")
  const described = JSON.stringify(config.describe())
  assert.ok(!described.includes("secret-value"), "describe() must not leak the password")
})

test("a non-numeric port falls back to the default instead of NaN", () => {
  const config = readConfig({ ...base, AYDU_MAIL_PORT: "not-a-port" })
  assert.equal(config.imap.port, 993)
})

test("signatures are not configured until a directory is named", () => {
  assert.deepEqual(readConfig(base).signatures, { dir: undefined, defaultName: undefined })
  assert.deepEqual(readConfig({ ...base, AYDU_MAIL_SIGNATURES_DIR: "" }).signatures, {
    dir: undefined,
    defaultName: undefined,
  })
})

test("reads the signature directory and the default signature", () => {
  const config = readConfig({
    ...base,
    AYDU_MAIL_SIGNATURES_DIR: "/home/ana/.mail/signatures",
    AYDU_MAIL_DEFAULT_SIGNATURE: "work",
  })
  assert.deepEqual(config.signatures, {
    dir: "/home/ana/.mail/signatures",
    defaultName: "work",
  })
  assert.deepEqual(config.describe().signatures, {
    enabled: true,
    dir: "/home/ana/.mail/signatures",
    default: "work",
  })
})

test("describe() omits signatures entirely when unconfigured", () => {
  const described = readConfig(base).describe()
  assert.equal("signatures" in described, false)
  // The payload must match the exact pre-signature shape, nothing else.
  assert.deepEqual(described, {
    user: base.AYDU_MAIL_USER,
    allowSend: false,
    imap: { host: "imap.secureserver.net", port: 993, secure: true },
    smtp: { host: "smtpout.secureserver.net", port: 465, secure: true },
  })
  // A blank directory value counts as unset, not as an empty name.
  assert.equal("signatures" in readConfig({ ...base, AYDU_MAIL_SIGNATURES_DIR: "" }).describe(), false)
})

test("delivering a draft is off unless explicitly enabled", () => {
  assert.equal(sendDraftEnabled(readConfig(base)), false)
  assert.equal(sendDraftEnabled(readConfig({ ...base, AYDU_MAIL_ALLOW_SEND_DRAFT: "false" })), false)
  assert.equal(sendDraftEnabled(readConfig({ ...base, AYDU_MAIL_ALLOW_SEND_DRAFT: "" })), false)
})

test("delivering a draft does not inherit the compose switch", () => {
  // The narrower capability must never be turned on by the wider one.
  assert.equal(sendDraftEnabled(readConfig({ ...base, AYDU_MAIL_ALLOW_SEND: "true" })), false)
  for (const value of ["true", "1", "yes", "on"]) {
    assert.equal(
      sendDraftEnabled(readConfig({ ...base, AYDU_MAIL_ALLOW_SEND_DRAFT: value })),
      true,
      value,
    )
  }
})
