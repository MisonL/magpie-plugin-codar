// The plugin's fallback transport carries the proxy's redirect rule.
//
// The plugin reaches the vendor through its Go proxy when it can, and through
// an ordinary fetch when it cannot (no build for the platform, a proxy that did
// not start). The proxy returns a redirect that leaves the request's own
// origin; plain fetch followed it, headers and credential included, to any
// host a Location named. These pin the guarded fetch that closes that.
//
// The rule is written over https addresses and a test cannot speak https to a
// loopback server without a certificate, so the guarded fetch takes the
// transport it sends through (and the origin it keeps). Requests here are
// answered from a plan, not a socket, for the same reason and so that each
// test sends exactly the requests it means to.

import assert from "node:assert/strict"
import { createServer } from "node:http"
import { test } from "node:test"

import { guardedFetch, hopOf } from "../lib/guarded.mjs"

const vendor = "https://api.claw.speedai.com"

// planned is a transport that answers every request as a 302 to the address
// the test names from the one it was given, and records every request the rule
// sent.
const nextId = (url) => `/chain?n=${Number(new URL(url).searchParams.get("n") ?? "0") + 1}`
const planned = (next) => {
  const asked = []
  const transport = (url, init) => {
    asked.push({ url: String(url), redirected: init?.redirect })
    return Promise.resolve(new Response(null, { status: 302, headers: { location: next(String(url)) } }))
  }
  return { transport, asked }
}

test("a redirect off the origin is returned, not followed", async () => {
  const { transport, asked } = planned(() => "https://evil.example/collect")
  const res = await guardedFetch(`${vendor}/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer SYNTH" }, body: "{}" }, { transport })
  assert.equal(res.status, 302, "the redirect is the answer, not a followed hop")
  assert.deepEqual(asked.map((a) => a.url), [`${vendor}/v1/chat/completions`], "only the request the caller made was sent, with its credential")
  assert.equal(asked[0].redirected, "manual", "the request carried the manual redirect mode")
})

test("the chain stops where the proxy's own checkRedirect stops", async () => {
  // main.go refuses when five requests were already made — four hops past
  // the first — and this module's rule must answer at the same request, not
  // one more: the fallback exists to send what the proxy would send.
  const { transport, asked } = planned(nextId)
  const res = await guardedFetch(`${vendor}/chain?n=0`, {}, { transport })
  assert.equal(res.status, 302, "the redirect after the fourth hop is the answer the caller gets")
  assert.equal(asked.length, 5, "four hops, five requests: the first plus what Go's via list holds when it refuses")
  assert.deepEqual(asked.map((a) => a.url), [0, 1, 2, 3, 4].map((n) => `${vendor}/chain?n=${n}`))
})

test("a redirect is read on its own, and a hop off the origin is not taken", async () => {
  // The rule's steps in the order it takes them: an answer that is a redirect
  // is read for its Location, and a Location off the origin is the answer the
  // caller gets. (Which Locations are hops is pinned by hopOf, last test.)
  const { transport, asked } = planned(nextId)
  const res = await guardedFetch(`${vendor}/chain?n=0`, { redirect: "manual" }, { transport, origin: "https://elsewhere.example" })
  assert.equal(asked.length, 1, "neither the stack nor the plan sends a second request")
  assert.equal(res.status, 302)
})

test("a hop that leaves https is not taken", async () => {
  const { transport, asked } = planned((url) => url.replace("https:", "http:").replace("/chain", "/plain"))
  const res = await guardedFetch(`${vendor}/chain`, {}, { transport })
  assert.equal(asked.length, 1, "a downgrade is a different origin")
  assert.equal(res.status, 302)
})

test("a body that cannot be sent twice stops at the redirect", async () => {
  // A one-shot body is read by the request that carries it. The transport reads
  // it here; if the rule sent a hop with the spent stream, that would throw.
  // The redirect is a 307 — a 302 after a POST asks for a GET, which carries
  // no body and needs no replay (the next test pins that).
  const asked = []
  const transport = async (url, init) => {
    asked.push(String(url))
    await new Response(init?.body).arrayBuffer()
    return new Response(null, { status: 307, headers: { location: nextId(String(url)) } })
  }
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close() } })
  const res = await guardedFetch(`${vendor}/chain?n=0`, { method: "POST", body, duplex: "half" }, { transport })
  assert.equal(res.status, 307)
  assert.equal(asked.length, 1, "a body sent once is not sent twice")
})

test("the request the rule sends on its own is the caller's", async () => {
  // Through the runtime's own transport (the default) the request is sent as a
  // Request, which carries the manual redirect mode. Node 24.22.1 was measured
  // answering one such call with the hop it followed (see the note at the top
  // of guarded.mjs), so this pins the request the rule builds, not what a
  // runtime does with it.
  const seen = []
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ""}`)
    res.end("ok")
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const base = `http://127.0.0.1:${server.address().port}`
    const res = await guardedFetch(`${base}/v1/models`, { headers: { authorization: "Bearer SYNTH" } }, { origin: base })
    assert.equal(await res.text(), "ok")
    assert.deepEqual(seen, ["GET /v1/models Bearer SYNTH"])
  } finally {
    server.close()
  }
})

