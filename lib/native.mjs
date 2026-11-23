// Native requests: the plugin's catalog, check-in and points requests leave
// through the Codar desktop's own Go transport, not Bun's TLS stack.
//
// The desktop calls its vendor from a Go sidecar (Resources/bin/codar in the
// 0.3.13 packages), and request fingerprints differ between that transport
// and Bun's fetch: a different TLS ClientHello (cipher order, curves, key
// share), HTTP/2 settings, no Origin/Referer/Sec-* headers, a Go User-Agent.
// native/cmd/codar-proxy rebuilds the sidecar's provider client from its
// binary (see the comment at the top of that file) and this module talks to
// it over a private socket in the temp directory, so everything the plugin
// sends to the gateway comes out of Go's net/http with the sidecar's settings.
//
// The binary is optional. It is built per platform by scripts/build-native.mjs
// into native/bin; when it is missing, or cannot start, or the host is not one
// the proxy forwards, fetchImpl falls back to the plugin's ordinary fetch.
// That fallback is the old fingerprint, and the README says so; this module
// never pretends otherwise.
//
// Protocol: the proxy listens on a Unix socket (POSIX) or a loopback port
// (Windows, where the plugin cannot be sure a Unix socket is reachable) and
// publishes {"transport", "address", "token"} in a ready file it writes with
// mode 0600. Each request is plain HTTP/1.1 with the vendor's Host, the
// plugin's Authorization and Content-Type, and in TCP mode the token. The
// proxy drops everything else and sends the request itself.

import { spawn } from "node:child_process"
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { binaryFile, packageName } from "../native/binary-name.mjs"
import { guardedFetch } from "./guarded.mjs"
import { MAX_ANSWER_BYTES } from "./internal.mjs"

const here = dirname(fileURLToPath(import.meta.url))

// hosts are the ones the desktop's own cloud-network controller treats as
// official (electron/cloud-network.cjs, OFFICIAL_HOSTS). The proxy enforces
// the same list; this copy keeps non-official URLs on the ordinary fetch
// without a failed round trip.
export const hosts = new Set(["codar-web.speedai.com", "api.claw.speedai.com", "api.kuaipaper.com", "test.api.kuaipaper.com"])

// FORWARDED is native/cmd/codar-proxy's `forwarded` list, spelled the way a
// header is written. The proxy enforces its own copy; this one decides what
// sendVia writes, so a name added here without there (or the other way round)
// would be dropped rather than forwarded.
const FORWARDED = ["Authorization", "Content-Type", "X-Api-Key", "Anthropic-Version"]

// MAX_ANSWER_BYTES bounds one answer, counted as it arrives; it is declared
// once, in internal.mjs, and read from there so the transport's cap and the
// buffered read's (readAnswer counts through the body stream, so its cap
// applies while reading) cannot drift apart. Without a cap here the whole
// answer would sit in memory first. A caller may pass maxBytes in init; the
// default is that same 8 MiB.
export { MAX_ANSWER_BYTES }

// STREAM_ANSWER_BYTES bounds a streamed answer, which is not held in memory:
// the figure is a guard against a peer that never stops, not a budget the
// answer has to fit in. A chat conversation can run longer than a catalog
// answer by an order of magnitude and still be over before this.
const STREAM_ANSWER_BYTES = 64 * 1024 * 1024

// NO_ANSWER_MS bounds one exchange whose caller passed no signal: a peer that
// neither answers nor hangs up must not leave the promise pending. request()
// always passes a signal, so this only covers direct callers.
const NO_ANSWER_MS = 2 * 60 * 1000

// STREAM_IDLE_MS is that same bound once a stream has started: silence is what
// it measures, so a model that keeps talking is never cut off mid-answer.
const STREAM_IDLE_MS = 5 * 60 * 1000

// binaryPath names the proxy build for this platform: the one the platform
// package installed, and failing that the build in the checkout (native/bin,
// which scripts/build-native.mjs writes and a working tree has). CODAR_PROXY_BIN
// overrides both.
//
// Which platform package landed was decided by the package manager, from the
// os/cpu fields, so this asks what is installed instead of recomputing it: on
// Apple Silicon under Rosetta the runtime reports arch x64 and needs the x64
// build, and a name computed from anything else would open a file that is not
// there. The other architecture of the same platform is tried second, because
// a package manager that installed the wrong one still installed a runnable
// build for this machine, which is better than no proxy at all.
export function binaryPath(platform = process.platform, arch = process.arch) {
  if (process.env.CODAR_PROXY_BIN) return process.env.CODAR_PROXY_BIN
  for (const candidate of [arch, arch === "arm64" ? "x64" : "arm64"]) {
    const installed = installedBinary(platform, candidate)
    if (installed) return installed
  }
  return join(here, "..", "native", "bin", binaryFile(platform, arch))
}

