// A platform check for the proxy start, runnable where the suite cannot go:
// the Windows job in CI, which has no native/bin and skips every test that
// starts a proxy. It drives the REAL start path in lib/native.mjs with a
// fixture proxy that binds the way that platform's Go build does — loopback
// TCP on Windows, a private unix socket elsewhere — and writes the ready the
// real proxy writes (transport, address, pid).
//
// What it covers that nothing else does on Windows: readyFrom's descriptor
// rules, readyAddressOk's `127.0.0.1:<port>` branch, the pid comparison
// against the spawned child, and the tcp transport itself. On POSIX it is a
// second, independent witness for the same code (the suite has dozens).
//
// Usage: node scripts/check-proxy-start.mjs   (exit 0 = the start worked)
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const FIXTURE = `#!/usr/bin/env node
import { createServer } from "node:net"
import { rmSync, writeFileSync } from "node:fs"
const argv = process.argv.slice(2)
const arg = (n) => argv[argv.indexOf(n) + 1]
const transport = arg("-listen")
const address = arg("-address")
const ready = arg("-ready")
if (transport === "unix") rmSync(address, { force: true })
// 127.0.0.1:0 is what the plugin passes on Windows: the OS picks the port and
// the proxy reports the one it got, exactly as main.go does.
const target = transport === "tcp" ? "127.0.0.1" : address
const [host, port] = transport === "tcp" ? ["127.0.0.1", 0] : [null, null]
const server = createServer((socket) => {
  let buf = ""
  socket.on("error", () => {})
  socket.on("data", (d) => {
    buf += d.toString("latin1")
    if (!buf.includes("\\r\\n\\r\\n")) return
    const body = JSON.stringify({ code: 200, from: "windows-ready-fixture" })
    socket.end("HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body)
  })
})
const done = () => {
  const bound = server.address()
  const where = transport === "tcp" ? "127.0.0.1:" + bound.port : address
  writeFileSync(ready, JSON.stringify({ transport, address: where, pid: String(process.pid) }))
}
transport === "tcp" ? server.listen(port, host, done) : server.listen(target, done)
`

const dir = mkdtempSync(join(tmpdir(), "codar-ready-check-"))
const bin = join(dir, "fixture-proxy.mjs")
const saved = { bin: process.env.CODAR_PROXY_BIN, retry: process.env.CODAR_PROXY_RETRY_MS }
let code = 1
try {
  writeFileSync(bin, FIXTURE)
  chmodSync(bin, 0o755)
  process.env.CODAR_PROXY_BIN = bin
  process.env.CODAR_PROXY_RETRY_MS = "50"
  const { proxyFetch, closeProxy } = await import("../lib/native.mjs")
  try {
    const res = await proxyFetch("https://api.claw.speedai.com/v1/codar/models")
    const body = await res.text()
    if (res.status !== 200 || !body.includes("windows-ready-fixture")) {
      console.error(`the started proxy did not answer: status ${res.status} body ${body.slice(0, 120)}`)
      code = 1
    } else {
      console.log(`proxy start OK on ${process.platform} (${res.status})`)
      code = 0
    }
  } catch (e) {
    console.error(`the proxy did not start on ${process.platform}: ${e?.name} ${e?.message}`)
    code = 1
  } finally {
    await closeProxy()
  }
} finally {
  if (saved.bin === undefined) delete process.env.CODAR_PROXY_BIN
  else process.env.CODAR_PROXY_BIN = saved.bin
  if (saved.retry === undefined) delete process.env.CODAR_PROXY_RETRY_MS
  else process.env.CODAR_PROXY_RETRY_MS = saved.retry
  // Windows keeps a handle on a file its child is still closing: the fixture
  // was asked to stop a moment ago, so the directory can refuse to go for a
  // few hundred milliseconds. Retry, and never turn cleanup into the result.
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {}
}
if (code !== 0) {
  // A leftover fixture would keep holding a port; the plugin's own closeProxy
  // above asks it to stop, and this is the belt to that.
  try {
    spawnSync(process.execPath, ["-e", "process.exit(0)"], { timeout: 1000 })
  } catch {}
}
process.exit(code)
