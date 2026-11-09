// SPDX-License-Identifier: MIT

/**
 * Configuration is read from the environment exactly once, so a running server
 * cannot drift from the values it was launched with.
 */

const DEFAULT_IMAP_HOST = "imap.secureserver.net"
const DEFAULT_IMAP_PORT = 993
const DEFAULT_SMTP_HOST = "smtpout.secureserver.net"
const DEFAULT_SMTP_PORT = 465

const TRUTHY = new Set(["true", "1", "yes", "on"])

/** An unset or empty variable counts as absent, never as an empty value. */
function asText(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function asPort(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback
}

function asBool(value, fallback) {
  if (value === undefined || value === "") return fallback
  return TRUTHY.has(String(value).toLowerCase())
}

/** True only for an explicit affirmative value. Anything else keeps sending off. */
export function sendEnabled(config) {
  return config.allowSend === true
}

export function readConfig(env = process.env) {
  const user = env.AYDU_MAIL_USER
  const pass = env.AYDU_MAIL_PASS

  const config = {
    user,
    pass,
    allowSend: asBool(env.AYDU_MAIL_ALLOW_SEND, false),
    imap: {
      host: env.AYDU_MAIL_HOST || DEFAULT_IMAP_HOST,
      port: asPort(env.AYDU_MAIL_PORT, DEFAULT_IMAP_PORT),
      secure: asBool(env.AYDU_MAIL_SECURE, true),
    },
    smtp: {
      host: env.AYDU_SMTP_HOST || DEFAULT_SMTP_HOST,
      port: asPort(env.AYDU_SMTP_PORT, DEFAULT_SMTP_PORT),
      secure: asBool(env.AYDU_SMTP_SECURE, true),
    },
    // No directory means the capability is absent, not that it is guarded.
    signatures: {
      dir: asText(env.AYDU_MAIL_SIGNATURES_DIR),
      defaultName: asText(env.AYDU_MAIL_DEFAULT_SIGNATURE),
    },
  }

  // describe() is the only safe representation to log or return to a caller.
  config.describe = () => ({
    user: config.user,
    allowSend: config.allowSend,
    imap: { ...config.imap },
    smtp: { ...config.smtp },
    signatures: {
      enabled: config.signatures.dir !== undefined,
      dir: config.signatures.dir,
      default: config.signatures.defaultName,
    },
  })

  return config
}

/** Throws a message that names what is missing but never echoes a value. */
export function requireCredentials(config) {
  const missing = []
  if (!config.user) missing.push("AYDU_MAIL_USER")
  if (!config.pass) missing.push("AYDU_MAIL_PASS")
  if (missing.length > 0) {
    throw new Error(`Missing credentials: ${missing.join(", ")} must be set`)
  }
}

/** Replaces the password wherever it appears in an error message. */
export function redact(message, config) {
  const text = typeof message === "string" ? message : String(message)
  return config.pass ? text.split(config.pass).join("[redacted]") : text
}