// installedBinary is the build inside the platform package for platform/arch,
// or null when that package is not installed. Resolution goes through the
// package's own name, so it follows node_modules the way any other dependency
// does — the host may install plugins somewhere other than this tree. The
// path is checked on disk rather than trusted: require.resolve caches what it
// resolved, and a package directory that went away since then is not a proxy.
function installedBinary(platform, arch) {
  try {
    const found = require.resolve(`${packageName(platform, arch)}/bin/${binaryFile(platform, arch)}`)
    return existsSync(found) ? found : null
  } catch {
    return null
  }
}
const require = createRequire(import.meta.url)

// disabled reports whether this environment asks the plugin not to start the
// proxy. The suite does not rely on it (withFetch sets testables.nativeFetch to
// null instead, which a dynamic import cannot race); it is for the tarball
// gate and for anyone who wants the plain fetch path on purpose.
export function disabled() {
  return process.env.CODAR_PLUGIN_DISABLE_NATIVE === "1"
}

// started caches the running proxy: one per plugin instance, started on the
// first official-host request. running is the object it resolved to, so a
// proxy that exits can be forgotten and the next request can start another.
// A start that failed is forgotten too, and no new one is attempted for the
// retry pause: one transient failure (a spawn error, the ready deadline, a
// machine waking from sleep) must not cost the session its transport, and a
// failing start must not be re-run on every request either.
let started
let running
let closing
let failedAt = 0
// failWhy is why the last start failed, in the words the caller is told: a
// build that exists but will not come up is a different report than a machine
// with no build at all, and the message is what a bug report quotes.
let failWhy = ""
// RETRY_MS is how long a failed start is remembered. CODAR_PROXY_RETRY_MS
// overrides it for the suite, which cannot wait out a real pause.
const RETRY_MS = 20 * 1000
const retryMs = () => (Number(process.env.CODAR_PROXY_RETRY_MS) > 0 ? Number(process.env.CODAR_PROXY_RETRY_MS) : RETRY_MS)
const retrying = () => failedAt > 0 && Date.now() - failedAt < retryMs()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The ordinary deaths each clean their own: the exit handler here removes
// the directory, the proxy removes the socket and ready file (and the
// directory, when it is empty) on its own way out. What none of them sees
// is the death that runs no handler: a host SIGKILLed while its proxy dies
// too, or a transient CLI host that ends between the ready write and an
// orderly close. One directory per such death, under the temp root,
// forever — a machine that runs this plugin a year carries a year of them.
// A start therefore sweeps: a directory under our prefix, old past the
// grace, owned by this user, answering on none of its addresses, is a dead
// proxy's shell and goes. A socket that accepts is a running proxy —
// another host process's own, possibly long-lived — and stays however old;
// a fresh directory is inside its start's window; a directory whose
// contents cannot be read is skipped rather than judged or crashed on.
const SWEEP_PREFIX = "codar-plugin-"
const SWEEP_GRACE_MS = 5 * 60 * 1000

// probeAnswering says whether one of a directory's addresses still accepts
// a connection: the ready file's own address first, then the socket path
// the Unix start uses. A connecting client sends nothing — a real proxy
// just drops the idle connection — so the probe disturbs nothing it
// answers.
const probeAnswering = async (dir) => {
  const targets = []
  try {
    const said = JSON.parse(readFileSync(join(dir, "ready.json"), "utf8"))
    if (said?.transport === "unix" && typeof said.address === "string") targets.push({ path: said.address })
    else if (said?.transport === "tcp" && typeof said.address === "string") {
      const cut = said.address.lastIndexOf(":")
      const port = Number(said.address.slice(cut + 1))
      if (Number.isInteger(port) && port > 0) targets.push({ host: said.address.slice(0, cut), port })
    }
  } catch {
    // no readable ready: the Unix layout still names its socket
  }
  if (process.platform !== "win32") targets.push({ path: join(dir, "proxy.sock") })
  for (const target of targets) {
    if ("path" in target && !existsSync(target.path)) continue
    if (await new Promise((resolve) => {
      const socket = connect(target)
      const done = (answer) => {
        socket.destroy()
        resolve(answer)
      }
      socket.setTimeout(150, () => done(false))
      socket.once("connect", () => done(true))
      socket.once("error", () => done(false))
      socket.once("close", () => done(false))
    })) return true
  }
  return false
}

export const sweepStaleDirs = async ({ root = tmpdir(), minAgeMs = SWEEP_GRACE_MS } = {}) => {
  const removed = []
  let names
  try {
    names = readdirSync(root)
  } catch {
    return removed
  }
  for (const name of names) {
    if (!name.startsWith(SWEEP_PREFIX)) continue
    const dir = join(root, name)
    try {
      const was = lstatSync(dir)
      if (!was.isDirectory()) continue
      if (typeof process.getuid === "function" && was.uid !== process.getuid()) continue
      if (Date.now() - was.mtimeMs < minAgeMs) continue
      try {
        readdirSync(dir) // unreadable to us, or someone else's shape: skip
      } catch {
        continue
      }
      if (await probeAnswering(dir)) continue
      rmSync(dir, { recursive: true, force: true })
      removed.push(dir)
    } catch {
      // one directory that resists (a race with its owner's own exit) is
      // next sweep's business, not a start's failure
    }
  }
  return removed
}

