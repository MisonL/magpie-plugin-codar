// guarded.mjs: the ordinary fetch the plugin falls back on, without the hop
// its proxy refuses.
//
// The plugin reaches the vendor two ways: through the Go proxy, whose client
// follows a redirect only on the host and port the request started on
// (native/cmd/codar-proxy/main.go, checkRedirect), and through the ordinary
// fetch it falls back on where there is no proxy — no build for the platform,
// a proxy that did not start. Only the first was guarded. fetch follows any
// Location and carries the headers it was given, and the plugin writes the
// account's credential into Authorization (or X-Api-Key) on every request, so
// a redirect from an address to a second host took that credential there. A
// synthetic sink received it on 2026-08-16.
//
// guardedFetch is fetch with the proxy's rule: a redirect off the origin the
// request started on is not followed, and is returned to the caller as the
// answer it is — the same shape, so a refusal still reads as a refusal. The
// origin includes the port, so another port on the vendor's own name is another
// service and is refused too. At most four hops, as the proxy allows. A body
// that cannot be sent twice (a stream, a FormData fetch would encode again)
// stops at the redirect: re-sending it would send a request that is not the
// one the caller made. A string or bytes body is sent again as it was.
//
// Every request goes through a transport: the runtime's fetch unless a test
// names its own. The guarded fetch never lets fetch choose a hop: each request
// carries the manual redirect mode, the hops the rule allows are sent one at a
// time, and any other redirect is the answer.
//
// The runtime's fetch (runtimeTransport) is where the guard ends. Node 24.22.1
// answered a 302 with the hop it followed for some calls to fetch made inside
// a function, depending on statements elsewhere in it; the shape it answered
// as an answer there is the one below, and a Request carries the mode whatever
// the code around the call. The tests name their own transport over loopback,
// where the rule itself is pinned; the runtime's fetch is not asked to prove
// itself, and a test does not pin what a runtime decides to do with a Request.

// four is the proxy's own line: its checkRedirect refuses when five requests
// were already made (main.go), which is four hops past the first. Allowing a
// fifth hop would send one more request than the proxy ever would — the drift
// this module exists to close.
const MAX_HOPS = 4

// A string or bytes body is the same request however often it is sent. A body
// a caller handed over once (a stream, a FormData fetch would encode again)
// is not, and a hop is not taken for it.
const replayable = (body) => body == null || typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body)

export const guardedFetch = (url, init = {}, options = {}) => {
  // The address is taken as fetch takes one: a string, a URL or a Request. A
  // Request keeps its own method, headers and body — and its address is what
  // is sent, with the parts it wrote as the init: the URL alone would send a
  // request without its method, its headers and its body.
  const taken = take(url, init)
  const origin = originOfAddress(options.origin ?? taken.url)
  // An http(s) origin is held to the rule — https for the vendor's own
  // addresses, http because a user may write a plain-http chat base (a local
  // gateway on a loopback port) and that request carries their key: handing
  // http to the transport with the caller's mode was a path where a redirect
  // took the credential off its origin. Anything else — an address fetch
  // cannot resolve, a scheme that is not http(s) — is the caller's own, and
  // fetch answers its own error for it. `origin` is the test's own origin,
  // `transport` the test's own fetch (see the note above): the plugin sets
  // neither.
  if (origin === null) return (options.transport ?? runtimeTransport)(taken.url, taken.init)
  return follow(taken.url, taken.init, { ...options, origin })
}

// take is the address and init fetch would send: a string or a URL with the
// init as given, a Request as the Request itself holds them. Init overrides
// the Request only where it states a value, as fetch does.
const take = (url, init) => {
  if (!(url instanceof Request)) return { url: String(url), init }
  // A Request's own method, headers and body, and the init's where it states
  // them, as fetch takes one. Building a Request from a Request reads its
  // body, so the body is taken here, once: the bytes where the Request holds
  // bytes, and its stream where it does not (a stream body is sent once, as
  // given, and a hop is not taken for it).
  const said = new Request(url)
  const wrote = (k) => Object.hasOwn(init, k) && init[k] !== undefined
  // An init that states headers states the whole collection: fetch replaces
  // the Request's, it does not merge. Merging kept an Authorization the
  // caller meant to drop, and an Accept it never wrote.
  const headers = wrote("headers") ? new Headers(init.headers) : new Headers(said.headers)
  const body = wrote("body") ? init.body : said.body ?? undefined
  const signal = wrote("signal") ? init.signal : said.signal
  const sends = { ...(signal ? { signal } : {}), ...(body === undefined ? {} : { body }) }
  return { url: said.url, init: { method: wrote("method") ? init.method : said.method, headers, ...sends } }
}

// runtimeTransport is the runtime's fetch, given the request as a Request so
// the redirect mode is the one the request was built with.
const runtimeTransport = (url, init) => fetch(new Request(url, init))

// originOfAddress is the serialized origin of an http(s) address, or null
// when its scheme is not one (compared after URL parsing, which reads the
// case of a scheme the way a browser does: HTTPS: is https:) or the address
// itself is not one fetch could resolve. An address fetch cannot parse is
// not guarded either: fetch answers its own TypeError.
const originOfAddress = (address) => {
  try {
    const parsed = new URL(address)
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null
  } catch {
    return null
  }
}