test("a Location on the request's own origin is a hop", async () => {
  // The origin the rule keeps is the request's own: relative Locations are
  // resolved against the address it was sent to, and the hop goes to the
  // same host and port.
  const seen = []
  const transport = (url, init) => {
    seen.push({ url: String(url), method: init?.method, redirected: init?.redirect })
    const next = String(url).endsWith("/v1/models") ? null : "/v1/models"
    return Promise.resolve(next === null ? new Response(null, { status: 200 }) : new Response(null, { status: 302, headers: { location: next } }))
  }
  const res = await guardedFetch(`${vendor}/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer SYNTH" }, body: "{}" }, { transport })
  assert.equal(res.status, 200)
  assert.deepEqual(seen, [
    { url: `${vendor}/v1/chat/completions`, method: "POST", redirected: "manual" },
    { url: `${vendor}/v1/models`, method: "GET", redirected: "manual" },
  ], "a 302 after a POST is asked for with a GET, as fetch asks it")
})

test("a scheme written in another case is https", async () => {
  // URL parsing reads the case of a scheme the way a browser does.
  const { transport, asked } = planned(() => `${vendor}/v1/models`)
  await guardedFetch(`HTTPS://api.claw.speedai.com/v1/chat/completions`, {}, { transport })
  assert.equal(asked[0].redirected, "manual", "an upper-case https address went out unguarded")
})

test("a URL or a Request is an address like a string", async () => {
  // The loader's fetch is handed whatever the host hands it, and fetch takes
  // all three.
  const { transport, asked } = planned(() => `${vendor}/v1/models`)
  const fromUrl = await guardedFetch(new URL(`${vendor}/v1/chat/completions`), {}, { transport })
  assert.equal(fromUrl.status, 302)
  const fromRequest = await guardedFetch(new Request(`${vendor}/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer SYNTH" }, body: "{}" }), {}, { transport })
  assert.equal(fromRequest.status, 302)
  assert.deepEqual(asked.filter((a) => a.url === `${vendor}/v1/chat/completions`).length, 2, "neither address was sent")
})

test("fetch's own method rules decide what a redirect asks for", async () => {
  // A 303 asks for a GET unless the request was a GET or a HEAD; a 301/302
  // does that only after a POST (a PUT stays a PUT); 307/308 keep everything.
  // The hop to a GET carries none of the headers the body brought.
  const hop = async (method, status) => {
    const seen = []
    const transport = async (url, init) => {
      const headers = new Headers(init.headers ?? {})
      seen.push({ method: init.method, type: headers.get("content-type"), body: init.body === undefined ? "none" : await new Response(init.body).text() })
      return seen.length === 1 ? new Response(null, { status, headers: { location: "/next" } }) : new Response("ok")
    }
    const body = method === "GET" || method === "HEAD" ? undefined : "{}"
    const res = await guardedFetch(`${vendor}/start`, { method, headers: { "content-type": "application/json", "x-keep": "1" }, ...(body === undefined ? {} : { body }) }, { transport })
    assert.equal(res.status, 200)
    return seen
  }
  assert.deepEqual((await hop("POST", 303)).map((s) => [s.method, s.type]), [["POST", "application/json"], ["GET", null]], "a 303 after a POST is a GET with no body headers")
  // Every header that describes a body goes with it, as fetch removes them.
  const encoded = []
  const transport = (url, init) => {
    const h = new Headers(init.headers)
    encoded.push({ ce: h.get("content-encoding"), cl: h.get("content-language"), ctype: h.get("content-type"), keep: h.get("x-keep") })
    return Promise.resolve(encoded.length === 1 ? new Response(null, { status: 303, headers: { location: "/next" } }) : new Response("ok"))
  }
  await guardedFetch(`${vendor}/start`, { method: "POST", headers: { "content-encoding": "gzip", "content-language": "en", "content-type": "application/json", "x-keep": "1" }, body: "{}" }, { transport })
  assert.deepEqual(encoded[1], { ce: null, cl: null, ctype: null, keep: "1" }, "a compressed, typed body leaves none of its headers on the GET")
  assert.deepEqual((await hop("HEAD", 303)).map((s) => s.method), ["HEAD", "HEAD"], "a 303 after a HEAD stays a HEAD")
  assert.deepEqual((await hop("PUT", 301)).map((s) => s.method), ["PUT", "PUT"], "a 301 after a PUT stays a PUT")
  assert.deepEqual((await hop("PUT", 302)).map((s) => s.method), ["PUT", "PUT"], "a 302 after a PUT stays a PUT")
  assert.deepEqual((await hop("POST", 307)).map((s) => [s.method, s.body]), [["POST", "{}"], ["POST", "{}"]], "a 307 re-sends the POST")
})

test("a Request handed to guardedFetch is sent with what it holds, and the init's where it states it", async () => {
  // fetch replaces the header collection when the init has one and keeps the
  // init's signal when it has one; the body read from a Request is a stream,
  // and a stream request is only built with duplex.
  const seen = []
  const controller = new AbortController()
  const transport = (url, init) => {
    const headers = new Headers(init.headers)
    seen.push({ authorization: headers.get("authorization"), accept: headers.get("accept"), signal: init.signal === controller.signal, builds: (() => { try { new Request(url, init); return true } catch { return false } })() })
    return Promise.resolve(new Response("ok"))
  }
  const fromRequest = new Request(`${vendor}/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer SYNTH", "x-keep": "1" }, body: "{}" })
  await guardedFetch(fromRequest, { headers: { accept: "application/json" }, signal: controller.signal }, { transport })
  assert.deepEqual(seen, [{ authorization: null, accept: "application/json", signal: true, builds: true }], "the init's headers replace the Request's, its signal is used, and the stream body builds")
})

test("a bytes body is sent as it was when the call began", async () => {
  // The bytes are taken once: changing the array afterwards changes nothing.
  // The hop is a 307, which keeps the body (a 302 after a POST asks for a GET).
  const body = new Uint8Array([123, 125])
  const sent = []
  const transport = (url, init) => {
    sent.push([...init.body])
    body[0] = 91
    return Promise.resolve(new Response(null, { status: 307, headers: { location: `${vendor}/next` } }))
  }
  await guardedFetch(`${vendor}/start`, { method: "POST", body }, { transport })
  assert.deepEqual(sent, [[123, 125], [123, 125]])
})

test("a Request handed in is sent as it was written", async () => {
  // fetch takes a Request as an address, and its method, headers and body
  // belong to it: the rule sent the URL alone and the Request was never sent.
  const seen = []
  const transport = async (url, init) => {
    const body = init?.body === undefined ? "none" : await new Response(init.body).text()
    seen.push({ url: String(url), method: init?.method, body, authorization: init?.headers?.get?.("authorization") })
    return new Response("ok")
  }
  const request = new Request(`${vendor}/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer SYNTH" }, body: "{}" })
  const res = await guardedFetch(request, {}, { transport })
  assert.equal(await res.text(), "ok")
  const fromRequest = await guardedFetch(new Request(`${vendor}/v1/models`), {}, { transport })
  assert.equal(await fromRequest.text(), "ok")
  assert.deepEqual(seen, [
    { url: `${vendor}/v1/chat/completions`, method: "POST", body: "{}", authorization: "Bearer SYNTH" },
    { url: `${vendor}/v1/models`, method: "GET", body: "none", authorization: null },
  ], "a GET Request is a GET, with no body")
})

test("every byte body is copied, and a DataView is one", async () => {
  // A Buffer's slice() and an ArrayBuffer itself share their memory with the
  // caller, and a DataView has no slice at all: the call threw for a body
  // fetch accepts. Each is read once, at the call.
  const sent = []
  const transport = (url, init) => {
    sent.push([...new Uint8Array(init.body instanceof DataView ? init.body.buffer : init.body)])
    if (init.body instanceof DataView) new Uint8Array(init.body.buffer)[0] = 9
    if (Buffer.isBuffer(init.body)) init.body[0] = 9
    return Promise.resolve(new Response(null, { status: 307, headers: { location: `${vendor}/next` } }))
  }
  const view = new DataView(new Uint8Array([1, 2]).buffer)
  await guardedFetch(`${vendor}/a`, { method: "POST", body: view }, { transport })
  assert.deepEqual(sent, [[1, 2], [1, 2]], "a DataView body is sent, and its bytes are the call's")
  sent.length = 0
  await guardedFetch(`${vendor}/a`, { method: "POST", body: Buffer.from([1, 2]) }, { transport })
  assert.deepEqual(sent, [[1, 2], [1, 2]], "a Buffer body is sent, and its bytes are the call's")
})

test("a 303 asks for the location with a GET, as fetch does", async () => {
  // fetch answers a 303, and a 301/302 after a POST, by asking the Location
  // for a GET with no body. The rule re-sent the POST with the body, which a
  // result endpoint that takes a GET answers with a refusal.
  const seen = []
  const transport = async (url, init) => {
    // The body as the transport sends it: read, not kept, because a stream is
    // sent once and a test that looked at it afterwards would be too late.
    const body = init?.body === undefined ? "none" : await new Response(init.body).text()
    seen.push({ url: String(url), method: init?.method ?? "GET", body })
    const first = seen.length === 1
    return first ? new Response(null, { status: 303, headers: { location: "/result" } }) : new Response("done")
  }
  const res = await guardedFetch(`${vendor}/submit`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, { transport })
  assert.equal(await res.text(), "done")
  assert.deepEqual(seen, [
    { url: `${vendor}/submit`, method: "POST", body: "{}" },
    { url: `${vendor}/result`, method: "GET", body: "none" },
  ])
})

test("a 307 keeps the method and the body", async () => {
  const seen = []
  const transport = async (url, init) => {
    const body = init?.body === undefined ? "none" : await new Response(init.body).text()
    seen.push({ url: String(url), method: init?.method ?? "GET", body })
    return seen.length === 1 ? new Response(null, { status: 307, headers: { location: "/next" } }) : new Response("ok")
  }
  await guardedFetch(`${vendor}/submit`, { method: "POST", body: "{}" }, { transport })
  assert.deepEqual(seen, [
    { url: `${vendor}/submit`, method: "POST", body: "{}" },
    { url: `${vendor}/next`, method: "POST", body: "{}" },
  ])
})

test("a Location that names a user in its authority is not a hop", () => {
  // The origin ignores userinfo: "https://evil.example@vendor" is the vendor
  // to the URL parser, and following it would hand whatever the client puts
  // in its own cookies to the vendor under another name. The vendor's own
  // QR-image rule refuses userinfo the same way.
  const at = vendor + "/v1/chat/completions"
  assert.equal(hopOf(vendor, at, "https://evil.example@api.claw.speedai.com/v1/y"), null)
  assert.equal(hopOf(vendor, at, "https://user:pw@api.claw.speedai.com/v1/y"), null)
})

test("a redirect body that is not the answer is drained", async () => {
  // A hop leaves the redirect's own body unread; the connection it holds is
  // released when it is cancelled, not when the collection happens to run.
  let cancelled = 0
  const body = (status, location) => ({
    status,
    headers: new Headers({ location }),
    body: new ReadableStream({
      pull() {},
      cancel() {
        cancelled++
      },
    }),
  })
  const transport = (url) => Promise.resolve(seenPush(String(url)) ? new Response(null, { status: 200 }) : body(302, "/next"))
  const answer = []
  const seenPush = (u) => {
    answer.push(u)
    return answer.length > 1
  }
  const res = await guardedFetch(`${vendor}/start`, {}, { transport })
  assert.equal(res.status, 200)
  assert.equal(cancelled, 1, "the redirect's body was cancelled")
})

test("the rule keeps the origin it was given, port included", () => {
  // hopOf is the guarded fetch's own answer for one Location, without a
  // socket: the origin includes the port, so another port on the vendor's name
  // is another service.
  const at = vendor + "/v1/chat/completions"
  assert.equal(hopOf(vendor, at, "/v1/models"), vendor + "/v1/models")
  assert.equal(hopOf(vendor, at, vendor + "/v1"), vendor + "/v1")
  assert.equal(hopOf(vendor, at, "https://api.claw.speedai.com:8443/v1"), null)
  // the Go proxy refuses any port written at all; the origin has none to
  // repeat, so even :443 — which parses away into the same origin — is a
  // portful name and no hop, keeping the two transports' rule one rule
  assert.equal(hopOf(vendor, at, "https://api.claw.speedai.com:443/v1"), null)
  // and a protocol-relative Location writes its port the same way
  assert.equal(hopOf(vendor, at, "//api.claw.speedai.com:443/v1"), null)
  assert.equal(hopOf(vendor, at, "//api.claw.speedai.com/v1"), vendor + "/v1")
  assert.equal(hopOf(vendor, at, "https://api.claw.speedai.com.evil.example/v1"), null)
  assert.equal(hopOf(vendor, at, "https://evil.example/api.claw.speedai.com"), null)
  assert.equal(hopOf(vendor, at, "http://api.claw.speedai.com/v1"), null)
  // another id on the same name is another origin for the URL parser, and a
  // Location that only closes a fragment or repeats the request is not a hop
  assert.equal(hopOf("http://127.0.0.1:5000", "http://localhost:5000/x", "/y"), null)
  assert.equal(hopOf(vendor, at, "#fragment"), null)
  assert.equal(hopOf(vendor, at, at), null)
  assert.equal(hopOf(vendor, at, null), null)
})

test("a plain-http address is held to the same rule as https", async () => {
  // A user's chat base can be plain http (a local gateway on a loopback port
  // is a normal chain), and the request carries their key. An address that
  // is not https used to be handed to the transport with the caller's
  // redirect mode intact, so a redirect off that origin could take
  // Authorization to another host with it. The rule keeps http too: a hop
  // only on the origin the request started on, port included, and a
  // cross-origin redirect returned as the answer it is.
  const away = planned(() => "http://elsewhere.invalid/collect")
  const refused = await guardedFetch("http://example.invalid/start", { method: "POST", headers: { authorization: "Bearer SYNTH" }, body: "{}", redirect: "follow" }, { transport: away.transport })
  assert.equal(refused.status, 302, "the redirect off the http origin is returned, not followed")
  assert.deepEqual(away.asked, [{ url: "http://example.invalid/start", redirected: "manual" }], "the caller's follow mode was replaced by the rule")

  const seen = []
  const hopTransport = (url, init) => {
    seen.push(String(url))
    const target = String(url).endsWith("/start") ? "http://127.0.0.1:3000/v1/models" : null
    return Promise.resolve(target === null ? new Response(null, { status: 200 }) : new Response(null, { status: 302, headers: { location: target } }))
  }
  const second = await guardedFetch("http://127.0.0.1:3000/start", {}, { transport: hopTransport })
  assert.equal(second.status, 200, "a same-origin http hop is taken, as fetch takes it")
  assert.deepEqual(seen, ["http://127.0.0.1:3000/start", "http://127.0.0.1:3000/v1/models"])
})