// startProxy spawns the binary and waits for its ready file.
async function startProxy() {
  failWhy = ""
  const bin = binaryPath()
  if (!existsSync(bin)) return null

  // A directory of this process's own (mkdtemp makes it 0700) holds both the
  // ready file and the socket. In the shared temp directory the ready name was
  // the only thing standing between another user on the machine and a file
  // this plugin would read as the listener's address — and that name is a pid
  // (public) plus eight characters of Math.random (not a CSPRNG). With the
  // directory, nobody else can create either file at all.
  let dir
  try {
    dir = mkdtempSync(join(tmpdir(), "codar-plugin-"))
  } catch {
    // no private directory means no socket to listen on; the request falls
    // back to the plain fetch, and the reason says so
    failWhy = "the proxy did not start (no private temp directory)"
    return null
  }
  // This start is the machine's chance to forget the deaths that ran no
  // handler (see the sweep's note): drop what is old, ours, and answering
  // nothing — never this fresh directory, never one a live proxy holds.
  sweepStaleDirs({ root: dirname(dir) }).catch(() => {})
  const readyPath = join(dir, "ready.json")
  const unix = process.platform !== "win32"
  const address = unix ? join(dir, "proxy.sock") : "127.0.0.1:0"
  const args = ["-listen", unix ? "unix" : "tcp", "-address", address, "-ready", readyPath]
  const child = spawn(bin, args, {
    cwd: dirname(bin),
    // The proxy stops when stdin closes: a host that ends never leaves it
    // behind, on top of the host reaping a plugin's children itself.
    stdio: ["pipe", "ignore", "ignore"],
    env: { ...process.env, CODAR_MODE: "desktop" },
    windowsHide: true,
  })
  child.unref()
  let exited = false
  child.on("exit", () => (exited = true))
  child.on("error", () => (exited = true))
  // A proxy that exits later is no proxy: forget it, so the next official-host
  // request starts a new one instead of talking to a socket nobody holds. A
  // crash must not silence the desktop transport for the rest of the session.
  // Its private directory goes with it — an exit no one asked for is exactly
  // the case closeProxy never sees, and a ready file left in the temp root
  // would accumulate one directory per crash.
  child.on("exit", () => {
    removeDir(dir)
    if (running?.child === child) {
      running = undefined
      started = undefined
    }
  })

  const deadline = Date.now() + 5000
  for (;;) {
    if (exited) {
      removeDir(dir)
      failWhy = "the proxy did not start (it exited before it was ready)"
      return null
    }
    if (existsSync(readyPath)) {
      try {
        const info = JSON.parse(readFileSync(readyPath, "utf8"))
        if (info && typeof info.address === "string" && info.address) {
          failWhy = ""
          return { child, readyPath, dir, info }
        }
      } catch {
        // written but not finished; try again
      }
    }
    if (Date.now() > deadline) {
      stopChild(child)
      removeDir(dir)
      failWhy = "the proxy did not start in time"
      return null
    }
    await sleep(20)
  }
}

function stopChild(child) {
  try {
    child.stdin?.destroy()
    child.kill()
  } catch {}
}

// removeDir drops a proxy's private directory and whatever is left in it.
function removeDir(dir) {
  if (!dir) return
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
}

// proxy returns the running proxy, or null when there is none.
export async function proxy() {
  if (disabled()) return null
  if (closing) return null
  if (retrying()) return null
  // The start is cached while it runs so concurrent requests share one. It is
  // dropped again when it fails (resolves null, or rejects): a resolved null
  // in `started` was a failure remembered for the process's life — the
  // desktop transport never came back after one bad spawn — and a rejected
  // promise in `started` re-threw the same error at every request for ever.
  // The identity check keeps a concurrent newer attempt from being cleared by
  // an older one finishing.
  if (!started) {
    const attempt = startProxy().then(
      (p) => {
        if (started === attempt) {
          running = p ?? undefined
          if (!p) {
            started = undefined
            failedAt = Date.now()
          }
        }
        return p
      },
      (e) => {
        if (started === attempt) {
          started = undefined
          failedAt = Date.now()
          failWhy ||= "the proxy did not start (the spawn failed)"
        }
        throw e
      },
    )
    started = attempt
  }
  return started
}

// closeProxy stops the proxy this module started. The host reaps it anyway;
// this is for tests and for a plugin instance shutting down early.
export async function closeProxy() {
  closing = true
  const p = await started?.catch?.(() => null)
  if (p) {
    stopChild(p.child)
    removeDir(p.dir)
  }
  started = undefined
  running = undefined
  failedAt = 0
  failWhy = ""
  // `closing` is what stops a dead proxy from being restarted over and over.
  // Here it was asked for, not suffered: the next request is entitled to a
  // proxy of its own, and a process that closes the transport and opens a new
  // one (a test, a plugin re-created by the host) must get one.
  closing = false
}

