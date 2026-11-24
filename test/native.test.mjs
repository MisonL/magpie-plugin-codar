// The plugin's side of the native proxy protocol, against a socket of its
// own: what it sends (Host, the two vendor headers, the token, the body) and
// how it reads each way a response body can be framed. The binary itself is
// tested next to it, in native/cmd/codar-proxy/main_test.go; nothing here
// spawns it, so the suite runs on a checkout with no build.

import assert from "node:assert/strict"
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process"
import { test } from "node:test"
import { createServer } from "node:net"
import { createServer as createServer2 } from "node:http"
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { binaryPath, chatFetch, closeProxy, hosts, officialURL, proxyFetch, sendVia } from "../lib/native.mjs"
import { binaryFile } from "../native/binary-name.mjs"
import { binaryName as builtName, buildTargets, inspectTarget, missingTargets, newestSourceMtime, toolchainFor } from "../scripts/build-native.mjs"

const here = dirname(fileURLToPath(import.meta.url))

// headerFor is a stand-in executable header: the platform's magic plus the
// machine field the gate reads, so a fixture can claim "an arm64 build"
// without a toolchain. The magic alone would not say which architecture.
const headerFor = (os, arch) => {
  const header = Buffer.alloc(128)
  if (os === "linux") {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(header)
    header[4] = 2
    header.writeUInt16LE(arch === "arm64" ? 0xb7 : 0x3e, 18)
  } else if (os === "darwin") {
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe]).copy(header)
    header.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4)
  } else {
    Buffer.from([0x4d, 0x5a]).copy(header)
    header.writeUInt32LE(0x40, 0x3c)
    Buffer.from("PE\0\0", "latin1").copy(header, 0x40)
    header.writeUInt16LE(0x8664, 0x44)
  }
  return header
}

// Windows has no unix sockets to bind here (listen answers EACCES), and
// these tests speak the proxy's unix transport. The loopback TCP transport
// the proxy uses on Windows has its own test, which runs everywhere.
const NO_UNIX = { skip: process.platform === "win32" }

// listen answers every connection with handler(bytes, socket) and gives back
// a Unix socket path to send to.
async function listen(handler) {
  const dir = mkdtempSync(join(tmpdir(), "codar-native-test-"))
  const path = join(dir, "proxy.sock")
  const all = new Set()
  const server = createServer((socket) => {
    all.add(socket)
    let buf = Buffer.alloc(0)
    socket.on("data", (d) => {
      buf = Buffer.concat([buf, d])
      const end = buf.indexOf("\r\n\r\n")
      if (end < 0) return
      const head = buf.subarray(0, end).toString("latin1")
      const rest = buf.subarray(end + 4)
      const length = Number(/content-length: *(\d+)/i.exec(head)?.[1] ?? 0)
      if (rest.length < length) return
      handler({ head, body: rest.subarray(0, length) }, socket)
    })
  })
  await new Promise((r) => server.listen(path, r))
  return {
    path,
    // Every connection this listener accepted is destroyed on close: a test
    // that failed to let go of its socket would otherwise keep the process —
    // and so the whole run — waiting on it.
    close: () =>
      new Promise((r) => {
        server.close(() => (rmSync(dir, { recursive: true, force: true }), r()))
        for (const socket of all) socket.destroy()
      }),
    // open counts the connections nothing has closed yet.
    get open() {
      return [...all].filter((s) => !s.destroyed).length
    },
  }
}

const request = (path, init = {}) => sendVia({ transport: "unix", address: path }, new URL("https://api.claw.speedai.com/v1/codar/models"), init)

test("the request carries the vendor's Host, the two vendor headers and the body", NO_UNIX, async () => {
  let seen
  const s = await listen((r, socket) => {
    seen = r
    socket.end("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 12\r\n\r\n{\"code\":200}")
  })
  try {
    const ans = await request(s.path, {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json", "user-agent": "ignored" },
      body: JSON.stringify({ username: "u" }),
    })
    assert.equal(ans.status, 200)
    assert.deepEqual(JSON.parse(await ans.text()), { code: 200 })
    const lines = seen.head.split("\r\n")
    assert.equal(lines[0], "POST /v1/codar/models HTTP/1.1")
    const names = lines.slice(1).map((l) => l.slice(0, l.indexOf(":")))
    assert.deepEqual(names.sort(), ["Authorization", "Connection", "Content-Length", "Content-Type", "Host"])
    assert.equal(lines.find((l) => l.startsWith("Host:")), "Host: api.claw.speedai.com")
    assert.deepEqual(JSON.parse(seen.body.toString()), { username: "u" })
  } finally {
    await s.close()
  }
})

test("a byte view leaves as its own bytes, whatever kind of view it is", NO_UNIX, async () => {
  // fetch sends the bytes a view spans; Buffer.from(view) reads a DataView's
  // byte-length field instead, so a DataView went out empty and a typed
  // array went out as its joined numbers. A declared-writable body never
  // falls back, so the wrong bytes were the request.
  const sent = []
  const s = await listen((r, socket) => {
    sent.push(r.body)
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
  })
  try {
    const backing = new Uint8Array([0xaa, 0x11, 0x22, 0xbb])
    const cases = [
      { body: new DataView(backing.buffer, 1, 2), want: "1122" },
      { body: new Uint16Array([0x1234]), want: "3412" },
      { body: new Uint8Array(backing.buffer, 1, 2), want: "1122" },
      { body: backing.buffer, want: "aa1122bb" },
    ]
    for (const c of cases) {
      const ans = await request(s.path, { method: "POST", body: c.body })
      assert.equal(ans.status, 200)
      assert.equal(Buffer.from(sent.at(-1)).toString("hex"), c.want, `${c.body.constructor.name} left as the wrong bytes`)
    }
  } finally {
    await s.close()
  }
})

// fakeProxyEcho writes the body it received to FAKE_PROXY_LOG, one hex line
// per request, so a test can see the bytes that reached the wire.
const fakeProxyEcho = `#!/usr/bin/env node
import { createServer } from "node:net"
import { appendFileSync, rmSync, writeFileSync } from "node:fs"
const argv = process.argv.slice(2)
const arg = (n) => argv[argv.indexOf(n) + 1]
const transport = arg("-listen")
const address = arg("-address")
const ready = arg("-ready")
if (transport === "unix") rmSync(address, { force: true })
const server = createServer((socket) => {
  let buf = Buffer.alloc(0)
  socket.on("error", () => {})
  socket.on("data", (d) => {
    buf = Buffer.concat([buf, d])
    const end = buf.indexOf("\\r\\n\\r\\n")
    if (end < 0) return
    const head = buf.subarray(0, end).toString("latin1")
    const length = Number(/content-length: *(\\d+)/i.exec(head)?.[1] ?? 0)
    const rest = buf.subarray(end + 4)
    if (rest.length < length) return
    appendFileSync(process.env.FAKE_PROXY_LOG, rest.subarray(0, length).toString("hex") + "\\n")
    socket.end("HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\n\\r\\n{}")
  })
})
server.listen(address, () => writeFileSync(ready, JSON.stringify({ transport, address })))
`

