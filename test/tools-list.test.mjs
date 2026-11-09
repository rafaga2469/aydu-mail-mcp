// SPDX-License-Identifier: MIT

/**
 * Capability-boundary tests through the public MCP interface.
 *
 * The server's core promise is that a disabled capability is absent from
 * tools/list, not merely refused at call time. Asserting on the real protocol
 * response is the only way to test that promise: importing the module would
 * connect a transport and prove nothing about what a client actually sees.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "server.mjs")

/** Start the server with exactly this environment and return its tool list. */
async function listTools(env) {
  // A fresh environment: an ambient AYDU_* variable must never change the result.
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  })

  let buffer = ""
  let stderr = ""

  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`tools/list timed out. stderr: ${stderr}`))
    }, 10000)

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString()
      let newline
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.length === 0) continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          // Not a protocol message on stdout; nothing to do with the tool list.
          continue
        }
        if (message.id === 2) {
          clearTimeout(timer)
          resolve(message.result?.tools ?? [])
        }
      }
    })

    child.on("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`server exited with ${code} before answering. stderr: ${stderr}`))
    })
  })

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "aydu-mail-mcp-tests", version: "1.0.0" },
    },
  })
  send({ jsonrpc: "2.0", method: "notifications/initialized" })
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" })

  try {
    return await done
  } finally {
    child.kill()
  }
}

const names = (tools) => tools.map((tool) => tool.name).sort()
const inputProps = (tools, name) => {
  const tool = tools.find((candidate) => candidate.name === name)
  assert.ok(tool, `${name} must be registered`)
  return Object.keys(tool.inputSchema?.properties ?? {}).sort()
}

test("ships drafting and connection checks without exposing sending", async () => {
  const tools = await listTools({})
  assert.deepEqual(names(tools), ["check_connection", "save_draft"])
})

test("send_email appears only when sending is enabled", async () => {
  const tools = await listTools({ AYDU_MAIL_ALLOW_SEND: "true" })
  assert.deepEqual(names(tools), ["check_connection", "save_draft", "send_email"])
})

test("signature selection is absent until a signature directory is configured", async () => {
  const tools = await listTools({})
  assert.deepEqual(inputProps(tools, "save_draft"), ["cc", "html", "subject", "text", "to"])
})

test("configuring signatures exposes the tool and the schema field", async () => {
  const tools = await listTools({ AYDU_MAIL_SIGNATURES_DIR: "/tmp/aydu-signatures" })
  assert.deepEqual(names(tools), ["check_connection", "list_signatures", "save_draft"])
  assert.deepEqual(inputProps(tools, "save_draft"), [
    "cc",
    "html",
    "signature",
    "subject",
    "text",
    "to",
  ])
})

test("sending and signatures can be enabled at the same time", async () => {
  const tools = await listTools({
    AYDU_MAIL_ALLOW_SEND: "1",
    AYDU_MAIL_SIGNATURES_DIR: "/tmp/aydu-signatures",
  })
  assert.deepEqual(names(tools), [
    "check_connection",
    "list_signatures",
    "save_draft",
    "send_email",
  ])
  assert.deepEqual(inputProps(tools, "send_email"), [
    "cc",
    "html",
    "signature",
    "subject",
    "text",
    "to",
  ])
})