// unavailable is the error proxyFetch throws when it cannot answer: no
// proxy to talk to, or a URL that is not the vendor's. request() falls back
// to its own fetch on exactly this error and on nothing else.
const unavailable = (why) => {
  const e = new Error(`codar native transport unavailable: ${why}`)
  e.name = "NativeUnavailable"
  return e
}

// officialURL is the desktop's own test (electron/cloud-network.cjs in
// 0.3.13): https, no userinfo, no port, and a host on the four-host list. A
// URL that fails any of it is one the desktop sends through plain fetch, so
// it is not one this transport answers either.
export function officialURL(u) {
  return u.protocol === "https:" && !u.username && !u.password && !u.port && hosts.has(u.hostname.toLowerCase())
}

// proxyFetch sends url through the proxy. It throws NativeUnavailable when
// there is no proxy (no binary for this platform, it did not start), when
// url names a host the proxy would not forward, and when a socket that
// should exist refuses the connection twice (a proxy that died, and a
// replacement that did not come up). An answer from the proxy, even a
// refusal, is returned as is; retrying it with another transport would send
// the request twice.
export async function proxyFetch(url, init = {}) {
  let u
  try {
    u = new URL(url)
  } catch {
    throw unavailable("not a URL")
  }
  // fetch snapshots a body when it is called. The proxy may not be up yet —
  // starting it is the first await here — so copying in bodyBytes after that
  // await read bytes the caller had already reused. Take the copy now, before
  // anything is awaited, and hand the same request to the first try and the
  // retry. Only a byte body is writable; other encodings are fetch's to do.
  const sent = writable(init.body) && init.body != null ? { ...init, body: bodyBytes(init.body) } : init
  // The desktop's own officialURL (electron/cloud-network.cjs in 0.3.13):
  // https, no userinfo, no port, and a host on the four-host list.
  if (!officialURL(u)) throw unavailable(`not an official URL: ${u.hostname}`)
  let p
  try {
    p = await proxy()
  } catch {
    throw unavailable("the proxy did not start")
  }
  if (!p) {
    // Saying the binary is missing is not something to log on every request;
    // a node_modules install without a build simply takes the fetch path. A
    // build that is there and did not come up says that instead: the two have
    // different fixes, and "no platform package" sent a person reinstalling a
    // package they already had.
    throw unavailable(disabled() ? "disabled" : failWhy || "no platform package for this machine")
  }
  try {
    return await sendVia(p.info, u, sent)
  } catch (e) {
    if (e?.code !== "ECONNREFUSED" && e?.code !== "ENOENT") throw e
    // The socket refused, so the proxy died between its ready file and now.
    // A refused connect means no byte of the request went out: one restart is
    // safe, and it is the difference between a crash costing this request and
    // a crash costing the session the desktop transport.
    const again = await restartProxy(p)
    if (again) {
      try {
        return await sendVia(again.info, u, sent)
      } catch (e2) {
        if (e2?.code !== "ECONNREFUSED" && e2?.code !== "ENOENT") throw e2
      }
    }
    // A dead proxy whose replacement also refused is remembered for the retry
    // pause (by the start that failed, or here when the pause was already
    // running), not for ever: `closing = true` kept the whole session on the
    // plain fetch after one outage, and nothing calls closeProxy to undo it.
    // The reason is kept too, or a request arriving inside the pause would be
    // told the machine has no platform package.
    failedAt ||= Date.now()
    failWhy ||= "the proxy is not listening"
    throw unavailable("the proxy is not listening")
  }
}

// chatFetch is the transport a chat request takes: the same proxy the card's
// requests use, streaming, so a conversation to the gateway leaves with the
// desktop's TLS and HTTP shape rather than Bun's. It answers a fetch-shaped
// response — status, headers, a body the caller can iterate as it arrives.
//
// A URL the proxy does not carry (a provider the user re-pointed elsewhere, a
// platform without a binary, a proxy that did not start) falls back to the
// plugin's ordinary fetch: chat cannot be made to fail because the native
// transport is not there. The proxy's own options stay behind — the fallback
// is the ordinary fetch of guarded.mjs, which keeps the proxy's redirect rule
// — so the caller's signal, method, headers and body are the only things
// handed on (plus the transport's own two bounds, which an explicit caller may
// narrow or widen).
export async function chatFetch(url, init = {}) {
  const { stream, maxBytes, timeoutMs, body, ...rest } = init
  // sendVia writes a body as bytes; a body only fetch knows how to encode
  // (FormData, URLSearchParams, a readable stream, a Blob) is not a failure of
  // chat — it is a request this transport cannot carry, so the ordinary fetch
  // carries it instead of chat failing on a TypeError.
  if (!writable(body)) return guardedFetch(url, { ...rest, ...(body === undefined ? {} : { body }) })
  try {
    return await proxyFetch(url, {
      ...rest,
      ...(body === undefined ? {} : { body }),
      stream: stream !== false,
      ...(Number(maxBytes) > 0 ? { maxBytes: Number(maxBytes) } : {}),
      ...(Number(timeoutMs) > 0 ? { timeoutMs: Number(timeoutMs) } : {}),
    })
  } catch (e) {
    if (e?.name !== "NativeUnavailable") throw e
    return guardedFetch(url, { ...rest, ...(body === undefined ? {} : { body }) })
  }
}