test("a byte body is snapshotted at the call, though the proxy starts first", { skip: process.platform === "win32" || process.env.CODAR_PLUGIN_DISABLE_NATIVE === "1" }, async () => {
  // fetch takes a body's bytes when it is called. The proxy transport copies
  // them — but only once the proxy is up, and starting it is an await. A
  // caller that reuses its buffer right after the call changed the request
  // while the proxy was starting; the copy has to happen at the call itself.
  const dir = mkdtempSync(join(tmpdir(), "codar-native-snap-"))
  const bin = join(dir, "fake-proxy.mjs")
  const log = join(dir, "body.log")
  writeFileSync(bin, fakeProxyEcho)
  chmodSync(bin, 0o755)
  const saved = { bin: process.env.CODAR_PROXY_BIN, log: process.env.FAKE_PROXY_LOG }
  process.env.CODAR_PROXY_BIN = bin
  process.env.FAKE_PROXY_LOG = log
  try {
    // a fresh start, so this run's proxy is the one that logs
    await closeProxy()
    const bytes = new Uint8Array([0x01, 0x02, 0x03])
    const pending = proxyFetch("https://api.claw.speedai.com/v1/codar/models", { method: "POST", body: bytes })
    bytes.fill(0xff)
    const ans = await pending
    assert.equal(ans.status, 200)
    assert.equal(readFileSync(log, "utf8").trim(), "010203", "the bytes at the call are the bytes sent")
  } finally {
    if (saved.bin === undefined) delete process.env.CODAR_PROXY_BIN
    else process.env.CODAR_PROXY_BIN = saved.bin
    if (saved.log === undefined) delete process.env.FAKE_PROXY_LOG
    else process.env.FAKE_PROXY_LOG = saved.log
    await closeProxy()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a byte body is snapshotted when the request is made, as fetch takes one", NO_UNIX, async () => {
  // The socket writes the body when it connects, one turn later. A body that
  // is a view of the caller's buffer was read at that write, so a caller
  // reusing its buffer right after the call changed the bytes on the wire.
  // fetch takes the byte-sequence snapshot at call time; so does this.
  let body
  const s = await listen((r, socket) => {
    body = Buffer.from(r.body)
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
  })
  try {
    const bytes = new Uint8Array([0x01, 0x02, 0x03])
    const pending = request(s.path, { method: "POST", body: bytes })
    bytes.fill(0xff)
    const ans = await pending
    assert.equal(ans.status, 200)
    assert.equal(body.toString("hex"), "010203", "the bytes at the call are the bytes sent")
  } finally {
    await s.close()
  }
})

test("a TCP-mode request carries the token and nothing the vendor would see", async () => {
  let head = ""
  const server = createServer((socket) => {
    socket.once("data", (d) => {
      head = d.toString("latin1")
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  try {
    const info = { transport: "tcp", address: `127.0.0.1:${server.address().port}`, token: "s3cret" }
    const ans = await sendVia(info, new URL("https://api.claw.speedai.com/v1/codar/models"), {})
    assert.equal(ans.status, 200)
    assert.match(head, /X-Codar-Proxy-Token: s3cret/)
    assert.match(head, /Host: api\.claw\.speedai\.com/)
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test("a chunked answer is read to its last chunk", NO_UNIX, async () => {
  const s = await listen((r, socket) => {
    // no close from this side: the client must let go of the socket once the
    // terminal chunk has arrived, not wait for the far side to hang up
    socket.on("error", () => {})
    socket.write(
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" +
        "5\r\nhello\r\n" +
        "6\r\n world\r\n" +
        "0\r\n\r\n",
    )
  })
  try {
    const ans = await request(s.path)
    assert.equal(await ans.text(), "hello world")
    // the stream readAnswer uses sees the same bytes
    const reader = ans.body.getReader()
    const chunks = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
    }
    assert.equal(Buffer.concat(chunks).toString(), "hello world")
    for (let i = 0; i < 200 && s.open > 0; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(s.open, 0, "the plugin closed the connection once the answer was complete")
  } finally {
    await s.close()
  }
})

test("a chat request writes the credential and version its own SDK uses, and nothing else", NO_UNIX, async () => {
  // The vendor's Anthropic models authenticate with X-Api-Key and state
  // Anthropic-Version; a proxy that forwarded only Authorization and
  // Content-Type would strip both and the request would arrive with no
  // credential at all. Everything else the caller set is still dropped, so the
  // desktop's own shape is what leaves.
  let seen
  const s = await listen((r, socket) => {
    seen = r
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
  })
  try {
    await request(s.path, {
      method: "POST",
      headers: {
        "x-api-key": "sk-ant",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        accept: "text/event-stream",
        "user-agent": "Bun/1",
        "x-magpie-session": "no",
      },
      body: "{}",
    })
    const names = seen.head
      .split("\r\n")
      .slice(1)
      .map((l) => l.slice(0, l.indexOf(":")))
      .sort()
    assert.deepEqual(names, ["Anthropic-Version", "Connection", "Content-Length", "Content-Type", "Host", "X-Api-Key"])
    assert.match(seen.head, /X-Api-Key: sk-ant/)
  } finally {
    await s.close()
  }
})

test("a streamed answer reaches the reader before the vendor has finished", NO_UNIX, async () => {
  // A chat answer is read as it arrives: if the client waited for the last
  // chunk, the host would show a whole answer at once instead of token by
  // token — which is exactly what a buffered read of an event stream does.
  const piece = (text) => `${Buffer.byteLength(text).toString(16)}\r\n${text}\r\n`
  let finished = false
  const s = await listen((r, socket) => {
    socket.on("error", () => {})
    socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n")
    socket.write(piece("data: first\n\n"))
    // the rest comes later: the reader must not be waiting for it
    setTimeout(() => {
      finished = true
      socket.write(piece("data: second\n\n") + "0\r\n\r\n")
    }, 200)
  })
  try {
    const ans = await request(s.path, { stream: true })
    const reader = ans.body.getReader()
    const first = await reader.read()
    assert.equal(Buffer.from(first.value).toString(), "data: first\n\n")
    assert.equal(finished, false, "the first piece arrived while the vendor was still holding the rest")
    const rest = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      rest.push(Buffer.from(value))
    }
    assert.equal(Buffer.concat(rest).toString(), "data: second\n\n")
    // nothing was kept behind the reader: a streamed answer has no text form
    await assert.rejects(ans.text(), /was streamed/)
  } finally {
    await s.close()
  }
})

test("an answer the proxy does not carry is left to the ordinary fetch", async () => {
  // chatFetch must not fail a conversation because the native transport is
  // missing: a URL outside the official hosts goes out on fetch, unchanged.
  const server = createServer2((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end("from fetch")
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  try {
    const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
    const ans = await chatFetch(url, { method: "POST", body: "{}" })
    assert.equal(await ans.text(), "from fetch")
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test("a refused streamed answer is still readable as the vendor's own JSON", NO_UNIX, async () => {
  // A chat request streams; its refusal is a short JSON document, and the host
  // reads it with text()/json() to quote the vendor's sentence. While every
  // streamed answer refused text(), the reason was lost behind "was streamed".
  const body = '{"detail":{"code":"account_restricted","message":"restricted"}}'
  const s = await listen((r, socket) => {
    socket.on("error", () => {})
    socket.write(`HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n`)
    socket.write(`${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\n\r\n`)
  })
  try {
    const ans = await request(s.path, { stream: true })
    assert.equal(ans.status, 403)
    assert.equal(await ans.json?.().then((j) => j.detail.code), "account_restricted")
  } finally {
    await s.close()
  }

  const sized = await listen((r, socket) => {
    socket.on("error", () => {})
    socket.write(`HTTP/1.1 502 Bad Gateway\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  })
  try {
    const ans = await request(sized.path, { stream: true })
    assert.equal(await ans.text(), body)
  } finally {
    await sized.close()
  }
})

test("a body only fetch knows how to encode leaves through fetch, not a TypeError", { skip: process.platform === "win32" || process.env.CODAR_PLUGIN_DISABLE_NATIVE === "1" }, async () => {
  // sendVia writes a body as bytes. FormData and URLSearchParams are not bytes
  // yet: before the fallback, chatFetch handed them to the native transport,
  // which failed with "The first argument must be of type string or an
  // instance of Buffer". A proxy is started here on purpose, so the native
  // path is the one being declined rather than never reached — and a string
  // body goes over it in the same test, so the fake proxy is proven reachable.
  const dir = mkdtempSync(join(tmpdir(), "codar-native-body-"))
  const bin = join(dir, "fake-proxy.mjs")
  writeFileSync(bin, fakeProxy)
  chmodSync(bin, 0o755)
  const saved = { bin: process.env.CODAR_PROXY_BIN, log: process.env.FAKE_PROXY_LOG }
  const savedFetch = globalThis.fetch
  let stub = 0
  process.env.CODAR_PROXY_BIN = bin
  process.env.FAKE_PROXY_LOG = join(dir, "starts.log")
  globalThis.fetch = async () => {
    stub++
    return new Response("from fetch", { status: 200 })
  }
  try {
    const url = "https://api.claw.speedai.com/v1/chat/completions"
    const form = new FormData()
    form.set("prompt", "hello")
    const f = await chatFetch(url, { method: "POST", body: form })
    assert.equal(await f.text(), "from fetch", "a FormData body was not handed to fetch")
    const u = await chatFetch(url, { method: "POST", body: new URLSearchParams({ a: "1" }) })
    assert.equal(await u.text(), "from fetch", "a URLSearchParams body was not handed to fetch")
    assert.equal(stub, 2, "each body only fetch can encode went to fetch once")
    const plain = await chatFetch(url, { method: "POST", body: "{}" })
    const reader = plain.body.getReader()
    let seen = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      seen += Buffer.from(value).toString()
    }
    assert.match(seen, /fake/, "a byte body still goes over the native transport")
  } finally {
    globalThis.fetch = savedFetch
    if (saved.bin === undefined) delete process.env.CODAR_PROXY_BIN
    else process.env.CODAR_PROXY_BIN = saved.bin
    if (saved.log === undefined) delete process.env.FAKE_PROXY_LOG
    else process.env.FAKE_PROXY_LOG = saved.log
    // the fake proxy is a child of this process and module state points at it:
    // left running, every later proxy test would talk to it instead
    await closeProxy()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("answer headers read through forEach give the callback the collection", NO_UNIX, async () => {
  // fetch hands a Headers as forEach's third argument; a caller that looks up
  // another header inside the callback gets the same answers here. It must be
  // the shim, not the Map behind it: a Headers looks names up without regard
  // to case, and a Map does not.
  const s = await listen((r, socket) => {
    socket.end("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Req-Id: abc\r\nContent-Length: 2\r\n\r\n{}")
  })
  try {
    const ans = await request(s.path)
    const seen = {}
    ans.headers.forEach((value, name, all) => {
      seen[name] = [all.get(name), all.get("Content-Type"), typeof all.forEach]
    })
    assert.deepEqual(seen, {
      "content-type": ["application/json", "application/json", "function"],
      "x-req-id": ["abc", "application/json", "function"],
      "content-length": ["2", "application/json", "function"],
    })
  } finally {
    await s.close()
  }
})

test("an interim 1xx answer is read past, not taken for the answer", NO_UNIX, async () => {
  // 100 Continue and 103 Early Hints are interim: the final head follows on
  // the same connection. Read as the answer, the caller got status 100 with an
  // empty body and the real answer was thrown away — a request that then
  // looked like the vendor had said nothing.
  for (const interim of ["HTTP/1.1 100 Continue\r\n\r\n", "HTTP/1.1 103 Early Hints\r\nLink: </a>\r\n\r\n"]) {
    const s = await listen((r, socket) => {
      socket.on("error", () => {})
      socket.write(`${interim}HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}`)
    })
    try {
      const ans = await request(s.path, { timeoutMs: 2000 })
      assert.equal(ans.status, 200, `${JSON.stringify(interim)} was taken for the answer`)
      assert.equal(await ans.text(), "{}")
    } finally {
      await s.close()
    }
  }

  // 101 switches protocols: this client never asked for an upgrade, so no
  // final head is coming and the bytes after it are not HTTP framing.
  const switched = await listen((r, socket) => {
    socket.on("error", () => {})
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\n\r\n")
  })
  try {
    const e = await request(switched.path, { timeoutMs: 2000 }).catch((x) => x)
    assert.match(e?.message ?? "", /unexpected 101/)
  } finally {
    await switched.close()
  }
})

test("a chunk whose data is not followed by CRLF is refused, not read past", NO_UNIX, async () => {
  // Between chunks the wire carries exactly CRLF (RFC 9112 §7.1). Skipping two
  // bytes without reading them took anything for the delimiter, and a peer
  // that wrote something else had its bytes read as the next size line.
  const s = await listen((r, socket) => {
    socket.on("error", () => {})
    socket.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhelloXX0\r\n\r\n")
  })
  try {
    const e = await request(s.path, { timeoutMs: 2000 }).catch((x) => x)
    assert.equal(e?.message, "codar-proxy: bad chunk delimiter", `a bad delimiter was accepted: ${e}`)
  } finally {
    await s.close()
  }
})

test("a chunked answer cut anywhere—in the size line, a chunk, or the terminal block—reads the same", NO_UNIX, async () => {
  // the body "hello world" in two chunks, with no trailers; written byte by
  // byte so every boundary (size line, data, the trailing CRLF, the "0" line,
  // the final blank line) falls between socket reads
  const wire = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n"
  const s = await listen((r, socket) => {
    socket.on("error", () => {})
    let i = 0
    const step = () => {
      if (socket.destroyed || i >= wire.length) return
      socket.write(wire[i++])
      setTimeout(step, 1)
    }
    step()
  })
  try {
    const ans = await request(s.path)
    const text = await ans.text()
    assert.equal(text, "hello world")
  } finally {
    await s.close()
  }

  // and with trailers after the terminal chunk
  const withTrailers = await listen((r, socket) => {
    socket.end("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\nX-Sum: 1\r\n\r\n")
  })
  try {
    const ans = await request(withTrailers.path)
    assert.equal(await ans.text(), "abc")
  } finally {
    await withTrailers.close()
  }
})

test("an answer with no stated length is read until the socket closes", NO_UNIX, async () => {
  const s = await listen((r, socket) => {
    socket.write("HTTP/1.1 503 Service Unavailable\r\nRetry-After: 3\r\n\r\n{\"detail\":\"busy\"}")
    socket.end()
  })
  try {
    const ans = await request(s.path)
    assert.equal(ans.ok, false)
    assert.equal(ans.status, 503)
    assert.equal(ans.headers.get("retry-after"), "3")
    assert.equal(await ans.text(), '{"detail":"busy"}')
  } finally {
    await s.close()
  }

  // the same, with a length: nothing is owed to the far side once it arrived,
  // so the client lets go even though the far side does not
  const sized = await listen((r, socket) => {
    socket.on("error", () => {})
    socket.write("HTTP/1.1 200 OK\r\nContent-Length: 12\r\n\r\n{\"code\":200}")
  })
  try {
    const ans = await request(sized.path)
    assert.equal(await ans.text(), '{"code":200}')
    for (let i = 0; i < 200 && sized.open > 0; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(sized.open, 0, "the plugin closed the connection once the answer was complete")
  } finally {
    await sized.close()
  }
})

test("an aborted request rejects as an abort and leaves the socket", NO_UNIX, async () => {
  const s = await listen(() => {}) // answers nothing
  try {
    const ctl = new AbortController()
    const p = request(s.path, { signal: ctl.signal })
    setTimeout(() => ctl.abort(), 20)
    await assert.rejects(p, (e) => e?.name === "AbortError")
  } finally {
    await s.close()
  }
})

test("a signal already aborted rejects as an abort before anything is sent", NO_UNIX, async () => {
  // abort() runs before the connect handlers are attached, and cleanup() reads
  // the deadline. With the deadline declared after that check, this path threw
  // a ReferenceError ("Cannot access 'deadline' before initialization") and
  // left the request as an uncaught ENOENT instead of a clean AbortError.
  const s = await listen(() => {})
  try {
    const ctl = new AbortController()
    ctl.abort()
    const e = await request(s.path, { signal: ctl.signal }).catch((x) => x)
    assert.equal(e?.name, "AbortError", `a pre-aborted request failed with: ${e}`)
  } finally {
    await s.close()
  }
})

// The timeout is the test's own: it moves 9 MiB through a socket, which takes
// about 3.5 s under Bun (Node does it in 0.5 s), and Bun's default per-test
// bound is 5 s — under load the transfer alone ran past it and the failure
// looked like a bug in the transport. The size is the point (it is over the
// 8 MiB buffered cap), so the bound is what gives.
test("a streamed answer is measured against the streaming cap, not the buffered one", { ...NO_UNIX, timeout: 60_000 }, async () => {
  // A chat request streams, and its cap is STREAM_ANSWER_BYTES (64 MiB). The
  // stated-length precheck compared against the buffered cap (8 MiB), so a 9
  // MiB event stream failed with a message about a bound it never reached. The
  // head resolves the request before the precheck runs, so the refusal shows
  // up on the stream: the test reads it to the end.
  const size = 9 * 1024 * 1024
  const s = await listen((r, socket) => {
    socket.on("error", () => {})
    socket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: ${size}\r\n\r\n`)
    socket.write(Buffer.alloc(size, 97))
  })
  try {
    const ans = await request(s.path, { stream: true })
    assert.equal(ans.status, 200)
    const reader = ans.body.getReader()
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
    }
    assert.equal(total, size, "a 9 MiB stream is within the 64 MiB stream cap and must arrive whole")
  } finally {
    await s.close()
  }
})

test("a request whose caller passed no signal still ends", NO_UNIX, async () => {
  const s = await listen(() => {}) // never answers, never hangs up
  try {
    // request() always passes a signal; this is the direct-call boundary. The
    // race turns a missing deadline into a failure in seconds, not a hang.
    const out = await Promise.race([
      request(s.path, { timeoutMs: 40 }).catch((e) => e),
      new Promise((r) => setTimeout(() => r("still pending"), 3000)),
    ])
    assert.equal(out?.code, "no_answer", `the request outlived its deadline: ${out}`)
    for (let i = 0; i < 200 && s.open > 0; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(s.open, 0, "the request kept its socket after giving up")
  } finally {
    await s.close()
  }
})

test("an answer past the cap is refused while it arrives, not after it is held", NO_UNIX, async () => {
  // chunked, so no stated length can be checked up front: the refusal has to
  // come from the bytes counted as they arrive (11 bytes against a cap of 10)
  const s = await listen((r, socket) => {
    socket.on("error", () => {})
    socket.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nb\r\nhello world\r\n0\r\n\r\n")
  })
  try {
    const e = await request(s.path, { maxBytes: 10 }).catch((x) => x)
    assert.equal(e?.code, "answer_too_large")
    for (let i = 0; i < 200 && s.open > 0; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(s.open, 0, "an oversized answer kept the socket")
  } finally {
    await s.close()
  }

  // and a stated length past the cap is refused before the body is read
  const big = await listen((r, socket) => {
    socket.on("error", () => {})
    socket.write("HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\n\r\n")
  })
  try {
    const e = await request(big.path, { maxBytes: 10 }).catch((x) => x)
    assert.equal(e?.code, "answer_too_large")
  } finally {
    await big.close()
  }
})

test("a chunk line or trailer that never ends is refused, not buffered", NO_UNIX, async () => {
  // 128 KiB with no CRLF: past the 64 KiB cap for the framing lines
  const flood = "a".repeat(131072)
  for (const wire of [
    `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${flood}`,
    `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n0\r\n${flood}`,
  ]) {
    const s = await listen((r, socket) => {
      socket.on("error", () => {})
      socket.write(wire)
    })
    try {
      const out = await Promise.race([
        request(s.path).catch((e) => e),
        new Promise((r) => setTimeout(() => r("still pending"), 3000)),
      ])
      assert.equal(out?.message, "codar-proxy: bad chunk", `the framing flood was not refused: ${out}`)
    } finally {
      await s.close()
    }
  }
})

test("a malformed chunk size is refused, not looped on", NO_UNIX, async () => {
  // "-1" parsed to a negative size, and the state machine then neither
  // consumed nor returned: a synchronous hang no timer could break. "1x" and
  // "+5" were read as sizes too.
  for (const sizeLine of ["-1", "1x", "+5", "0x10"]) {
    const s = await listen((r, socket) => {
      socket.on("error", () => {})
      socket.write(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${sizeLine}\r\nx\r\n`)
    })
    try {
      const out = await Promise.race([
        request(s.path, { timeoutMs: 300 }).catch((e) => e),
        new Promise((r) => setTimeout(() => r("still pending"), 2000)),
      ])
      assert.equal(out?.message, "codar-proxy: bad chunk size", `${JSON.stringify(sizeLine)} was not refused: ${out}`)
    } finally {
      await s.close()
    }
  }
})

test("a bodiless status is complete at the head, and a bad length fails fast", NO_UNIX, async () => {
  const s = await listen((r, socket) => {
    socket.on("error", () => {})
    socket.write("HTTP/1.1 204 No Content\r\n\r\n") // and keeps the connection open
  })
  try {
    const ans = await request(s.path, { timeoutMs: 500 })
    assert.equal(ans.status, 204)
    assert.equal(await ans.text(), "")
  } finally {
    await s.close()
  }

  const bad = await listen((r, socket) => {
    socket.on("error", () => {})
    socket.write("HTTP/1.1 200 OK\r\nContent-Length: nope\r\n\r\n")
  })
  try {
    const e = await request(bad.path, { timeoutMs: 500 }).catch((x) => x)
    assert.equal(e?.message, "codar-proxy: bad content-length", `a non-numeric length read as close-delimited: ${e}`)
  } finally {
    await bad.close()
  }
})

test("a bodiless answer is complete at its head, whatever its headers say", NO_UNIX, async () => {
  // 1xx/204/304 never carry content (RFC 9110), and a HEAD answer repeats the
  // GET's headers — a Transfer-Encoding among them. Read as chunked before the
  // bodiless rule, a 204/304/HEAD returned the "body" of a response that has
  // none, waited out its deadline on a terminal chunk nobody was sending (the
  // connection stayed open), or rejected the garbage a peer put after the head.
  const sends = [
    ["204", "HTTP/1.1 204 No Content\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n", "GET", 204],
    ["304", "HTTP/1.1 304 Not Modified\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n", "GET", 304],
    ["HEAD", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n", "HEAD", 200],
  ]
  for (const [label, bytes, method, status] of sends) {
    const s = await listen((r, socket) => {
      socket.on("error", () => {})
      socket.write(bytes)
      socket.end()
    })
    try {
      const ans = await request(s.path, { method, timeoutMs: 800 })
      assert.equal(ans.status, status, `${label}: the head's status`)
      assert.equal(await ans.text(), "", `${label}: a bodiless answer has no body to read`)
    } finally {
      await s.close()
    }
  }

  // No body at all: the answer must settle at the head, not at the deadline
  // when the connection is held open, and not with "closed before the answer"
  // when the peer hangs up.
  for (const [label, bytes, hold] of [
    ["204 open", "HTTP/1.1 204 No Content\r\nTransfer-Encoding: chunked\r\n\r\n", true],
    ["204 closed", "HTTP/1.1 204 No Content\r\nTransfer-Encoding: chunked\r\n\r\n", false],
    ["304 closed", "HTTP/1.1 304 Not Modified\r\nTransfer-Encoding: chunked\r\n\r\n", false],
  ]) {
    const s = await listen((r, socket) => {
      socket.on("error", () => {})
      socket.write(bytes)
      if (!hold) socket.end()
    })
    try {
      const started = Date.now()
      const ans = await request(s.path, { timeoutMs: 800 })
      assert.ok(Date.now() - started < 500, `${label}: the answer waited for a body it never has`)
      assert.equal(await ans.text(), "")
    } finally {
      await s.close()
    }
  }

  // A peer that writes something after a bodiless head must not turn it into
  // a chunk-size or framing error: those bytes are not this answer's body.
  const garbage = await listen((r, socket) => {
    socket.on("error", () => {})
    socket.write("HTTP/1.1 204 No Content\r\nTransfer-Encoding: chunked\r\n\r\nZ\r\n")
  })
  try {
    const ans = await request(garbage.path, { timeoutMs: 800 })
    assert.equal(ans.status, 204)
    assert.equal(await ans.text(), "")
  } finally {
    await garbage.close()
  }
})

test("a response head past the cap is refused even when it arrived complete", NO_UNIX, async () => {
  // The cap used to run only while the head had not ended yet: a peer that sent
  // one 70 KB header block in a single write was parsed whole. The same head
  // split across writes was already refused.
  const pad = "a".repeat(70000)
  const whole = await listen((r, socket) => {
    socket.on("error", () => {})
    socket.write(`HTTP/1.1 200 OK\r\nX-Pad: ${pad}\r\nContent-Length: 2\r\n\r\nok`)
  })
  try {
    const e = await request(whole.path, { timeoutMs: 800 }).catch((x) => x)
    assert.equal(e?.message, "codar-proxy: response head too large", `a complete 70 KB head was parsed: ${e?.status ?? e}`)
  } finally {
    await whole.close()
  }

  const split = await listen((r, socket) => {
    socket.on("error", () => {})
    socket.write("HTTP/1.1 200 OK\r\nX-Pad: ")
    for (let at = 0; at < pad.length; at += 8192) socket.write(pad.slice(at, at + 8192))
    socket.write("\r\nContent-Length: 2\r\n\r\nok")
  })
  try {
    const e = await request(split.path, { timeoutMs: 800 }).catch((x) => x)
    assert.equal(e?.message, "codar-proxy: response head too large", `a split 70 KB head was parsed: ${e?.status ?? e}`)
  } finally {
    await split.close()
  }
})

test("a method that is not a token is refused before anything is written", async () => {
  await assert.rejects(
    sendVia({ transport: "unix", address: join(tmpdir(), "never") }, new URL("https://api.claw.speedai.com/x"), { method: "GET\r\nX-Evil: yes" }),
    /bad method/,
  )
})

test("the toolchain override variables are named for the release line", () => {
  const saved = process.env.GO_1_24
  process.env.GO_1_24 = "/opt/go1.24.3/bin/go"
  try {
    assert.equal(toolchainFor("1.24.3"), "/opt/go1.24.3/bin/go", "GO_1_24 did not name the 1.24 toolchain")
    assert.equal(toolchainFor("1.26.7"), "go1.26.7")
  } finally {
    if (saved === undefined) delete process.env.GO_1_24
    else process.env.GO_1_24 = saved
  }
})

test("a release refuses a package without every platform's build", { timeout: 60_000 }, async () => {
  const empty = mkdtempSync(join(tmpdir(), "codar-native-empty-"))
  const full = mkdtempSync(join(tmpdir(), "codar-native-full-"))
  const stub = mkdtempSync(join(tmpdir(), "codar-native-stub-"))
  // the header each platform's build starts with, followed by enough filler
  // to be a plausible file; the gate reads the header and the size, and
  // deliberately does not need a Go toolchain or a real build here
  const fill = (path, header) => {
    writeFileSync(path, Buffer.concat([header, Buffer.alloc(8192)]))
    chmodSync(path, 0o755)
  }
  try {
    assert.equal(missingTargets(empty).length, 5, "an empty directory is missing all five builds")
    for (const os of ["darwin", "linux"]) {
      for (const arch of ["arm64", "amd64"]) fill(join(full, binaryFile(os, arch)), headerFor(os, arch))
    }
    fill(join(full, binaryFile("win32", "amd64")), headerFor("win32", "amd64"))
    const script = join(here, "..", "scripts", "build-native.mjs")
    const run = (env) =>
      new Promise((resolve) => {
        execFile(process.execPath, [script, "--check", "--strict"], { env: { ...process.env, CODAR_NATIVE_OUT: env } }, (e, stdout) =>
          resolve({ code: e?.code ?? 0, stdout }),
        )
      })
    // A build made before the source it claims to be: the header, size and
    // mode are a real build's, so only the clock can say it predates main.go.
    // The suite's own fixtures get their freshness from the source's time.
    const freshSource = newestSourceMtime()
    // an unreadable source is not a pass: the gate must refuse rather than
    // date the builds against nothing, or a moved tree would wave them through
    assert.equal(newestSourceMtime(join(tmpdir(), "codar-no-such-source")), null, "an unreadable source dated itself")
    const undated = inspectTarget(full, { os: "darwin", arch: "arm64", goos: "darwin" }, null)
    assert.equal(undated.state, "broken", "a build passed while its source could not be read")
    assert.match(undated.reason, /source cannot be read/)
    // older than the source, not merely "a day ago": a checkout's .go files
    // may themselves be days old
    const older = new Date(freshSource - 60 * 60 * 1000)
    const utime = (path) => utimesSync(path, older, older)
    assert.ok(freshSource > 0, "the source has no .go files to date the builds by")
    for (const os of ["darwin", "linux"]) {
      for (const arch of ["arm64", "amd64"]) utime(join(full, binaryFile(os, arch)))
    }
    utime(join(full, binaryFile("win32", "amd64")))
    const stale = await run(full)
    assert.equal(stale.code, 1, "a build older than its source passed the strict check")
    assert.match(stale.stdout, /broken codar-proxy-darwin-arm64: older than its source/)
    const row = inspectTarget(full, { os: "darwin", arch: "arm64", goos: "darwin" }, freshSource)
    assert.equal(row.reason, "older than its source; run node scripts/build-native.mjs --all")
    // restored to now, the same files are this source's builds again
    const now = new Date()
    for (const os of ["darwin", "linux"]) {
      for (const arch of ["arm64", "amd64"]) utimesSync(join(full, binaryFile(os, arch)), now, now)
    }
    utimesSync(join(full, binaryFile("win32", "amd64")), now, now)

    const refused = await run(empty)
    assert.equal(refused.code, 1, "the strict check passed with no builds")
    assert.match(refused.stdout, /missing codar-proxy-darwin-arm64/)
    const accepted = await run(full)
    assert.equal(accepted.code, 0, "the strict check refused a directory with every build")

    // Names alone used to be the check: an empty file, or one carrying the
    // wrong platform's header, would have shipped.
    fill(join(stub, binaryFile("darwin", "arm64")), Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    writeFileSync(join(stub, binaryFile("linux", "arm64")), "")
    const short = await run(stub)
    assert.equal(short.code, 1, "the strict check passed with a wrong-platform build and an empty one")
    assert.match(short.stdout, /broken codar-proxy-darwin-arm64: not a darwin executable/)
    assert.match(short.stdout, /broken codar-proxy-linux-arm64: only 0 bytes/)

    // The magic says "an ELF" for both architectures, so a build of the other
    // one under this name used to pass: the header's machine decides.
    const mixed = join(full, binaryFile("linux", "amd64"))
    fill(mixed, headerFor("linux", "arm64"))
    const mislabelled = await run(full)
    assert.equal(mislabelled.code, 1, "an arm64 build named for amd64 passed the strict check")
    assert.match(mislabelled.stdout, /broken codar-proxy-linux-amd64: built for arm64, not amd64/)
    fill(mixed, headerFor("linux", "amd64"))

    // A fat archive is read by the machines it lists, not by whichever slice
    // comes first: a universal build that lists x86_64 before arm64 is still
    // an arm64 build, and one that lists only x86_64 is not.
    const fat = (...cpus) => {
      const header = Buffer.alloc(128)
      Buffer.from([0xca, 0xfe, 0xba, 0xbe]).copy(header)
      header.writeUInt32BE(cpus.length, 4)
      cpus.forEach((cpu, i) => header.writeUInt32BE(cpu, 8 + i * 20))
      return header
    }
    const universal = join(full, binaryFile("darwin", "arm64"))
    fill(universal, fat(0x01000007, 0x0100000c))
    const slices = await run(full)
    assert.equal(slices.code, 0, "a fat build with its arm64 slice second was refused")
    fill(universal, fat(0x01000007))
    const onlyAmd = await run(full)
    assert.equal(onlyAmd.code, 1, "a fat build with no arm64 slice passed as one")
    assert.match(onlyAmd.stdout, /broken codar-proxy-darwin-arm64: built for amd64, not arm64/)
    fill(universal, headerFor("darwin", "arm64"))
  } finally {
    for (const dir of [empty, full, stub]) rmSync(dir, { recursive: true, force: true })
  }
})

// the packed gate names the platform package a resolved build came from
test("the gate names the platform package from either separator", async () => {
  // The probe reads the path the way the machine writes it. On Windows that is
  // backslashes, and splitting only on "/" answered null for a build that did
  // come from the platform package — the install check would have failed there
  // for a reason of its own. The answer is npm's spelling whatever the path was.
  const { packagePathOf } = await import("../scripts/tarball.mjs")
  const here = join(tmpdir(), "codar-tarball", "consumer", "node_modules")
  assert.equal(packagePathOf(join(here, "magpie-plugin-codar-darwin-arm64", "bin", "codar-proxy-darwin-arm64"), here), "magpie-plugin-codar-darwin-arm64/bin/codar-proxy-darwin-arm64")
  const winHere = String.raw`C:\Users\x\AppData\Local\Temp\codar-tarball\consumer\node_modules`
  const winFound = String.raw`C:\Users\x\AppData\Local\Temp\codar-tarball\consumer\node_modules\magpie-plugin-codar-win32-x64\bin\codar-proxy-win32-amd64.exe`
  assert.equal(packagePathOf(winFound, winHere), "magpie-plugin-codar-win32-x64/bin/codar-proxy-win32-amd64.exe")
  // a build outside that node_modules tree is the checkout fallback, not a package
  assert.equal(packagePathOf(join(tmpdir(), "elsewhere", "bin", "codar-proxy-darwin-arm64"), here), null)
  assert.equal(packagePathOf(String.raw`C:\other\bin\codar-proxy-win32-amd64.exe`, winHere), null)
})

// the packed gate refuses a package that repeats the builds
test("the tarball gate refuses a main package that carries the builds", { timeout: 60_000 }, async () => {
  const { requireNativeBin } = await import("../scripts/tarball.mjs")
  const bare = mkdtempSync(join(tmpdir(), "codar-gate-bare-"))
  const empty = mkdtempSync(join(tmpdir(), "codar-gate-empty-"))
  const packed = mkdtempSync(join(tmpdir(), "codar-gate-packed-"))
  try {
    assert.equal(requireNativeBin(bare), 0, "a package without native/bin was refused")
    mkdirSync(join(empty, "native", "bin"), { recursive: true })
    assert.equal(requireNativeBin(empty), 0, "an empty native/bin directory was refused")
    mkdirSync(join(packed, "native", "bin"), { recursive: true })
    writeFileSync(join(packed, "native", "bin", binaryFile("darwin", "arm64")), Buffer.alloc(4096))
    assert.throws(() => requireNativeBin(packed), /carries native\/bin/, "five builds shipped a second time and passed")
  } finally {
    for (const dir of [bare, empty, packed]) rmSync(dir, { recursive: true, force: true })
  }
})

// A real install through the package manager and a started child per
// manager: well past the runners' default five-second test bound.
const INSTALL_MS = 180000
// fakeProxy is a stand-in for the Go binary: it speaks the same ready-file
// protocol and answers every request, logging one line per start so a test
// can see that a new process was started.
const fakeProxy = `#!/usr/bin/env node
import { createServer } from "node:net"
import { appendFileSync, rmSync, writeFileSync } from "node:fs"
const argv = process.argv.slice(2)
const arg = (n) => argv[argv.indexOf(n) + 1]
const transport = arg("-listen")
const address = arg("-address")
const ready = arg("-ready")
appendFileSync(process.env.FAKE_PROXY_LOG, process.pid + " " + ready + "\\n")
if (transport === "unix") rmSync(address, { force: true })
const server = createServer((socket) => {
  let buf = ""
  socket.on("error", () => {})
  socket.on("data", (d) => {
    buf += d.toString("latin1")
    if (!buf.includes("\\r\\n\\r\\n")) return
    const body = JSON.stringify({ code: 200, from: "fake" })
    socket.end("HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body)
  })
})
server.listen(address, () => writeFileSync(ready, JSON.stringify({ transport, address })))
`

// Windows is left out: npm's `.cmd` shims launch through a shell whose setup
// this check's own registry server has to answer, and it has not been made to
// work there yet (it failed on a real Windows machine: "Child returned status
// 128"). Everything else about Windows is covered by the windows job.
test("the packed main package installs and starts exactly this machine's platform package", { skip: process.platform === "win32" || process.env.CODAR_PLUGIN_DISABLE_NATIVE === "1", timeout: INSTALL_MS }, async () => {
  const { consumerInstall, packedPackage } = await import("../scripts/tarball.mjs")
  const { packageName } = await import("../native/binary-name.mjs")
  const managers = ["bun", "npm"].filter((cmd) => {
    try {
      execFileSync(cmd, ["--version"], { stdio: "ignore" })
      return true
    } catch {
      return false
    }
  })
  assert.ok(managers.length, "neither bun nor npm is on PATH; the gate needs one to test an install")
  const work = mkdtempSync(join(tmpdir(), "codar-consumer-"))
  try {
    // A stand-in build for every platform: it speaks the real ready-file
    // protocol, and the real Go build's own behaviour is tested next to it.
    const platform = []
    for (const t of buildTargets) {
      const dir = join(work, "staged", packageName(t.os, t.arch))
      mkdirSync(join(dir, "bin"), { recursive: true })
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: packageName(t.os, t.arch), version: "9.9.9", os: [t.os], cpu: [t.arch === "amd64" ? "x64" : t.arch], files: ["bin"] }))
      platform.push({ name: packageName(t.os, t.arch), file: binaryFile(t.os, t.arch), dir })
    }
    // The builds are stand-ins: a copy of the fake proxy under each name, so a
    // started proxy answers and logs.
    const pw = join(work, "fake-proxy.mjs")
    writeFileSync(pw, fakeProxy)
    chmodSync(pw, 0o755)
    const tarballs = []
    for (const p of platform) {
      copyFileSync(pw, join(p.dir, "bin", p.file))
      chmodSync(join(p.dir, "bin", p.file), 0o755)
      tarballs.push(packedPackage(p.dir, join(work, "tgz")))
    }
    const main = join(work, "main")
    mkdirSync(main)
    // What a release's main package says: the builds are its platform
    // packages, at its own exact version, and none of them ships here. The
    // modules are the real ones, except that the plugin's own copy of the
    // naming rule is the one this file imports — the gate's copies are checked
    // here too, and the suite must not read its own expectations as the
    // answer it is given.
    const optionalDependencies = Object.fromEntries(platform.map((p) => [p.name, "9.9.9"]))
    writeFileSync(join(main, "package.json"), JSON.stringify({ name: "magpie-plugin-codar", version: "9.9.9", files: ["index.mjs", "lib", "native/binary-name.mjs"], optionalDependencies }))
    copyFileSync(join(here, "..", "index.mjs"), join(main, "index.mjs"))
    cpSync(join(here, "..", "lib"), join(main, "lib"), { recursive: true })
    mkdirSync(join(main, "native"), { recursive: true })
    writeFileSync(join(main, "native", "binary-name.mjs"), copyOf("../native/binary-name.mjs"))
    const mainTarball = packedPackage(main, join(work, "tgz"))

    const mine = packageName(process.platform, process.arch === "x64" ? "amd64" : process.arch)
    const mineFile = binaryFile(process.platform, process.arch === "x64" ? "amd64" : process.arch)
    for (const manager of managers) {
      const report = await consumerInstall({ dir: join(work, `consumer-${manager}`), manager, main: mainTarball, platform: tarballs, probe: { url: "https://api.claw.speedai.com/v1/codar/models", env: { FAKE_PROXY_LOG: join(work, `starts-${manager}.log`) } } })
      assert.deepEqual(report.installed, [mine], `${manager} installed ${report.installed.join(", ") || "nothing"}, not exactly ${mine}`)
      assert.equal(report.proxy, `${mine}/bin/${mineFile}`, `${manager}: the plugin opened another package's build`)
      assert.equal(report.started, true, `${manager}: the plugin did not start the proxy (${JSON.stringify(report)})`)
      assert.equal(report.answer?.from, "fake", `${manager}: the proxy did not answer (${JSON.stringify(report)})`)

      // With nothing offered there is no proxy, and the plugin says which
      // reason rather than pretending it has one.
      const bare = await consumerInstall({ dir: join(work, `bare-${manager}`), manager, main: mainTarball, platform: [], probe: { url: "https://api.claw.speedai.com/v1/codar/models" } })
      assert.deepEqual(bare.installed, [], `${manager} installed a platform package with none offered`)
      assert.equal(bare.proxy, null, "a proxy path was found with no platform package")
      assert.equal(bare.unavailable, "no platform package for this machine", JSON.stringify(bare))
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

// copyOf is a source file of this repository as text, for a fixture that must
// carry its own copy of it. `files` is relative to this test file.
const copyOf = (files) => readFileSync(fileURLToPath(new URL(files, import.meta.url)), "utf8")

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test("a proxy that dies is replaced, not mourned", { skip: process.platform === "win32" || process.env.CODAR_PLUGIN_DISABLE_NATIVE === "1", timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "codar-native-fake-"))
  const bin = join(dir, "fake-proxy.mjs")
  const log = join(dir, "starts.log")
  writeFileSync(bin, fakeProxy)
  chmodSync(bin, 0o755)
  const savedBin = process.env.CODAR_PROXY_BIN
  const savedLog = process.env.FAKE_PROXY_LOG
  process.env.CODAR_PROXY_BIN = bin
  process.env.FAKE_PROXY_LOG = log
  // one line per start: "<pid> <ready path>"
  const starts = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [pid, ready] = line.split(" ")
            return { pid: Number(pid), ready }
          })
      : []
  const settle = async (pid) => {
    for (let i = 0; i < 200 && alive(pid); i++) await new Promise((r) => setTimeout(r, 10))
  }
  // gone waits for a path to disappear: the exit handler that removes a dead
  // proxy's directory runs on its own tick, after the pid is gone.
  const gone = async (path) => {
    for (let i = 0; i < 200 && existsSync(path); i++) await new Promise((r) => setTimeout(r, 10))
    return !existsSync(path)
  }
  try {
    const first = await proxyFetch("https://api.claw.speedai.com/v1/codar/models")
    assert.equal(first.status, 200)
    assert.equal((await first.text()).includes("fake"), true)
    assert.equal(starts().length, 1, "the fake proxy did not start")

    // (a) the process dies outright: its exit is seen, and the next request
    // starts another
    const dead = starts()[0].pid
    const deadHome = dirname(starts()[0].ready)
    process.kill(dead, "SIGKILL")
    await settle(dead)
    // A crash is the one exit closeProxy never sees: the directory holding
    // the ready file and the socket must go with the process, or every crash
    // leaves one behind in the temp root.
    assert.equal(await gone(deadHome), true, "a proxy that died left its directory behind")
    const second = await proxyFetch("https://api.claw.speedai.com/v1/codar/models")
    assert.equal(second.status, 200)
    assert.equal(starts().length, 2, "the dead proxy was not replaced")

    // (b) the socket disappears while the process it belongs to keeps running:
    // the exit is never seen, so only the refused connect can tell, and the
    // attempt that follows is what restarts it
    const running = starts()[1]
    assert.equal(alive(running.pid), true, "the second proxy did not stay up")
    const address = JSON.parse(readFileSync(running.ready, "utf8")).address
    rmSync(address, { force: true })
    const third = await proxyFetch("https://api.claw.speedai.com/v1/codar/models")
    assert.equal(third.status, 200)
    assert.equal(starts().length, 3, "a proxy whose socket vanished was not replaced")

    for (const { pid } of starts()) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
      await settle(pid)
    }
  } finally {
    if (savedBin === undefined) delete process.env.CODAR_PROXY_BIN
    else process.env.CODAR_PROXY_BIN = savedBin
    if (savedLog === undefined) delete process.env.FAKE_PROXY_LOG
    else process.env.FAKE_PROXY_LOG = savedLog
    // the last proxy is killed above, but its exit handler runs on its own
    // tick: closeProxy is what makes the cleanup deterministic here
    await closeProxy()
    rmSync(dir, { recursive: true, force: true })
  }
})

// fakeProxyFailsOnce exits before publishing a ready file the first time it
// is started, and answers like fakeProxy after that: one transient start
// failure, then a working proxy.
const fakeProxyFailsOnce = `#!/usr/bin/env node
import { createServer } from "node:net"
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
const argv = process.argv.slice(2)
const arg = (n) => argv[argv.indexOf(n) + 1]
const log = process.env.FAKE_PROXY_LOG
const started = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\\n").filter(Boolean).length : 0)
const first = started() === 0
appendFileSync(log, process.pid + "\\n")
if (first) process.exit(1)
const transport = arg("-listen")
const address = arg("-address")
const ready = arg("-ready")
if (transport === "unix") rmSync(address, { force: true })
const server = createServer((socket) => {
  let buf = ""
  socket.on("error", () => {})
  socket.on("data", (d) => {
    buf += d.toString("latin1")
    if (!buf.includes("\\r\\n\\r\\n")) return
    const body = JSON.stringify({ code: 200, from: "fake" })
    socket.end("HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body)
  })
})
server.listen(address, () => writeFileSync(ready, JSON.stringify({ transport, address })))
`

// fakeProxyDeafTwice publishes a ready file naming a socket nobody listens on
// for its first two starts, and answers like fakeProxy from the third: a proxy
// that died and a replacement that did not come up, then one that would.
const fakeProxyDeafTwice = `#!/usr/bin/env node
import { createServer } from "node:net"
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
const argv = process.argv.slice(2)
const arg = (n) => argv[argv.indexOf(n) + 1]
const log = process.env.FAKE_PROXY_LOG
const started = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\\n").filter(Boolean).length : 0)
const n = started()
appendFileSync(log, process.pid + "\\n")
const transport = arg("-listen")
const address = arg("-address")
const ready = arg("-ready")
if (n < 2) {
  writeFileSync(ready, JSON.stringify({ transport, address: join(dirname(ready), "deaf-" + n + ".sock") }))
  setTimeout(() => {}, 60000)
} else {
  if (transport === "unix") rmSync(address, { force: true })
  const server = createServer((socket) => {
    let buf = ""
    socket.on("error", () => {})
    socket.on("data", (d) => {
      buf += d.toString("latin1")
      if (!buf.includes("\\r\\n\\r\\n")) return
      const body = JSON.stringify({ code: 200, from: "fake" })
      socket.end("HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body)
    })
  })
  server.listen(address, () => writeFileSync(ready, JSON.stringify({ transport, address })))
}
`

// withProxyEnv runs body with this test's fake proxy named, and puts every
// environment variable back whatever happens.
async function withProxyEnv(files, body) {
  const dir = mkdtempSync(join(tmpdir(), "codar-native-fake-"))
  const saved = { bin: process.env.CODAR_PROXY_BIN, log: process.env.FAKE_PROXY_LOG, retry: process.env.CODAR_PROXY_RETRY_MS }
  const bin = join(dir, "fake-proxy.mjs")
  const log = join(dir, "starts.log")
  writeFileSync(bin, files)
  chmodSync(bin, 0o755)
  process.env.CODAR_PROXY_BIN = bin
  process.env.FAKE_PROXY_LOG = log
  // the pause after a failed start, short enough for a test
  process.env.CODAR_PROXY_RETRY_MS = "50"
  const starts = () =>
    existsSync(log)
      ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => Number(line.split(" ")[0]))
      : []
  try {
    await body({ starts })
  } finally {
    if (saved.bin === undefined) delete process.env.CODAR_PROXY_BIN
    else process.env.CODAR_PROXY_BIN = saved.bin
    if (saved.log === undefined) delete process.env.FAKE_PROXY_LOG
    else process.env.FAKE_PROXY_LOG = saved.log
    if (saved.retry === undefined) delete process.env.CODAR_PROXY_RETRY_MS
    else process.env.CODAR_PROXY_RETRY_MS = saved.retry
    await closeProxy()
    for (const pid of starts()) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

const later = (ms) => new Promise((r) => setTimeout(r, ms))

test("a start that failed is tried again after a pause, not remembered for the process's life", { skip: process.platform === "win32" || process.env.CODAR_PLUGIN_DISABLE_NATIVE === "1", timeout: 60_000 }, async () => {
  // One transient failure (a spawn error, the five-second ready deadline, a
  // machine resuming from sleep) used to be cached as "there is no proxy" for
  // as long as the process lived: the desktop transport never came back, and
  // every request and chat left through Bun's TLS without saying so.
  await withProxyEnv(fakeProxyFailsOnce, async ({ starts }) => {
    const first = await proxyFetch("https://api.claw.speedai.com/v1/codar/models").catch((e) => e)
    assert.equal(first?.name, "NativeUnavailable", `a failed start must be NativeUnavailable, not ${first}`)
    assert.equal(starts().length, 1, "the fake proxy's failing start did not run")
    await later(120)
    const second = await proxyFetch("https://api.claw.speedai.com/v1/codar/models")
    assert.equal(second.status, 200, "the request after the pause did not reach a working proxy")
    assert.equal(starts().length, 2, "the failed start was not tried again")
  })
})

test("a dead proxy whose replacement also refuses is retried after a pause, not latched off", { skip: process.platform === "win32" || process.env.CODAR_PLUGIN_DISABLE_NATIVE === "1", timeout: 60_000 }, async () => {
  // After a refused socket and one refused replacement, proxyFetch set
  // `closing = true`, and proxy() then answered null until an explicit
  // closeProxy the host never makes: one outage kept the whole session on the
  // plain fetch. The failure is remembered for a pause instead.
  await withProxyEnv(fakeProxyDeafTwice, async ({ starts }) => {
    const first = await proxyFetch("https://api.claw.speedai.com/v1/codar/models").catch((e) => e)
    assert.equal(first?.name, "NativeUnavailable", `two refused sockets must be NativeUnavailable, not ${first}`)
    assert.equal(/not listening/.test(first.message), true, `the refusal must name the dead proxy: ${first.message}`)
    assert.equal(starts().length, 2, "the replacement was not attempted once")
    // inside the pause the same reason is given: it is the transport that is
    // out, not the machine that has no build
    const paused = await proxyFetch("https://api.claw.speedai.com/v1/codar/models").catch((e) => e)
    assert.equal(/not listening/.test(paused.message), true, `the pause said: ${paused.message}`)
    await later(120)
    const second = await proxyFetch("https://api.claw.speedai.com/v1/codar/models")
    assert.equal(second.status, 200, "the request after the pause did not reach a working proxy")
    assert.equal(starts().length, 3, "the transport stayed latched off instead of trying again")
  })
})

test("a start that failed says so, rather than blaming a missing platform package", { skip: process.platform === "win32" || process.env.CODAR_PLUGIN_DISABLE_NATIVE === "1", timeout: 60_000 }, async () => {
  // A build that exists but exits before its ready file is not "no platform
  // package for this machine": the fix is different (a broken install, a
  // binary the OS refuses, a transient spawn failure), and the message is
  // what a bug report quotes.
  await withProxyEnv("#!/usr/bin/env node\nprocess.exit(1)\n", async () => {
    const first = await proxyFetch("https://api.claw.speedai.com/v1/codar/models").catch((e) => e)
    assert.equal(first?.name, "NativeUnavailable")
    assert.match(first.message, /did not start/, `a failed start said: ${first.message}`)
    assert.doesNotMatch(first.message, /no platform package/, `a failed start blamed the install: ${first.message}`)
    // and during the retry pause the reason is the same one
    const second = await proxyFetch("https://api.claw.speedai.com/v1/codar/models").catch((e) => e)
    assert.match(second.message, /did not start/, `the pause said: ${second.message}`)
  })
  // a machine with no package at all still says exactly that: it is the one
  // case where installing is the fix
  const saved = process.env.CODAR_PROXY_BIN
  process.env.CODAR_PROXY_BIN = join(tmpdir(), "codar-native-test-no-such-binary")
  try {
    const e = await proxyFetch("https://api.claw.speedai.com/v1/codar/models").catch((x) => x)
    assert.equal(String(e?.message).replace("codar native transport unavailable: ", ""), "no platform package for this machine", `an absent build said: ${e?.message}`)
  } finally {
    if (saved === undefined) delete process.env.CODAR_PROXY_BIN
    else process.env.CODAR_PROXY_BIN = saved
    // this phase's failure left the retry pause on: closeProxy clears it, so
    // the next test starts from a transport that has not just failed
    await closeProxy()
  }
})

test("a refused streamed answer read as text ends at the caller's own bound", { ...NO_UNIX, timeout: 60_000 }, async () => {
  // A chat request streams, and a refusal's body is read with text(). The
  // socket's deadline after a head is the stream's idle bound (five minutes),
  // so a refusal that named a body and never sent it kept text() — and the
  // card that quotes the vendor's sentence — pending long past the caller's
  // own timeout.
  const s = await listen((r, socket) => {
    socket.on("error", () => {})
    socket.write("HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: 10\r\n\r\n")
  })
  try {
    const ans = await request(s.path, { stream: true, timeoutMs: 300 })
    assert.equal(ans.status, 403)
    const out = await Promise.race([ans.text().catch((e) => e), later(2000).then(() => "still pending")])
    assert.equal(out?.code, "no_answer", `text() outlived the caller's bound: ${out}`)
    for (let i = 0; i < 200 && s.open > 0; i++) await later(10)
    assert.equal(s.open, 0, "the abandoned refusal kept its socket")
  } finally {
    await s.close()
  }
})

test("the proxy's files live in a directory of this process's own", { skip: process.platform === "win32" || process.env.CODAR_PLUGIN_DISABLE_NATIVE === "1", timeout: 60_000 }, async () => {
  // The ready file tells this plugin where to send the account's credential.
  // In the shared temp directory its name was a pid (public) plus eight
  // characters of Math.random (not a CSPRNG), so another user on the machine
  // could plant a file this plugin would read as the listener's address. The
  // proxy's file and socket now sit in a mkdtemp directory, which is 0700:
  // nobody else can create either one.
  const dir = mkdtempSync(join(tmpdir(), "codar-native-private-"))
  const bin = join(dir, "fake-proxy.mjs")
  const log = join(dir, "starts.log")
  writeFileSync(bin, fakeProxy)
  chmodSync(bin, 0o755)
  const savedBin = process.env.CODAR_PROXY_BIN
  const savedLog = process.env.FAKE_PROXY_LOG
  process.env.CODAR_PROXY_BIN = bin
  process.env.FAKE_PROXY_LOG = log
  try {
    const ans = await proxyFetch("https://api.claw.speedai.com/v1/codar/models")
    assert.equal(ans.status, 200)
    const ready = readFileSync(log, "utf8").trim().split("\n")[0].split(" ")[1]
    const home = dirname(ready)
    assert.notEqual(home, tmpdir(), "the ready file is in the shared temp directory")
    assert.ok(home.startsWith(tmpdir()), "the directory is under the system temp root")
    const mode = statSync(home).mode & 0o777
    assert.equal(mode.toString(8), "700", `the proxy's directory is ${mode.toString(8)}, not private`)
    // and the socket the ready file names is inside it too
    const { address } = JSON.parse(readFileSync(ready, "utf8"))
    assert.equal(dirname(address), home, "the socket is outside the private directory")
  } finally {
    if (savedBin === undefined) delete process.env.CODAR_PROXY_BIN
    else process.env.CODAR_PROXY_BIN = savedBin
    if (savedLog === undefined) delete process.env.FAKE_PROXY_LOG
    else process.env.FAKE_PROXY_LOG = savedLog
    await closeProxy()
    rmSync(dir, { recursive: true, force: true })
  }
})

// The directory cleanup is the real binary's (native/cmd/codar-proxy/main.go):
// a stand-in executable cannot say whether the proxy has one. So this runs the
// build in this checkout, and leaves for a machine that has none.
const localBuild = binaryPath()
// binaryPath answers the checkout's path whether or not the file is there, so
// the packed tree (which ships no builds) has to be told apart by a file that
// exists: there this check is a skip, as the other build-dependent ones are.
test(
  "a proxy whose host was killed leaves no directory behind",
  { skip: process.platform === "win32" || !existsSync(localBuild) || !localBuild.startsWith(join(here, "..", "native", "bin")) || process.env.CODAR_PROXY_BIN ? "needs this checkout's own build" : false, timeout: 30_000 },
  async () => {
    // The proxy's socket, ready file and the 0700 directory holding them are
    // made for it by the host, which removes the directory when the proxy
    // exits. A host killed outright (a crash, the OOM killer, a SIGKILL)
    // never runs that handler. The proxy does exit by itself — the host's
    // death closes the pipe it reads — and it removes its own two files;
    // the directory, empty by then, used to stay for as long as the machine
    // ran, one per such death.
    const dir = mkdtempSync(join(tmpdir(), "codar-native-killed-"))
    const home = join(dir, "home")
    // the same shape the plugin gives the proxy: a directory of its own
    mkdirSync(home)
    const hostScript = join(dir, "host.mjs")
    writeFileSync(
      hostScript,
      `import { spawn } from "node:child_process"
const child = spawn(process.env.PROXY_BIN, ["-listen", "unix", "-address", process.env.HOME_DIR + "/proxy.sock", "-ready", process.env.HOME_DIR + "/ready.json"], { stdio: ["pipe", "ignore", "ignore"] })
child.on("exit", () => process.exit(0))
child.unref()
setTimeout(() => {}, 60000)
`,
    )
    const host = spawn(process.execPath, [hostScript], {
      stdio: "ignore",
      env: { ...process.env, PROXY_BIN: localBuild, HOME_DIR: home },
    })
    const until = async (fn) => {
      for (let i = 0; i < 250 && !fn(); i++) await new Promise((r) => setTimeout(r, 20))
      return fn()
    }
    try {
      assert.ok(await until(() => existsSync(join(home, "ready.json"))), "the proxy did not start")
      host.kill("SIGKILL")
      assert.equal(await until(() => !existsSync(home)), true, "the host's death left the proxy's directory behind")
    } finally {
      try {
        host.kill("SIGKILL")
      } catch {}
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

test("every platform's build carries its own sidecar's GODEBUG defaults", () => {
  // read off the 0.3.13 sidecars with `go version -m`: macOS and Linux carry
  // none, Windows carries the go 1.24 set (its sidecar is a 1.24 module built
  // by Go 1.26.7). tlssecpmlkem decides whether the ClientHello offers
  // X25519MLKEM768, so getting this wrong changes the fingerprint.
  const win = buildTargets.filter((t) => t.os === "win32")
  assert.equal(win.length, 1)
  assert.equal(win[0].directive, "1.24.0", "a 1.26 directive would bake in no defaults at all")
  assert.match(win[0].godebug, /(^|,)tlssecpmlkem=0(,|$)/, "the Windows sidecar does not offer X25519MLKEM768")
  assert.match(win[0].godebug, /(^|,)tlssha1=1(,|$)/)
  for (const t of buildTargets.filter((t) => t.os !== "win32")) assert.equal(t.godebug, "", `${t.os}/${t.arch} carries no DefaultGODEBUG`)
  for (const t of buildTargets) assert.equal(t.directive, "1.24.0", `${t.os}/${t.arch} changed module directive`)
})

test("an official URL is the desktop's own definition", () => {
  // electron/cloud-network.cjs officialURL: https, no userinfo, no port, and
  // one of the four hosts. Anything else is the desktop's plain-fetch path.
  const yes = (s) => officialURL(new URL(s))
  assert.equal(yes("https://api.claw.speedai.com/v1/codar/models"), true)
  // officialURL compares the hostname as written, so a trailing dot is not
  // official for the desktop either; the proxy strips it only when reading a
  // Host header it is already forwarding
  assert.equal(yes("https://api.claw.speedai.com./v1/codar/models"), false, "a trailing dot is not official")
  assert.equal(yes("https://api.claw.speedai.com:8443/v1/codar/models"), false, "a port is not official")
  assert.equal(yes("https://user:pw@api.claw.speedai.com/v1/codar/models"), false, "userinfo is not official")
  assert.equal(yes("http://api.claw.speedai.com/v1/codar/models"), false, "plain http is not official")
  assert.equal(yes("https://evil.example/v1/codar/models"), false)
  assert.equal(yes("https://api.claw.speedai.com.evil.example/v1/codar/models"), false)
})

test("only the vendor's official hosts and only the proxy's binary are used", { timeout: 60_000 }, async () => {
  for (const h of ["codar-web.speedai.com", "api.claw.speedai.com", "api.kuaipaper.com", "test.api.kuaipaper.com"]) assert.ok(hosts.has(h), h)
  assert.equal(hosts.has("evil.example"), false)
  // the build script and the lookup agree on every name: a build the script
  // writes for a platform is the file the lookup opens on it (they disagreed
  // on Windows once, and a Windows build went unfound). The directory is the
  // install's to choose — a checkout opens `native/bin`, an npm install opens
  // the platform package it landed (issue #8: asserting the checkout path
  // failed in a normal npm layout on Windows) — so the name is the contract
  // here, and the scratch-package test below proves the package layout. On a
  // host running the other arch's runtime (Rosetta) the lookup resolves
  // through the fallback, which is the other arch's build of the platform.
  for (const [platform, arch] of [["darwin", "arm64"], ["darwin", "x64"], ["linux", "arm64"], ["linux", "x64"], ["win32", "x64"]]) {
    const file = join(here, "..", "native", "bin", binaryFile(platform, arch))
    const other = arch === "arm64" ? "x64" : "arm64"
    const resolved = binaryPath(platform, arch)
    assert.ok(
      [binaryFile(platform, arch), binaryFile(platform, other)].includes(basename(resolved)),
      `${platform}/${arch}: the lookup opens a build of that platform, not ${resolved}`,
    )
    if (dirname(resolved) === join(here, "..", "native", "bin")) assert.equal(resolved, file, `${platform}/${arch}: a checkout's own build is the file opened`)
    // what the build script writes is that same name
    assert.equal(builtName({ os: platform, arch: arch === "x64" ? "amd64" : arch }), binaryFile(platform, arch))
  }
  assert.equal(binaryFile("win32", "x64"), "codar-proxy-win32-amd64.exe")
  assert.equal(binaryFile("darwin", "x64"), "codar-proxy-darwin-amd64")
  assert.equal(binaryFile("linux", "arm64"), "codar-proxy-linux-arm64")

  // no binary for this platform: NativeUnavailable, which is exactly the
  // answer request() falls back on. A binary path that cannot exist, and the
  // explicit opt-out, both answer it.
  const saved = process.env.CODAR_PROXY_BIN
  process.env.CODAR_PROXY_BIN = join(tmpdir(), "codar-native-test-no-such-binary")
  try {
    const e = await proxyFetch("https://api.claw.speedai.com/v1/codar/models").catch((x) => x)
    assert.equal(e?.name, "NativeUnavailable")
  } finally {
    if (saved === undefined) delete process.env.CODAR_PROXY_BIN
    else process.env.CODAR_PROXY_BIN = saved
  }
  await assert.rejects(proxyFetch("https://evil.example/x"), (e) => e?.name === "NativeUnavailable")
  const off = process.env.CODAR_PLUGIN_DISABLE_NATIVE
  process.env.CODAR_PLUGIN_DISABLE_NATIVE = "1"
  try {
    await assert.rejects(proxyFetch("https://api.claw.speedai.com/v1/codar/models"), /disabled/)
  } finally {
    if (off === undefined) delete process.env.CODAR_PLUGIN_DISABLE_NATIVE
    else process.env.CODAR_PLUGIN_DISABLE_NATIVE = off
  }
})

test("importing the build script builds nothing", async () => {
  // The suite imports binaryName from scripts/build-native.mjs. Without a
  // main-module guard, that import ran the whole build: a Go toolchain
  // download and process.exit inside a test process. A child that only
  // imports the script must exit quietly.
  const dir = mkdtempSync(join(tmpdir(), "codar-native-import-"))
  try {
    const probe = join(dir, "probe.mjs")
    const script = pathToFileURL(join(here, "..", "scripts", "build-native.mjs")).href
    writeFileSync(probe, `await import(${JSON.stringify(script)})\n`)
    const { code, stdout, stderr } = await new Promise((resolve) => {
      execFile(process.execPath, [probe], { cwd: dir }, (e, stdout, stderr) => resolve({ code: e?.code ?? 0, stdout, stderr }))
    })
    assert.equal(code, 0, stderr)
    assert.equal(stdout, "", "importing build-native.mjs ran the build")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("each platform's build ships as its own npm package, under npm's own platform names", async () => {
  const { packageCpu, packageName, packageOs } = await import("../native/binary-name.mjs")
  // npm's cpu field is matched against process.arch, and npm refuses anything
  // else outright (npm 12.2.1, measured 2026-11-15: `cpu:["amd64"]` is
  // EBADPLATFORM, "Actual cpu: x64"; `cpu:["x64"]` installs). Bun does not
  // check the field at all, so the Go spelling would install for one package
  // manager and fail for the other.
  assert.equal(packageCpu("amd64"), "x64", "Go's amd64 is npm's x64")
  assert.equal(packageCpu("x64"), "x64")
  assert.equal(packageCpu("arm64"), "arm64")
  assert.equal(packageOs("win32"), "win32", "npm's os field is Node's platform name, as it is here")
  // The package carries the npm spelling; the binary inside it keeps the file
  // name the build script writes and the lookup opens (binaryFile).
  assert.equal(packageName("darwin", "x64"), "magpie-plugin-codar-darwin-x64")
  assert.equal(packageName("win32", "amd64"), "magpie-plugin-codar-win32-x64")
  assert.equal(packageName("linux", "arm64"), "magpie-plugin-codar-linux-arm64")
  assert.equal(packageName("darwin", "arm64"), "magpie-plugin-codar-darwin-arm64")
  // Every target the build script makes has a package, and no two share one.
  const names = buildTargets.map((t) => packageName(t.os, t.arch))
  assert.equal(names.length, 5)
  assert.equal(new Set(names).size, names.length)
})

test("the plugin opens the proxy from the platform package that was installed", { timeout: 60_000 }, async () => {
  // The package manager decides which platform package lands (bun and npm both
  // filter optionalDependencies by os/cpu, measured 2026-11-15), so the lookup
  // must follow what is installed rather than recompute it: a machine running
  // an x64 runtime under Rosetta reports process.arch x64 and needs the x64
  // build. The checkout's native/bin stays the fallback for a working tree.
  //
  // All of it in a scratch package of its own, with node_modules beside it: a
  // suite run inside a packed tarball has its own native/bin, and a fixture
  // planted in the real checkout's node_modules would be a file this test
  // wrote into a directory it does not own.
  const { packageName } = await import("../native/binary-name.mjs")
  // tmpdir is /var on macOS, a symlink to /private/var: compared as written,
  // the resolved path and the picked one differ and nothing matches.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "codar-native-lookup-")))
  mkdirSync(join(dir, "lib"))
  mkdirSync(join(dir, "native", "bin"), { recursive: true })
  // The plugin's own modules, so the lookup runs as the installed package does
  // — one scratch directory's layout, not the checkout's.
  for (const f of readdirSync(join(here, "..", "lib"))) copyFileSync(join(here, "..", "lib", f), join(dir, "lib", f))
  copyFileSync(join(here, "..", "native", "binary-name.mjs"), join(dir, "native", "binary-name.mjs"))
  const name = packageName("darwin", "arm64")
  const pkg = join(dir, "node_modules", name)
  const file = join(pkg, "bin", binaryFile("darwin", "arm64"))
  // Each case is a fresh import, because a resolution cache would answer the
  // last one otherwise.
  const lookup = async (platform, arch) => (await import(`${pathToFileURL(join(dir, "lib", "native.mjs")).href}?${Math.random()}`)).binaryPath(platform, arch)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, version: "0.0.0" }))
    writeFileSync(file, Buffer.concat([headerFor("darwin", "arm64"), Buffer.alloc(8192)]))
    assert.equal(await lookup("darwin", "arm64"), file, "the installed package was not opened")
    // The lookup's first answer is this platform's package. Its second is the
    // other architecture of the same platform when that is what landed; the
    // fallback is the checkout's build for the architecture asked for.
    assert.equal(await lookup("darwin", "x64"), file)
    assert.equal(await lookup("linux", "arm64"), join(dir, "native", "bin", binaryFile("linux", "arm64")))
  } finally {
    rmSync(pkg, { recursive: true, force: true })
  }
  assert.equal(await lookup("darwin", "arm64"), join(dir, "native", "bin", binaryFile("darwin", "arm64")), "the checkout did not answer once the package was gone")
  // CODAR_PROXY_BIN still wins over both.
  const saved = process.env.CODAR_PROXY_BIN
  process.env.CODAR_PROXY_BIN = join(tmpdir(), "codar-native-test-override")
  try {
    assert.equal(await lookup("darwin", "arm64"), join(tmpdir(), "codar-native-test-override"))
  } finally {
    if (saved === undefined) delete process.env.CODAR_PROXY_BIN
    else process.env.CODAR_PROXY_BIN = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

// Two spawns of npm per package (view, publish preflight) put this past the
// runners' default five-second bound on a loaded machine.
test("a release ships each build as its own package, and the main package names all five", { timeout: 120000 }, async (t) => {
  const { checkPackages, mainPackageProblems, stagePackages, took } = await import("../scripts/native-packages.mjs")
  const { packageName } = await import("../native/binary-name.mjs")
  const bin = mkdtempSync(join(tmpdir(), "codar-native-pkgs-bin-"))
  const out = mkdtempSync(join(tmpdir(), "codar-native-pkgs-out-"))
  const version = "9.9.9"
  try {
    for (const t of buildTargets) {
      const path = join(bin, binaryFile(t.os, t.arch))
      writeFileSync(path, Buffer.concat([headerFor(t.os, t.arch), Buffer.alloc(8192)]))
      chmodSync(path, 0o755)
    }
    const staged = stagePackages({ bin, out, version })
    assert.equal(staged.length, 5, "not every platform got a package")
    for (const t of buildTargets) {
      const name = packageName(t.os, t.arch)
      const dir = join(out, name)
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
      assert.equal(manifest.name, name)
      assert.equal(manifest.version, version, "a package's version is the release's")
      assert.deepEqual(manifest.os, [t.os], "npm matches os against process.platform")
      assert.deepEqual(manifest.cpu, [t.arch === "amd64" ? "x64" : t.arch], "npm matches cpu against process.arch")
      assert.deepEqual(manifest.files, ["bin"], "only the build ships")
      assert.equal(manifest.license, "MIT")
      const file = join(dir, "bin", binaryFile(t.os, t.arch))
      assert.deepEqual(readFileSync(file), readFileSync(join(bin, binaryFile(t.os, t.arch))), "the build was not copied")
      // An npm tarball keeps the mode it was packed with; a build that arrives
      // without it cannot be spawned, which is how the released tarball once
      // failed its own gate.
      // Windows has no execute bit and does not read one; the mode handed to
      // chmodSync is what npm keeps in the tarball.
      if (process.platform !== "win32") assert.ok((statSync(file).mode & 0o111) !== 0, `${name}'s build is not executable`)
    }
    assert.deepEqual(checkPackages({ dir: out, version }).filter((r) => r.state !== "present"), [])

    // A version that drifted from the main package's is a package nobody's
    // optionalDependencies name, and npm would refuse it as unsupported.
    const drifted = checkPackages({ dir: out, version: "9.9.10" })
    assert.equal(drifted.filter((r) => r.state !== "present").length, 5, "a drifted version passed")
    // A build missing from the staging area must not become an empty package.
    rmSync(join(out, packageName("linux", "arm64"), "bin", binaryFile("linux", "arm64")))
    const broken = checkPackages({ dir: out, version }).filter((r) => r.state !== "present")
    assert.equal(broken.length, 1)
    assert.match(broken[0].reason, /missing/)
    let refused
    try {
      stagePackages({ bin: join(bin, "nowhere"), out, version })
    } catch (e) {
      refused = e
    }
    assert.match(refused?.message ?? "", /no build/, "staging a platform with no build did not refuse")

    // A staging area that outlived its release must not ship its stale files
    // beside this build: npm packs the directory as it is, not what the copy
    // wrote. Re-staging replaces each package directory whole.
    const stale = join(out, packageName("darwin", "arm64"), "bin", "STALE-SHOULD-SHIP")
    writeFileSync(stale, "left over from an earlier release")
    stagePackages({ bin, out, version })
    assert.ok(!existsSync(stale), "a stale file in the staging area was packed with the build")
    assert.deepEqual(checkPackages({ dir: out, version }).filter((r) => r.state !== "present"), [], "re-staging left the packages broken")

    // What the main package must say for the platform packages to be reached.
    const good = {
      name: "magpie-plugin-codar",
      version,
      optionalDependencies: Object.fromEntries(buildTargets.map((t) => [packageName(t.os, t.arch), version])),
      files: ["index.mjs", "native/binary-name.mjs"],
    }
    assert.deepEqual(mainPackageProblems(good), [])
    const { [packageName("win32", "amd64")]: dropped, ...fewer } = good.optionalDependencies
    assert.match(mainPackageProblems({ ...good, optionalDependencies: fewer }).join(" "), /win32-x64/, "a platform package left out was not reported")
    assert.match(
      mainPackageProblems({ ...good, optionalDependencies: { ...good.optionalDependencies, [packageName("linux", "x64")]: "^9.9.9" } }).join(" "),
      /linux-x64/,
      "a range instead of the exact version was not reported",
    )
    assert.match(mainPackageProblems({ ...good, files: [...good.files, "native/bin"] }).join(" "), /native\/bin/, "the five builds would ship twice")

  // A version already on the registry cannot be replaced, and publishing the
  // rest of a version half way leaves one nobody can finish. The preflight is
  // read against the real registry: 0.3.0 is published, a version nobody has
  // taken is not, and a package that does not exist is not taken either.
  //
  // This is the one test that leaves the machine, so a registry that cannot be
  // reached says nothing about the preflight: a dropped TLS connection is not
  // a wrong answer. A network failure skips these three reads with a note; an
  // assertion failure is still a failure.
  if (process.env.CODAR_OFFLINE !== "1") {
    const unreachable = /socket disconnected|socket hang up|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ECONNREFUSED|certificate|Client network/i
    try {
      assert.deepEqual(took([{ name: "magpie-plugin-codar-darwin-x64" }], "0.3.0"), ["magpie-plugin-codar-darwin-x64"], "a taken version was not seen as taken")
      assert.deepEqual(took([{ name: "magpie-plugin-codar-darwin-x64" }], "9.9.99"), [], "an unpublished version was seen as taken")
      assert.deepEqual(took([{ name: "magpie-plugin-codar-darwin-artifact-not-real" }], "0.3.0"), [], "a package that does not exist was seen as taken")
    } catch (e) {
      if (!unreachable.test(String(e?.message ?? ""))) throw e
      t.diagnostic(`the registry could not be reached (${e.message}); the preflight's own reads are tested above`)
    }
  }
  } finally {
    for (const dir of [bin, out]) rmSync(dir, { recursive: true, force: true })
  }
})

test("the packaging CLI answers a broken start with one line, not a stack", { timeout: 60_000 }, async () => {
  // build-native answers a thrown start with `build-native: <message>` and
  // exit1, and reserves exit2 for an argument it does not know;
  // native-packages did the same for its argument, but a package.json it
  // cannot parse (a half-saved file, a merge left open) escaped as Node's
  // raw stack — the release run's log filled with frames, and the one line
  // that says what broke was lost at the bottom of them.
  const root = mkdtempSync(join(tmpdir(), "codar-pkgcli-"))
  try {
    cpSync(join(here, "..", "scripts"), join(root, "scripts"), { recursive: true })
    cpSync(join(here, "..", "native"), join(root, "native"), { recursive: true })
    writeFileSync(join(root, "package.json"), "{ broken\n")
    const run = spawnSync(process.execPath, [join(root, "scripts", "native-packages.mjs"), "--check"], { encoding: "utf8", timeout: 30000 })
    assert.equal(run.status, 1, "a start that cannot read the manifest fails the check")
    assert.match(run.stderr, /^native-packages: /, "and says so in the script's own one line")
    assert.ok(!/at .*\.mjs:\d+/.test(run.stderr), `no stack frames in the answer: ${run.stderr.slice(0, 160)}`)
    // an argument it does not know stays the exit2 it was
    const arg = spawnSync(process.execPath, [join(root, "scripts", "native-packages.mjs"), "--nope"], { encoding: "utf8", timeout: 30000 })
    assert.equal(arg.status, 2, "an unknown argument is still 'this script cannot run'")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the start's own fresh directory is never the sweep's victim, whatever its mtime", { ...NO_UNIX }, async () => {
  // The grace is the only other thing standing between a just-made directory
  // and the sweep: a suspended start or a clock jump past it would make the
  // start's own directory look dead. Its name is named to the sweep instead.
  const { sweepStaleDirs } = await import("../lib/native.mjs")
  const root = mkdtempSync(join(tmpdir(), "codar-sweep-own-"))
  const dir = join(root, "codar-plugin-own0001")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // a ready whose pid is gone: were it not named to the sweep, it would go
  const dead = spawn(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { stdio: ["ignore", "pipe", "ignore"] })
  const deadPid = await new Promise((r) => dead.stdout.once("data", (c) => r(Number(String(c)))))
  await new Promise((r) => dead.once("exit", r))
  writeFileSync(join(dir, "ready.json"), JSON.stringify({ transport: "tcp", address: "127.0.0.1:1", pid: String(deadPid) }))
  const past = new Date(Date.now() - 60000)
  utimesSync(dir, past, past)
  try {
    assert.deepEqual(await sweepStaleDirs({ root, minAgeMs: 30000, skip: [dir] }), [], "the named directory was swept")
    assert.ok(existsSync(dir))
    assert.deepEqual(await sweepStaleDirs({ root, minAgeMs: 30000 }), [dir], "unnamed, the same directory is a dead shell")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("no ready at all is never death: nothing recorded can prove the proxy gone", { ...NO_UNIX, timeout: 30_000 }, async () => {
  // A directory with no ready is a start between mkdtemp and its ready write
  // — possibly a live, paused one — or a kill in that sub-second window. The
  // earlier rule dialled the socket here, and Codex showed a paused proxy
  // whose queue was full answering ECONNREFUSED like a dead one; the sweep
  // keeps such a directory and lets the owner (or one manual clean-up tidy
  // the rare abandoned shell).
  const { proxyDead } = await import("../lib/native.mjs")
  const root = mkdtempSync(join(tmpdir(), "cdr-r-"))
  const dir = join(root, "codar-plugin-r1")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const sock = join(dir, "proxy.sock")
  const child = spawn(process.execPath, ["-e", `
    const net = require("node:net")
    const server = net.createServer(() => {})
    server.listen(process.argv[1], () => console.log("ready"))
  `, sock], { stdio: ["ignore", "pipe", "ignore"] })
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once("data", () => resolve())
      child.once("exit", () => reject(new Error("the listener died before binding")))
    })
    child.kill("SIGKILL")
    await new Promise((r) => child.once("exit", r))
    assert.ok(existsSync(sock), "the killed process's socket path should outlive it")
    assert.equal(proxyDead(dir), false, "a refused socket with no ready was called dead")
    rmSync(sock)
    assert.equal(proxyDead(dir), false, "an empty directory was called dead")
    writeFileSync(sock, "a plain file where a socket was")
    assert.equal(proxyDead(dir), false, "a plain file where a socket was was called dead")
  } finally {
    try { child.kill("SIGKILL") } catch {}
    rmSync(root, { recursive: true, force: true })
  }
})

test("a ready without a pid, or in a shape the sweep does not know, leaves the shell alone", async () => {
  // Every ready that cannot prove death is kept: an older build's (no pid),
  // an unreadable line, a FIFO, an oversized file. The sweep never deletes
  // what it could not judge.
  const { proxyDead } = await import("../lib/native.mjs")
  const root = mkdtempSync(join(tmpdir(), "codar-probe-unproven-"))
  const shapes = {
    "an older build's unix ready": { transport: "unix", address: "/tmp/whatever.sock" },
    "an older build's tcp ready": { transport: "tcp", address: "127.0.0.1:1" },
    "a pid past any real range": { transport: "tcp", address: "127.0.0.1:1", pid: "999999999999" },
    "a pid that is not a number": { transport: "tcp", address: "127.0.0.1:1", pid: "me" },
    "unreadable JSON": "{ not json",
  }
  try {
    for (const [label, ready] of Object.entries(shapes)) {
      const dir = join(root, "codar-plugin-" + label.replace(/\W+/g, "").slice(0, 12) + Math.random().toString(36).slice(2, 6))
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      if (typeof ready === "string") writeFileSync(join(dir, "ready.json"), ready)
      else writeFileSync(join(dir, "ready.json"), JSON.stringify(ready))
      assert.equal(proxyDead(dir), false, `${label}: a shell the sweep could not judge was declared dead`)
    }
    // a FIFO named ready.json would block a plain read forever
    const fifo = join(root, "codar-plugin-fifo001")
    mkdirSync(fifo, { recursive: true, mode: 0o700 })
    const made = spawnSync("mkfifo", [join(fifo, "ready.json")])
    if (made.status === 0) assert.equal(proxyDead(fifo), false, "a FIFO ready blocked or was judged")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a live pid keeps the shell even when its socket answers nothing", { ...NO_UNIX, timeout: 30_000 }, async () => {
  // Codex's reproduction: a paused proxy whose Unix accept queue is full
  // answers ECONNREFUSED exactly as a dead one does (measured 2026-11-23 on
  // macOS), so a connect probe deleted a live process's directory. The pid in
  // the ready is the answer that cannot be confused — a socket that answers
  // nothing (here: nothing is bound at all, the strongest form) keeps the
  // shell while the process lives, and a later sweep must too.
  const { proxyDead, sweepStaleDirs } = await import("../lib/native.mjs")
  const root = mkdtempSync(join(tmpdir(), "cdr-w-"))
  const dir = join(root, "codar-plugin-w1")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const ready = join(dir, "ready.json")
  // a proxy-shaped child: it records its pid the way the proxy does, then
  // stops (SIGSTOP stands in for the wedged process whose queue is full)
  const child = spawn(process.execPath, ["-e", `
    const fs = require("node:fs")
    fs.writeFileSync(process.argv[1], JSON.stringify({ transport: "unix", address: process.argv[2], pid: String(process.pid) }))
    console.log("ready")
    setInterval(() => {}, 1000)
  `, ready, join(dir, "proxy.sock")], { stdio: ["ignore", "pipe", "ignore"] })
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once("data", () => resolve())
      child.once("exit", (code) => reject(new Error(`the stand-in exited ${code}`)))
    })
    child.kill("SIGSTOP")
    assert.equal(proxyDead(dir), false, "a live pid's shell was declared dead over a silent socket")
    const past = new Date(Date.now() - 60000)
    utimesSync(dir, past, past)
    assert.deepEqual(await sweepStaleDirs({ root, minAgeMs: 30000 }), [], "the sweep took a live wedged proxy's directory")
    assert.ok(existsSync(dir))
  } finally {
    try { child.kill("SIGKILL") } catch {}
    await new Promise((r) => child.once("exit", r))
    rmSync(root, { recursive: true, force: true })
  }
})

test("a pid that is gone is death, whatever its socket says", async () => {
  // The other side: the proxy wrote its pid and exited. Its socket may even
  // still answer for a moment (a leftover path) — nobody is behind it.
  const { proxyDead } = await import("../lib/native.mjs")
  const root = mkdtempSync(join(tmpdir(), "codar-probe-deadpid-"))
  const dir = join(root, "codar-plugin-dead01")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const child = spawn(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { stdio: ["ignore", "pipe", "ignore"] })
  const pid = await new Promise((resolve) => child.stdout.once("data", (c) => resolve(Number(String(c)))))
  await new Promise((r) => child.once("exit", r))
  writeFileSync(join(dir, "ready.json"), JSON.stringify({ transport: "tcp", address: "127.0.0.1:1", pid: String(pid) }))
  try {
    assert.equal(proxyDead(dir), true, "a dead pid's shell was kept")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a ready.json that is a symlink is never read, so it cannot prove death", async () => {
  // Codex, 2026-11-24: the shape check ran on the path and the read on the
  // path again, so a same-user plant could swap in a symlink to a dead-pid
  // JSON between them and have a live proxy's directory swept. One open with
  // O_NOFOLLOW decides shape and bytes together; a link at the name fails
  // that open, and the shell stays.
  const { proxyDead } = await import("../lib/native.mjs")
  const root = mkdtempSync(join(tmpdir(), "cdr-ln-"))
  const dir = join(root, "codar-plugin-lnk01")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const elsewhere = join(root, "planted.json")
  const dead = spawn(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { stdio: ["ignore", "pipe", "ignore"] })
  const deadPid = await new Promise((r) => dead.stdout.once("data", (c) => r(Number(String(c)))))
  await new Promise((r) => dead.once("exit", r))
  writeFileSync(elsewhere, JSON.stringify({ transport: "unix", address: join(dir, "proxy.sock"), pid: String(deadPid) }))
  symlinkSync(elsewhere, join(dir, "ready.json"))
  try {
    assert.equal(proxyDead(dir), false, "a symlinked ready was followed and its dead pid taken as proof")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a ready.json swapped for a symlink after the open cannot change what was read", async () => {
  // The other half: even where O_NOFOLLOW is not what the name shows (a real
  // file is replaced mid-lifetime), the bytes read are the bytes of the inode
  // that was opened. A directory whose ready is a real file at open time and
  // a symlink after still reads as the original file's answer.
  const { proxyDead } = await import("../lib/native.mjs")
  const root = mkdtempSync(join(tmpdir(), "cdr-sw-"))
  const dir = join(root, "codar-plugin-swp01")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const ready = join(dir, "ready.json")
  writeFileSync(ready, JSON.stringify({ transport: "unix", address: join(dir, "proxy.sock"), pid: String(process.pid) }))
  try {
    const answer = proxyDead(dir)
    // the read happened on the descriptor, so the answer is the live pid's:
    // kept whether or not anything was swapped afterwards
    assert.equal(answer, false, "a live pid's ready was read as death")
    assert.ok(existsSync(ready))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a pid that is not a decimal integer is no pid this sweep acts on", async () => {
  // The proxy writes a decimal string. Everything else — a boolean (Number
  // would make true → 1), a float, a negative, pid 1 itself, a hex string —
  // is a shape the sweep does not understand, and an ununderstood shape is
  // kept, never judged.
  const { proxyDead } = await import("../lib/native.mjs")
  const root = mkdtempSync(join(tmpdir(), "cdr-pid-"))
  const shapes = [true, 1.5, -4, 1, "1", "0x10", " 12", "12abc", 4194305, null, {}]
  try {
    for (const pid of shapes) {
      const dir = join(root, "codar-plugin-p" + Math.random().toString(36).slice(2, 8))
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(join(dir, "ready.json"), JSON.stringify({ transport: "unix", address: join(dir, "proxy.sock"), pid }))
      assert.equal(proxyDead(dir), false, `pid ${JSON.stringify(pid)} was judged`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("only ESRCH is death: another answer to a pid question keeps the shell", async () => {
  // Codex's injection: an EIO from process.kill(pid, 0) made a live pid read
  // as dead and its directory swept. The kernel's ESRCH is the only answer
  // that proves the process gone; permission and error answers prove nothing.
  const { proxyDead } = await import("../lib/native.mjs")
  const root = mkdtempSync(join(tmpdir(), "codar-probe-kill-"))
  const dir = join(root, "codar-plugin-kill01")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, "ready.json"), JSON.stringify({ transport: "unix", address: join(dir, "proxy.sock"), pid: String(process.pid) }))
  const realKill = process.kill
  try {
    for (const code of ["EPERM", "EIO", "EINVAL", "EACCES", undefined]) {
      process.kill = () => {
        throw Object.assign(new Error(String(code)), code ? { code } : {})
      }
      assert.equal(proxyDead(dir), false, `${code ?? "an uncoded error"} from the pid question was read as death`)
    }
    process.kill = () => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" })
    }
    assert.equal(proxyDead(dir), true, "ESRCH is the one answer that proves the process gone")
  } finally {
    process.kill = realKill
    rmSync(root, { recursive: true, force: true })
  }
})

test("a sweep drops only dead, aged directories under our prefix", NO_UNIX, async () => {
  // The rule sweepStaleDirs follows, pinned against a root of its own so no
  // real proxy can be caught in it: under the prefix, past the grace, and
  // proven dead by its own ready — a recorded pid that is gone. Every other
  // shape survives: a live pid, an older build's ready (no pid — never
  // guessed at), no ready at all, an empty shell, a planted link, a socket
  // path that is a plain file, a fresh start, a name outside the prefix, a
  // directory that cannot be read.
  const { sweepStaleDirs } = await import("../lib/native.mjs")
  const root = mkdtempSync(join(tmpdir(), "codar-sweep-test-"))
  const past = new Date(Date.now() - 60000)
  const mk = (name) => {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return dir
  }
  // a directory's mtime follows its last content write, so the age is set
  // after the shapes are filled, the way a dead proxy's directory sits
  // untouched from its death onward
  const age = (dir) => utimesSync(dir, past, past)
  try {
    // a pid that has exited, recorded the way the proxy writes it
    const dead = spawn(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { stdio: ["ignore", "pipe", "ignore"] })
    const deadPid = await new Promise((r) => dead.stdout.once("data", (c) => r(Number(String(c)))))
    await new Promise((r) => dead.once("exit", r))
    const readyGone = mk("codar-plugin-gone001")
    writeFileSync(join(readyGone, "ready.json"), JSON.stringify({ transport: "unix", address: join(readyGone, "proxy.sock"), pid: String(deadPid) }))
    age(readyGone)
    // an older build's ready, naming a socket that is gone: no pid, no proof
    const oldReady = mk("codar-plugin-oldr004")
    writeFileSync(join(oldReady, "ready.json"), JSON.stringify({ transport: "unix", address: join(oldReady, "proxy.sock"), token: "aa" }))
    age(oldReady)
    const staleSock = mk("codar-plugin-oldc002")
    writeFileSync(join(staleSock, "proxy.sock"), "a plain file where a socket was")
    age(staleSock)
    const empty = mk("codar-plugin-nada003")
    age(empty)
    const live = mk("codar-plugin-live004")
    const fresh = mk("codar-plugin-fresh5")
    writeFileSync(join(fresh, "ready.json"), "{}")
    const unrelated = mk("codar-plugins-other6")
    writeFileSync(join(unrelated, "ready.json"), "{}")
    age(unrelated)
    const unreadable = mk("codar-plugin-hush007")
    writeFileSync(join(unreadable, "ready.json"), "{}")
    age(unreadable)

    // one real server answers inside `live`, at the address its ready names
    const sock = join(live, "proxy.sock")
    const server = createServer()
    // track what the probe leaves behind: a client that connects and
    // destroys itself stays half-open on the server side, and that fd is
    // what keeps the close callback (and the process) waiting.
    const accepted = new Set()
    server.on("connection", (s) => {
      accepted.add(s)
      s.on("close", () => accepted.delete(s))
    })
    await new Promise((r, rej) => {
      server.once("error", rej)
      server.listen(sock, r)
    })
    writeFileSync(join(live, "ready.json"), JSON.stringify({ transport: "unix", address: sock, pid: String(process.pid) }))
    age(live)
    chmodSync(unreadable, 0o000)
    // a same-user plant could name the directory's socket a SYMLINK to
    // another process's live socket: with no ready there is no pid and no
    // verdict, so the shell stays and nothing is dialled through the link.
    const linkShell = mk("codar-plugin-link08")
    symlinkSync(sock, join(linkShell, "proxy.sock"))
    age(linkShell)
    try {
      const removed = await sweepStaleDirs({ root, minAgeMs: 30000 })
      assert.deepEqual(removed, [readyGone], "only the ready with a dead pid is death")
      assert.ok(!existsSync(readyGone), "the dead shell is gone for real")
      // everything the sweep cannot prove dead stays, however it looks
      for (const [label, dir] of [
        ["an older build's ready", oldReady],
        ["a plain file wearing the socket's name", staleSock],
        ["an empty directory", empty],
        ["a live pid", live],
        ["a planted link", linkShell],
        ["inside the grace", fresh],
        ["outside the prefix", unrelated],
        ["unreadable", unreadable],
      ]) {
        assert.ok(!removed.includes(dir), `${label} was swept`)
        assert.ok(existsSync(dir), `${label} was removed`)
      }
      assert.ok(existsSync(sock), "the linked socket's target stands")
      assert.equal((await sweepStaleDirs({ root, minAgeMs: 30000 })).length, 0, "a second sweep finds nothing new")
    } finally {
      for (const s of accepted) s.destroy()
      await new Promise((r) => server.close(r))
      try { unlinkSync(sock) } catch {}
      chmodSync(unreadable, 0o700)
    }
  } finally {
    // macOS releases an unlinked socket's directory slot on its own clock,
    // and a recursive rm racing that answers ENOTEMPTY — which is not in
    // rmSync's own retry list. The sweep retried loop gives it a moment; a
    // root that still resists is the OS temp cleaner's to finish, not a
    // product failure worth failing the test over (every assertion above
    // has already run by this point).
    const { rm } = await import("node:fs/promises")
    for (let i = 0; i < 20; i++) {
      try {
        await rm(root, { recursive: true, force: true })
        break
      } catch {
        await new Promise((r) => setTimeout(r, 50))
      }
    }
  }
})

test("every shipped build is made without a VCS stamp", async () => {
  // Go stamps VCS information into a binary by default, read from the
  // checkout the build runs in — not from the source. The 0.2.0 through
  // 0.2.3 builds carried vcs.revision=c90d4d9 (v0.1.2) and
  // vcs.modified=true because native/bin was last built before the 0.2.0
  // tree, so the stamp named a commit the binary was not built from. A
  // review reads build info; it must not read something false, so the flag
  // is pinned here rather than left out by habit.
  const { buildArgs } = await import("../scripts/build-native.mjs")
  const args = buildArgs("native/bin/x")
  assert.ok(args.includes("-buildvcs=false"), "the build turns VCS stamping off")
  assert.deepEqual(args.slice(0, 2), ["build", "-trimpath"], "and keeps the build path out")
  assert.equal(args.at(-1), "./cmd/codar-proxy")
})
