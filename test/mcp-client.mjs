// SPDX-License-Identifier: MIT

/**
 * A minimal stdio MCP client for the tests.
 *
 * The server's promises are about what a client sees, so the tests speak the
 * real protocol: initialize, then list tools or call one. No mail server is
 * involved, and an ambient AYDU_* variable can never influence a result.
 */

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "server.mjs")
const TIMEOUT_MS = 15000

/** Start the server, send the given requests in order, and return the last result. */
function exchange(env, requests) {
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  })

  const lastId = requests[requests.length - 1].id
  let buffer = ""
  let stderr = ""

  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`no answer to request ${lastId}. stderr: ${stderr}`))
    }, TIMEOUT_MS)

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
          continue
        }
        if (message.id === lastId) {
          clearTimeout(timer)
          if (message.error) reject(new Error(JSON.stringify(message.error)))
          else resolve(message.result)
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
  for (const request of requests) send(request)

  return done.finally(() => child.kill())
}

export async function listTools(env = {}) {
  const result = await exchange(env, [{ jsonrpc: "2.0", id: 2, method: "tools/list" }])
  return result?.tools ?? []
}

export async function callTool(env, name, args = {}) {
  const result = await exchange(env, [
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
  ])
  return {
    isError: result?.isError === true,
    text: (result?.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
  }
}