// writable says whether sendVia can hand this body to the socket: nothing, a
// string, or bytes. Everything else is fetch's to encode.
const writable = (body) =>
  body == null || typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body)

// bodyBytes is a body as the bytes fetch would send. A view is taken from
// its own buffer at its own offset: Buffer.from(view) reads a DataView's
// single byte-length field as "no bytes" and a Uint16Array's string, so a
// DataView went out as an empty body and [0x1234] as "34" — neither is what
// fetch sends, and a caller that declared the body writable got the wrong
// request rather than a fallback. The bytes are copied here, not viewed: the
// socket writes them a turn later, and fetch snapshots a body at call time,
// so a caller that reuses its buffer right after the call must not change
// the request.
const bodyBytes = (body) =>
  typeof body === "string"
    ? Buffer.from(body, "utf8")
    : ArrayBuffer.isView(body)
      ? Buffer.from(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength))
      : Buffer.from(body.slice(0))

// restartProxy forgets a proxy that stopped listening and starts another.
// It answers the new one, or null when none came up.
async function restartProxy(dead) {
  if (running?.child === dead.child) {
    running = undefined
    started = undefined
  }
  // A proxy whose socket vanished may still be running: its exit was never
  // seen, so it is stopped here, or the plugin would leave a process behind
  // that closeProxy no longer knows about. A child that already exited takes
  // the same calls harmlessly.
  stopChild(dead.child)
  removeDir(dead.dir)
  const p = await proxy().catch(() => null)
  return p && p !== dead ? p : null
}

