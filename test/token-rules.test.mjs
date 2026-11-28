// The sign-in layer's rules against synthetic vendor answers only: no real
// host, no real login, no check-in. The stubs answer from memory, so a test
// never depends on the vendor's clock or on a token that expires tomorrow.

import assert from "node:assert/strict"
import { test } from "node:test"

import { CodarPlugin } from "../index.mjs"
import { testables } from "../lib/internal.mjs"

const {
  codeOf,
  errorCodeOf,
  login,
  refreshToken,
  wechatStatusOf,
} = testables

testables.nativeFetch = null
testables.chatFetch = null

// mkToken is shaped like the vendor's JWT; `sig` is a placeholder, since no
// signature is checked here — the claims are all these readers look at.
const mkToken = (claims) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.${"A".repeat(43)}`
}
const future = () => Math.floor(Date.now() / 1000) + 86400
const NAMED = mkToken({ username: "alice", exp: future() })
const SUB_ONLY = mkToken({ sub: "alice", exp: future() })

// withFetch routes every request to an in-memory Response. A route may state
// a status and a body; a loopback request (the sign-in page's own origin) is
// handed to the real fetch, and any other request without a route fails the
// test rather than reaching out to a host.
async function withFetch(routes, fn) {
  const real = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    const given = url instanceof Request ? url.url : url
    const u = String(given)
    const parsed = new URL(u)
    if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") return real(url, init)
    const method = String(url instanceof Request ? url.method : init?.method ?? "GET").toUpperCase()
    calls.push({
      url: u,
      method,
      init,
      headers: url instanceof Request ? url.headers : new Headers(init?.headers ?? {}),
    })
    const route = routes[`${method} ${parsed.pathname}`] ?? routes[parsed.pathname]
    assert.ok(route, `unexpected request to ${method} ${u}`)
    if (typeof route === "function") return route(u, init)
    // a route may be a bare body, or {body, status} when the status is the
    // point (a refusal that arrives as HTTP 401 rather than a business code)
    const said = Object.hasOwn(route, "body") ? route.body : route
    return new Response(JSON.stringify(said), { status: route.status ?? 200, headers: { "Content-Type": "application/json" } })
  }
  try {
    return await fn(calls)
  } finally {
    globalThis.fetch = real
  }
}

const loginRoute = (body, status = 200) => ({ "POST /v1/login": { body, status } })
const refreshRoute = (body, status = 200) => ({ "POST /v1/token/refresh": { body, status } })

// --- 1. every entrance that hands a token to the host reads the card's claim

test("password and IP verification refuse a token without a username claim", async () => {
  for (const entry of [
    ["password", () => login("alice", "pw"), loginRoute({ code: 200, token: SUB_ONLY, username: "alice" })],
      ]) {
    const [name, call, routes] = entry
    await withFetch(routes, async () => {
      await assert.rejects(call(), (e) => /账号名/.test(e.message), `${name}: a sub-only token is not a sign-in`)
    })
    // the name echoed outside the token must not paper over the missing claim
    await withFetch(routes, async () => {
      await assert.rejects(call(), (e) => e.code === "no_username", `${name}: the refusal names the missing claim`)
    })
  }
})

test("a QR success without a username claim is an actionable error, not a done", async () => {
  const got = wechatStatusOf({ code: 200, data: { status: "SUCCESS", token: SUB_ONLY, username: "alice" } })
  assert.equal(got.state, "error")
  assert.match(got.message, /账号名/)
  assert.match(got.message, /重新登录|手机号登录/)
  assert.equal(got.token, undefined)
})

test("refresh refuses a renewed token without a username claim", async () => {
  await withFetch(refreshRoute({ code: 200, token: SUB_ONLY, username: "alice" }), async () => {
    await assert.rejects(refreshToken(NAMED), (e) => /账号名/.test(e.message), "a renewed token the card cannot read is not handed over")
  })
})

// --- 2. a refusal's code and signIn mark must not depend on the wrapper

test("a 401 is expired through every wrapper and every field", async () => {
  const expiredBodies = [
    { code: 401, message: "Token has expired" },
    { code: 200, data: { code: 401, message: "Token has expired" } },
    { code: 200, data: { code: 200, data: { error: { code: 401, message: "Token has expired" } } } },
    { code: 200, error: { code: 401 } },
    { code: 200, detail: { code: 401 } },
  ]
  for (const body of expiredBodies) {
    await withFetch(refreshRoute(body), async () => {
      await assert.rejects(refreshToken(NAMED), (e) => e.signIn === "expired", `${JSON.stringify(body)}: expired`)
    })
    await withFetch(refreshRoute(body, 401), async () => {
      await assert.rejects(refreshToken(NAMED), (e) => e.signIn === "expired", `${JSON.stringify(body)}: HTTP 401`)
    })
  }
})

test("the refusal code is the one read, not an outer 200", async () => {
  await withFetch(refreshRoute({ code: 200, error: { code: 401 } }), async () => {
    await assert.rejects(refreshToken(NAMED), (e) => e.signIn === "expired" && String(e.code) === "401", "error.code 401 is the refusal's code")
  })
  await withFetch(refreshRoute({ code: 200, data: { code: 403, message: "forbidden" } }), async () => {
    await assert.rejects(refreshToken(NAMED), (e) => String(e.code) === "403", "an inner 403 is the refusal's code")
  })
})

test("a 403 is classified by its words, not its number", async () => {
  // The vendor answers a dead sign-in and an account restriction with 403. The
  // same wording as the 401 case ("Token has expired") is still an expiry at
  // this status; a 403 that says only "forbidden" is not one, and a
  // restriction is never one.
  for (const status of [200, 403]) {
    await withFetch(refreshRoute({ code: 403, message: "Token has expired" }, status), async () => {
      await assert.rejects(refreshToken(NAMED), (e) => e.signIn === "expired" && String(e.code) === "403", `an expiry word at HTTP ${status} is an expiry`)
    })
  }
  await withFetch(refreshRoute({ code: 403, message: "forbidden" }, 403), async () => {
    await assert.rejects(refreshToken(NAMED), (e) => e.signIn !== "expired" && String(e.code) === "403", "a bare 403 is not an expired sign-in")
  })
})

test("an account restriction is never marked as an expired sign-in", async () => {
  for (const body of [
    { code: 403, error: { code: "account_restricted" }, message: "账号受限" },
    { code: 200, data: { code: 403, error: { code: "account_restricted" }, message: "账号受限" } },
    { code: 200, data: { code: "account_restricted", message: "账号受限" } },
  ]) {
    await withFetch(refreshRoute(body), async () => {
      // the refusal is named, not merely "not expired": a `no_token` or a
      // transport error would also pass a bare `signIn !== "expired"` check
      // (2026-11-28 review)
      await assert.rejects(
        refreshToken(NAMED),
        (e) => e.signIn === undefined && /^(?:403|account_restricted)$/.test(String(e.code)) && /受限/.test(String(e.message)),
        `${JSON.stringify(body)}: restriction is not expiry`,
      )
    })
    await withFetch(refreshRoute(body, 403), async () => {
      await assert.rejects(
        refreshToken(NAMED),
        (e) => e.signIn === undefined && /^(?:403|account_restricted)$/.test(String(e.code)),
        `${JSON.stringify(body)}: HTTP 403 restriction`,
      )
    })
  }
})

test("the expiry words are classified the same way at every depth", async () => {
  for (const body of [
    { code: 200, error: { code: "token_expired" } },
    { code: 200, data: { code: "invalid_token" } },
    { code: 200, message: "Token has expired" },
  ]) {
    await withFetch(refreshRoute(body), async () => {
      await assert.rejects(refreshToken(NAMED), (e) => e.signIn === "expired", `${JSON.stringify(body)}: expiry`)
    })
  }
})

// --- 3. password IP risk is read before success, and only handed over when
// the same answer actually carries a temp token and an account name.

test("an HTTP 200 ip_verify_required answer is a refusal, never a finished login", async () => {
  // The vendor stops this sign-in until a person passes its SMS check, and the
  // temp token it hands over is for /v1/user/verify_ip alone. Saved as a
  // finished sign-in it fails every request. The check is finished in Codar's
  // own app now: the plugin keeps no handover, because the host does not say
  // which account slot is asking (2026-11-27 review).
  const fresh = mkToken({ username: "alice", exp: future() + 10 })
  const temp = mkToken({ username: "alice", exp: future() })
  const p = await CodarPlugin()
  const password = p.auth.methods.find((m) => m.label === "科搭账号密码登录")
  await withFetch(loginRoute({ code: 200, status: "ip_verify_required", token: temp, username: "alice", phone: "13800138000" }), async () => {
    const out = await password.authorize({ username: "alice", password: "pw" })
    assert.equal(out.type, "failed", "the temp token is not handed to the host")
    assert.match(out.error, /短信安全验证/)
    assert.match(out.error, /科搭 App/, "the fix names where the check is finished")
    assert.equal(out.error.includes("科搭OAuth登录"), false, "no page promises to open the check")
    assert.equal(JSON.stringify(out).includes(temp), false, "the temp token is not in what the card shows")
  })
  // nothing is kept for a later page: the sign-in page is always the tabs
  const ctl = new AbortController()
  const sms = p.auth.methods.find((m) => m.label === "科搭OAuth登录")
  const opened = await sms.authorize({}, { signal: ctl.signal })
  try {
    const html = await (await fetch(opened.url)).text()
    assert.equal(/科搭短信安全验证/.test(html), false, "a handover survived into another sign-in's page")
    assert.match(html, /扫码登录/, "the page is the ordinary two tabs")
  } finally {
    ctl.abort()
  }
})

test("a wrapped 201 ip check is a refusal, and leaves nothing for another page", async () => {
  const temp = mkToken({ username: "alice", exp: future() })
  const good = { code: 200, data: { code: 201, status: "ip_verify_required", username: "alice", phone: "13800138000", token: temp } }
  const p = await CodarPlugin()
  const password = p.auth.methods.find((m) => m.label === "科搭账号密码登录")
  const sms = p.auth.methods.find((m) => m.label === "科搭OAuth登录")
  await withFetch(loginRoute(good), async () => {
    const out = await password.authorize({ username: "alice", password: "pw" })
    assert.equal(out.type, "failed")
    assert.match(out.error, /短信安全验证/)
  })
  // nothing is kept for a later page (the handover is gone: the host does not
  // name the account slot, so the check is finished in Codar's own app)
  const ctl = new AbortController()
  const opened = await sms.authorize({}, { signal: ctl.signal })
  try {
    const html = await (await fetch(opened.url)).text()
    assert.equal(/科搭短信安全验证/.test(html), false, "the wrapped 201 left a handover for another page")
    assert.match(html, /扫码登录/, "the wrapped 201 is a refusal, and the page is the ordinary tabs")
  } finally {
    ctl.abort()
  }

  // A 201 without the fields it promises is a plain failure: it cannot be
  // spent on verify_ip, so promising the OAuth page would send the person to
  // a step that cannot work.
  for (const [label, body] of [
    ["no temp token", { code: 201, status: "ip_verify_required", username: "alice", phone: "13800138000" }],
    ["wrapped, no temp token", { code: 200, data: { code: 201, status: "ip_verify_required", username: "alice", phone: "13800138000" } }],
    ["no name", { code: 201, status: "ip_verify_required", token: temp, phone: "13800138000" }],
  ]) {
    await withFetch(loginRoute(body), async () => {
      const out = await password.authorize({ username: "alice", password: "pw" })
      assert.equal(out.type, "failed")
      assert.doesNotMatch(out.error, /页面会直接打开安全验证|页面会直接打开/, `${label}: no false promise`)
      assert.match(out.error, /安全验证|短信验证|令牌/, `${label}: the error still says what the vendor asked for`)
    })
  }
})

// A synthetic refusal that has a status word but no 201 is still nothing the
// sign-in can finish; only the risk check's own handover fields change what is
// promised to the person.
test("an ip-risk status on a code 200 is refused before success", async () => {
  const temp = mkToken({ username: "alice", exp: future() })
  await withFetch(loginRoute({ code: 200, status: "ip_verify_required", token: temp, username: "alice", phone: "13800138000" }), async () => {
    await assert.rejects(login("alice", "pw"), (e) => Number(e.code) === 201 || /ip_verify/.test(String(e.code)), "the status alone names the check")
  })
})

// The probe the review used: a token that carries only `sub` is accepted by
// nothing that hands it to the host. Driven through index.mjs's password entry
// so a regression in `login`'s own gating is seen where the person would see
// it (the card's "no account name" line), not only in the lower layer.
test("the password entry never hands the host a token the card cannot name", async () => {
  const p = await CodarPlugin()
  const password = p.auth.methods.find((m) => m.label === "科搭账号密码登录")
  await withFetch(loginRoute({ code: 200, token: SUB_ONLY, username: "alice" }), async () => {
    const out = await password.authorize({ username: "alice", password: "pw" })
    assert.equal(out.type, "failed")
    assert.match(out.error, /账号名/)
    assert.match(out.error, /重新登录/, "the error says what to do")
    assert.ok(!JSON.stringify(out).includes(SUB_ONLY), "and does not keep the token in the answer")
  })
})