// follow is the rule: the first answer, then a hop only to the origin the
// request started on, and only for a body that can be sent again. It is a
// chain of answers: hopOn is given each one and starts the request that
// follows it, over the caller's transport or the runtime's. A bytes body is
// taken once, before the first request, so a caller changing its array while
// the first answer is pending cannot change what a later hop carries.
const follow = (url, init, options) => {
  const once = snapshot(init)
  return hopOn({ at: url, hops: 0, init: once, options, res: (options.transport ?? runtimeTransport)(url, requestOf(once, once.body, once.method)) })
}

// hopOn hands the answer it is given to the step that reads it. That step
// (inHopOf) is the whole of the decision, written in one expression each: the
// note at the top says what that protects.
const hopOn = (s) => s.res.then((res) => inHopOf(s, res))

const inHopOf = (s, res) => res.status >= 300 && res.status < 400 && s.hops < MAX_HOPS
  ? inHop(s, res, hopOf(s.options.origin, s.at, res.headers.get("location")))
  : s.res

// inHop sends the hop as fetch sends one. A 303 asks the Location for a GET
// with no body, unless the request was already a GET or a HEAD; a 301 or a
// 302 does that only after a POST (fetch leaves every other method alone).
// 307 and 308 keep the method and the body, and a body that cannot be sent
// twice stops at the redirect. The redirect's own body is not the answer, so
// it is cancelled rather than left for a connection to hold.
const inHop = (s, res, next) => next === null || !(turnOf(res.status, s.init.method) || replayable(s.init.body))
  ? s.res
  : hopOn({
    ...s,
    at: next,
    hops: s.hops + 1,
    init: turnOf(res.status, s.init.method) ? getOf(s.init) : s.init,
    res: cancelBody(res) && (s.options.transport ?? runtimeTransport)(next, turnOf(res.status, s.init.method) ? getOf(s.init) : requestOf(s.init, s.init.body, s.init.method)),
  })

// turnOf says whether a redirect asks for a GET with no body, as fetch reads
// it: a 303 unless the request was a GET or a HEAD, and a 301 or 302 after a
// POST only.
const turnOf = (status, method) => {
  const m = String(method ?? "GET").toUpperCase()
  return (status === 303 && m !== "GET" && m !== "HEAD") || ((status === 301 || status === 302) && m === "POST")
}

// cancelBody cancels the redirect's own body. The cancellation is queued
// before the hop's request, so a transport that reads the cancelled stream
// sees it cancelled rather than locked; it answers true either way.
const cancelBody = (res) => {
  try {
    res.body?.cancel?.().catch(() => {})
  } catch {}
  return true
}

// requestOf is the init as it is sent, with the manual redirect mode. A body
// read from a Request is a stream, and the Request constructor refuses a
// stream body without duplex.
const requestOf = (init, body, method) => ({
  ...init,
  ...(body === undefined ? {} : { body }),
  method,
  redirect: "manual",
  ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
})

// getOf is the init a hop to a GET asks with: no body, and none of the
// headers that describe a body. Fetch removes the same set — a length, a
// type, a content encoding, language or location — for a request that no
// longer has one.
const BODY_HEADERS = ["content-length", "content-type", "content-encoding", "content-language", "content-location"]
const getOf = ({ body: _b, duplex: _d, ...init }) => {
  const headers = new Headers(init.headers)
  for (const h of BODY_HEADERS) headers.delete(h)
  return { ...init, headers, method: "GET", redirect: "manual" }
}

// snapshot is the init with a bytes body copied: an ArrayBuffer and a Buffer
// both share their memory with the caller, and a DataView has no slice, so
// every bytes body is copied through a Uint8Array over the view's own bytes.
const snapshot = (init) => {
  const body = init.body
  if (body == null || typeof body === "string") return init
  if (body instanceof ArrayBuffer) return { ...init, body: body.slice(0) }
  if (!ArrayBuffer.isView(body)) return init
  return { ...init, body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice() }
}

// hopOf is the address of the one hop a redirect away from current may take,
// or null when it may not be taken. The origin is where the request started,
// port included, so another port on the vendor's own name is another service;
// a Location that only closes a fragment, or resolves back to the request
// itself, is not a new request. A Location that writes a user in its
// authority is no hop either: the origin ignores userinfo, so the URL parser
// reads "https://someone@vendor" as the vendor, and the request would carry
// whatever that user name means in a cookie or a credential store.
export const hopOf = (origin, current, location) => {
  const absolute = location == null ? null : safeURL(location, current)
  const base = safeURL(current, current)
  const here = absolute !== null && base !== null && absolute.pathname === base.pathname && absolute.search === base.search
  const same = absolute !== null && base !== null && absolute.origin === base.origin
  const named = absolute !== null && (absolute.username !== "" || absolute.password !== "")
  return here || !same || named || base.origin !== origin ? null : absolute.href
}

const safeURL = (location, current) => {
  try {
    return new URL(location, current)
  } catch {
    return null
  }
}