// sendVia is one HTTP/1.1 exchange over the proxy's socket. Exported for the
// suite, which drives it against a socket of its own instead of a spawned
// binary (the binary is tested where it is built, in native/go test).
//
// init.stream keeps the answer out of memory: a chat answer is an event
// stream the host reads as it arrives, so nothing is collected beyond what
// the caller asked for, and the size cap applies to what is buffered rather
// than to a total the stream never has to fit in.
export function sendVia(info, u, init) {
  const streaming = init.stream === true
  const method = (init.method || "GET").toUpperCase()
  const headers = new Headers(init.headers)
  const body = init.body == null ? null : bodyBytes(init.body)
  const maxBytes = Number(init.maxBytes) > 0 ? Number(init.maxBytes) : MAX_ANSWER_BYTES
  const lines = [`${method} ${u.pathname}${u.search} HTTP/1.1`, `Host: ${u.host}`]
  // The headers the proxy lets through, in the same list it enforces: a card
  // request has the first two, and a chat request brings the credential and
  // version its own SDK writes (X-Api-Key, Anthropic-Version for the Anthropic
  // models). Anything else the caller set is not the desktop's and is dropped
  // here rather than by the proxy, so what is written and what is forwarded
  // cannot drift apart.
  for (const name of FORWARDED) {
    const value = headers.get(name.toLowerCase())
    if (value) lines.push(`${name}: ${value}`)
  }
  if (info.token) lines.push(`X-Codar-Proxy-Token: ${info.token}`)
  if (body) lines.push(`Content-Length: ${body.byteLength}`)
  lines.push("Connection: close")
  const head = Buffer.from(lines.join("\r\n") + "\r\n\r\n", "utf8")

  return new Promise((resolve, reject) => {
    // A method is a token (RFC 9110): anything else would end the request
    // line early and let the rest of it read as headers.
    if (!/^[A-Z]+$/.test(method)) {
      const e = new TypeError("codar-proxy: bad method")
      reject(e)
      return
    }
    let socket
    try {
      if (info.transport === "tcp") {
        const { host, port } = parseAddress(info.address)
        socket = connect(port, host)
      } else {
        socket = connect(info.address)
      }
    } catch (e) {
      reject(e)
      return
    }
    // A connect that fails between here and the real handlers below (an
    // abort() before they are attached returns early) would otherwise be an
    // uncaught 'error' event, which ends the host process rather than this
    // request. The real handler is added later and fails the promise as usual.
    socket.on("error", () => {})
    let settled = false
    let buf = Buffer.alloc(0)
    let response
    let streamController
    // The deadline is declared here, before anything below can fail: abort()
    // runs before the connect below is wired, and cleanup() reads this name —
    // declaring it after the abort check made a pre-aborted signal throw
    // "Cannot access 'deadline' before initialization" instead of rejecting
    // with an AbortError.
    let deadline

    // The same refusal readAnswer gives in internal.mjs: one answer, one cap,
    // one message, whether it was stopped here or there.
    const answerTooLarge = () => {
      const cap = streaming ? STREAM_ANSWER_BYTES : maxBytes
      const e = new Error(cap >= 1024 * 1024 ? `厂商应答超过 ${cap / 1024 / 1024} MB，已放弃` : `厂商应答超过 ${cap} 字节，已放弃`)
      e.code = "answer_too_large"
      return e
    }

    const fail = (e) => {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      // A reader already holding the answer learns that it stopped from the
      // stream itself: resolving first and then rejecting would be a promise
      // settled twice, and the error would be lost.
      try {
        streamController?.error(e)
      } catch {}
      reject(e)
    }
    const abort = () => {
      const e = new Error("aborted")
      e.name = "AbortError"
      fail(e)
    }
    const cleanup = () => {
      if (deadline) clearTimeout(deadline)
      init.signal?.removeEventListener?.("abort", abort)
    }
    if (init.signal?.aborted) return abort()
    init.signal?.addEventListener?.("abort", abort)
    // The deadline covers silence, not the whole exchange: a stream that keeps
    // arriving is alive even when it has run for longer than a short answer
    // ever would. It starts at the short bound (waiting for a head) and
    // switches to the long one once the answer has begun.
    const waitMs = Number(init.timeoutMs) > 0 ? Number(init.timeoutMs) : NO_ANSWER_MS
    const idleMs = streaming ? STREAM_IDLE_MS : waitMs
    let armed = waitMs
    const touch = () => {
      if (settled || !deadline) return
      clearTimeout(deadline)
      deadline = setTimeout(onTimeout, armed)
    }
    const onTimeout = () => {
      const e = new Error("codar-proxy: no answer in time")
      e.code = "no_answer"
      fail(e)
    }
    deadline = setTimeout(onTimeout, armed)

    const bodyText = []
    let total = 0
    const cap = streaming ? STREAM_ANSWER_BYTES : maxBytes
    const emit = (chunk) => {
      if (!chunk?.byteLength) return
      total += chunk.byteLength
      if (total > cap) throw answerTooLarge()
      if (!streaming) bodyText.push(chunk)
      // An answer that keeps arriving is an answer, however long it runs: the
      // deadline is for silence, and every byte pushes it forward.
      touch()
      try {
        // A view, not a copy: the bytes belong to this reader, and copying
        // every frame of a stream only to hand it on doubles what it costs.
        streamController?.enqueue(
          streaming ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) : new Uint8Array(chunk),
        )
      } catch {}
      // Backpressure: a reader that stopped reading stops the vendor too.
      // Without this the socket would keep reading and the queue would grow
      // with the whole answer, which is the buffering streaming exists to
      // avoid.
      if (streaming && streamController?.desiredSize <= 0) socket?.pause()
    }
    const stream = new ReadableStream({
      start(controller) {
        streamController = controller
      },
      pull() {
        if (settled) return
        // Bytes held over from the last read go before the socket is asked
        // for more, or a paused reader would resume into an empty buffer and
        // the held bytes would wait for the next packet that never comes.
        if (buf.length) {
          try {
            feed(Buffer.alloc(0))
          } catch (e) {
            fail(e)
            return
          }
        }
        if (!settled && streamController.desiredSize > 0) socket?.resume()
      },
      cancel() {
        // The reader is done with this answer: the vendor should be too.
        try {
          socket?.destroy()
        } catch {}
      },
    })
    // ready hands the response over once, as soon as it is meaningful: at the
    // head for a stream, at the end for a buffered answer.
    let headResolved = false
    const ready = () => {
      if (headResolved) return
      headResolved = true
      resolve(response)
    }
    const done = () => {
      if (settled) return
      settled = true
      cleanup()
      // The answer is complete; nothing more is wanted on this connection.
      // Without this the socket lives until the far side closes it, and a peer
      // that keeps the connection open (anything not honoring Connection:
      // close) leaves it open for as long as it likes.
      socket.destroy()
      try {
        streamController?.close()
      } catch {}
      ready()
    }

    let framing = null // { left } | { chunked } | { close }
    let chunkLeft = 0
    let chunkPad = 0
    let chunkEnded = false

    // feed reads the bytes that have arrived. It is not re-entrant: enqueueing
    // into the stream can run the reader's pull straight away (a read that was
    // waiting is fulfilled as the chunk is queued), and a pull that fed the
    // same buffer again would read those bytes twice. A re-entrant call is
    // dropped, which is right: the loop that is already running still holds
    // the buffer and will carry on with it.
    let feeding = false
    const feed = (chunk) => {
      if (feeding) return
      feeding = true
      try {
        swallow(chunk)
      } finally {
        feeding = false
      }
    }
    const swallow = (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
      // A 1xx answer is interim, not the answer: the final head follows on the
      // same connection (100 Continue, 103 Early Hints). Taking it as the
      // answer returned status 100 with an empty body and threw the real one
      // away, so interim heads are read and discarded here.
      while (!response) {
        const end = buf.indexOf("\r\n\r\n")
        if (end < 0) {
          if (buf.length > 65536) fail(new Error("codar-proxy: response head too large"))
          return
        }
        // The same cap when the delimiter did arrive in the same read: the
        // guard above only bounds a head that has not ended yet, and a peer
        // that sends one 70 KB header block in a single write went past it.
        if (end > 65536) return fail(new Error("codar-proxy: response head too large"))
        const headText = buf.subarray(0, end).toString("latin1")
        buf = buf.subarray(end + 4)
        const parsed = parseHead(headText)
        if (!parsed) return fail(new Error("codar-proxy: bad response head"))
        // 101 is a protocol switch this client never asked for: no final head
        // is coming, and reading on would take the new protocol's bytes for
        // HTTP framing.
        if (parsed.status === 101) return fail(new Error("codar-proxy: unexpected 101"))
        if (parsed.status < 200) continue
        response = parsed
        const encoded = parsed.headers.get("transfer-encoding") || ""
        const length = parsed.headers.get("content-length")
        // 1xx, 204 and 304 never carry a body, whatever a header says: Go's
        // server stops after the head, and waiting for a body would hold the
        // request to its deadline. A HEAD answer is the same — its headers are
        // the GET's, a Transfer-Encoding among them included — so this is read
        // before the framing: taken as chunked, a bodiless answer returned the
        // "body" of a response that has none, or waited for a terminal chunk
        // that was never coming and died at its deadline.
        const bodiless = parsed.status >= 100 && parsed.status < 200 || parsed.status === 204 || parsed.status === 304 || method === "HEAD"
        // A length that is not a number is not a length: read as
        // close-delimited it would wait for a hang-up that never comes. Only
        // a body-carrying answer's length is framing, though: on a 304 the
        // header describes the representation, and a bodiless answer is
        // framed by its head alone.
        if (!bodiless && length !== null && !/^\d+$/.test(length.trim())) return fail(new Error("codar-proxy: bad content-length"))
        framing = bodiless
          ? { left: 0 }
          : encoded.toLowerCase().includes("chunked")
            ? { chunked: true }
            : length !== null
              ? { left: Number(length) }
              : { close: true }
        response.body = stream
        // A buffered answer can be read again as text; a streamed one was
        // never kept, and answering "" for it would look like an empty answer
        // rather than a body that went to the reader. A refusal is the
        // exception: an error body is a short JSON document whatever the
        // request asked for, and a caller that reads it with text()/json()
        // (the host does, to quote the vendor's own sentence) must not be
        // told the answer was streamed instead.
        const refused = parsed.status >= 400
        response.text = streaming && !refused
          ? async () => {
              throw new Error("codar-proxy: the answer was streamed")
            }
          : async () => {
              if (streaming) {
                // The refusal body is a short document and text() is a caller
                // waiting on it: it is held to the caller's own bound rather
                // than to the stream's idle one, so a head that named a body
                // and never sent it ends here instead of five minutes later.
                armed = waitMs
                touch()
                return (await readAll(stream)).toString("utf8")
              }
              return Buffer.concat(bodyText).toString("utf8")
            }
        // json() is what most callers of an error answer reach for; fetch
        // answers one on every Response, so this one does too.
        response.json = async () => JSON.parse(await response.text())
        // The head has arrived, so the short wait is over and from here the
        // deadline measures silence.
        armed = idleMs
        touch()
        // A streamed answer is handed over now, with its body still filling:
        // that is what streaming means, and waiting for the last chunk would
        // hand back the whole answer at once. A buffered answer resolves when
        // it is complete, so that text() has all of it.
        if (streaming) ready()
        // A stated length past the cap is refused before a byte of it is read.
        // The cap the stream itself is held to (cap), not the buffered one:
        // a stated length is checked against the same bound that governs the
        // body it describes, or a 9 MiB event stream would be refused with a
        // message about the 64 MiB bound it never reached.
        if (typeof framing.left === "number" && framing.left > cap) return fail(answerTooLarge())
        if (framing.left === 0) return done()
        break
      }
      if (framing.chunked) {
        // chunk-size CRLF, data, CRLF, ..., 0 CRLF, trailers, blank line.
        // Every boundary can fall between two reads, so the state says how
        // many data bytes and how many trailing bytes are still owed.
        for (;;) {
          if (chunkEnded) {
            const end = buf.indexOf("\r\n")
            // trailer lines are a few dozen bytes; a peer that never sends the
            // blank line must not be able to grow this buffer without bound
            if (end < 0) {
              if (buf.length > 65536) return fail(new Error("codar-proxy: bad chunk"))
              return
            }
            buf = buf.subarray(end + 2)
            if (end === 0) return done()
            continue
          }
          if (chunkLeft === 0 && chunkPad === 0) {
            const lineEnd = buf.indexOf("\r\n")
            if (lineEnd < 0) {
              // same cap as the response head: a size line that never ends is
              // not a size line
              if (buf.length > 65536) return fail(new Error("codar-proxy: bad chunk"))
              return
            }
            const line = buf.subarray(0, lineEnd).toString("latin1")
            buf = buf.subarray(lineEnd + 2)
            // RFC 9112 chunk-size: hex digits, then an optional extension.
            // parseInt alone takes "-1" and "1x", and a negative size made
            // this loop neither consume nor return: a synchronous hang.
            const sizeText = line.split(";", 1)[0].trim()
            if (!/^[0-9a-fA-F]+$/.test(sizeText)) return fail(new Error("codar-proxy: bad chunk size"))
            const size = parseInt(sizeText, 16)
            if (!Number.isSafeInteger(size)) return fail(new Error("codar-proxy: bad chunk size"))
            if (size === 0) {
              chunkEnded = true
              continue
            }
            // One chunk larger than the whole cap is an answer past the cap.
            if (size > cap) return fail(answerTooLarge())
            chunkLeft = size
            chunkPad = 2
          }
          if (chunkLeft > 0) {
            const take = Math.min(chunkLeft, buf.length)
            if (take) {
              emit(buf.subarray(0, take))
              chunkLeft -= take
              buf = buf.subarray(take)
            }
            if (chunkLeft > 0) return
          }
          // Between chunks the wire carries exactly CRLF (RFC 9112 §7.1), and
          // the two bytes are checked one at a time: the boundary can fall
          // between two reads, so chunkPad counts what is still owed. Skipping
          // them unread took any two bytes for the delimiter, and a peer that
          // wrote something else had its bytes read as the next size line.
          if (chunkPad > 0) {
            while (chunkPad > 0) {
              if (buf.length === 0) return
              if (buf[0] !== (chunkPad === 2 ? 0x0d : 0x0a)) return fail(new Error("codar-proxy: bad chunk delimiter"))
              buf = buf.subarray(1)
              chunkPad -= 1
            }
          }
        }
      }
      if (typeof framing.left === "number") {
        const take = Math.min(framing.left, buf.length)
        emit(buf.subarray(0, take))
        framing.left -= take
        buf = buf.subarray(take)
        if (framing.left === 0) done()
        return
      }
      // no stated length: whatever arrives is the body, until the socket closes
      emit(buf)
      buf = Buffer.alloc(0)
    }

    socket.on("connect", () => {
      if (body) socket.write(Buffer.concat([head, body]))
      else socket.write(head)
    })
    socket.on("data", (d) => {
      try {
        feed(d)
      } catch (e) {
        fail(e)
      }
    })
    socket.on("error", (e) => fail(e))
    socket.on("close", () => {
      if (response && framing?.close) done()
      else if (!settled) fail(new Error("codar-proxy: connection closed before the answer"))
    })
  })
}


// readAll drains a stream into one buffer. It is only used for a refusal's
// body (a short JSON document) and is capped the same way the buffered path
// is: a peer that answers an error with a huge stream must not be able to grow
// it without bound.
async function readAll(stream, cap = MAX_ANSWER_BYTES) {
  const reader = stream.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value?.byteLength) continue
    total += value.byteLength
    if (total > cap) {
      try {
        await reader.cancel()
      } catch {}
      throw new Error(`codar-proxy: the refusal body is past ${cap} bytes`)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

function parseHead(text) {
  const lines = text.split("\r\n")
  const m = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines[0] || "")
  if (!m) return null
  const headers = new Map()
  for (const line of lines.slice(1)) {
    const i = line.indexOf(":")
    if (i <= 0) continue
    const name = line.slice(0, i).trim().toLowerCase()
    const value = line.slice(i + 1).trim()
    headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value)
  }
  const status = Number(m[1])
  // The third argument fetch hands forEach is the Headers itself, so a caller
  // that reads the collection inside the callback (`all.get(name)`) works the
  // same here; `shim` is that object, filled in below.
  const shim = {
    get: (name) => headers.get(String(name).toLowerCase()) ?? null,
    has: (name) => headers.has(String(name).toLowerCase()),
    forEach: (cb, thisArg) => {
      for (const [name, value] of headers) cb.call(thisArg, value, name, shim)
    },
    entries: () => headers.entries(),
    [Symbol.iterator]: () => headers.entries(),
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: m[2] || "",
    headers: shim,
  }
}

function parseAddress(address) {
  // "[::1]:8080" is host and port around a bracketed host; a bare IPv6
  // address has no port and is not something the ready file writes.
  const close = address.lastIndexOf("]")
  if (address.startsWith("[") && close > 0) {
    return { host: address.slice(1, close), port: Number(address.slice(close + 2)) }
  }
  const i = address.lastIndexOf(":")
  return i < 0 ? { host: address, port: NaN } : { host: address.slice(0, i), port: Number(address.slice(i + 1)) }
}
