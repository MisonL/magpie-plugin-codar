// The plugin against a fake Codar: every request goes to a stub, nothing here
// talks to speedai. Fixtures follow the clock, so they don't expire on a day.

import { test } from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, sep } from "node:path"
import { request as httpRequest } from "node:http"

import { CodarPlugin } from "../index.mjs"
import { testables } from "../lib/internal.mjs"
import * as mod from "../index.mjs"
import { CATALOG } from "../lib/catalog.mjs"

const { codeOf, tokenOf, usernameOf, expiresAt, expired, modelOf, modelsOf, catalogOf, protocolOf, mergeModel, publishedConcurrency, humanSecs, safeTime, secsOf, checkinWaitSecs, saidBy, errorCodeOf, restricted, retryAfterOf, signStateOf, signedIn, runningActivities, freeModelOf, scrubLine, scrubShapes, cutKey, echoesKey, windowsOf, WINDOWS_OF, decodedCarriesKey, cutProjected, flatten, encodedRun, splitAcross, signMessage, scrub, cut, readAnswer, payloadOf, request, appToken, configPath, shownPath, cleanText, pickOf, balanceOf, unwrapped, magicKeys, baseURL, ALREADY_CLAIMED, MAX_MODELS, MAX_ANSWER_BYTES, MAX_SCRUB_CHARS, unusableKey, login, refreshToken, LOGIN_PATH, REFRESH_PATH } = testables
// Nothing in this file may reach the Go proxy: several tests stub
// globalThis.fetch directly rather than through withFetch, and on a machine
// with a built native/bin the proxy would answer them instead — the stubs
// would be bypassed and the requests would go to the real vendor.
testables.nativeFetch = null
// The loader answers a fetch of its own (chatTransport), and that one is the
// native chat path, read from its own holder: the null above does not reach
// it. Nulled too, so a loader's fetch stays on the host's fetch here — the
// test that calls one relies on exactly that.
testables.chatFetch = null

// ANTHROPIC_ID is a model id the embedded catalog lists today, named once so
// that regenerating catalog.mjs (a model the vendor retires, another it adds)
// does not turn a dozen tests red over a name. The tests that care about the
// vendor's own list ask the catalog which id carries the property they need,
// instead of pinning one the vendor may drop.
const ANTHROPIC_ID = CATALOG.find((m) => m.protocol === "anthropic_messages").id
// LISTED_ID is a chat model the embedded catalog lists today, for the tests
// whose point is "a model the catalog knows" (the merge keeps what the user
// added and drops what the vendor dropped; the config hook lists the
// catalog). Asking the catalog, as with ANTHROPIC_ID, keeps a regeneration
// from turning those red over a retired name.
const LISTED_ID = (CATALOG.find((m) => m.protocol === "openai_chat_completions" && m.input?.includes("image")) ?? CATALOG[0]).id

// mkToken is a JWT-shaped string with the claims the plugin reads.
const mkToken = (claims) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.sig`
}
const TOKEN = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
const auth = async () => ({ type: "api", key: TOKEN })

// withFetch stubs global fetch for the duration of fn, answering by URL. A
// route key is "METHOD /path" or just "/path": requests are routed on the
// method and the whole URL, so a test can tell a POST to one host from a GET
// to another — the plugin's core design divides the two hosts and the two
// verbs, and a stub that matched on a path substring alone could not see
// either go wrong (nor tell /v1/daily-sign from /v1/daily-sign/status).
// A key with no method matches any method; a key starting with "http" is
// the whole URL (host included).
async function withFetch(routes, fn) {
  const real = globalThis.fetch
  // Every test in this file runs with the native transport off (see the top),
  // so a developer with a built native/bin does not see these routes bypassed.
  assert.equal(testables.nativeFetch, null, "withFetch ran with the native transport enabled")
  const calls = []
  const routesAt = Object.entries(routes).map(([key, answer]) => {
    const cut = key.indexOf(" ")
    const named = cut > 0 && /^[A-Z]+$/.test(key.slice(0, cut))
    return { method: named ? key.slice(0, cut) : "", url: named ? key.slice(cut + 1) : key, answer }
  })
  globalThis.fetch = async (url, init) => {
    // The plugin's guarded fetch hands the runtime's fetch a Request (guarded.mjs
    // says why); a fetch that reads a URL reads it the way a fetch does.
    const given = url instanceof Request ? url.url : url
    const u = String(given)
    const parsed = new URL(u)
    const method = String(init?.method ?? "GET").toUpperCase()
    calls.push({ url: u, method, init })
    for (const r of routesAt) {
      if (r.method && r.method !== method) continue
      const hit = r.url.startsWith("http") ? u === r.url : parsed.pathname === r.url
      if (!hit) continue
      if (typeof r.answer === "function") return r.answer(u, init)
      if (r.answer instanceof Response) return r.answer
      return new Response(JSON.stringify(r.answer.body ?? r.answer), { status: r.answer.status ?? 200, headers: { "Content-Type": "application/json" } })
    }
    return new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 })
  }
  try {
    return await fn(calls)
  } finally {
    globalThis.fetch = real
  }
}

test("a token's claims give the account name and the expiry", () => {
  assert.equal(usernameOf(TOKEN), "user_1")
  assert.ok(expiresAt(TOKEN) > Date.now())
  assert.equal(payloadOf("not a jwt"), null)
  assert.equal(usernameOf("garbage"), "")
  // the claim is a string or it is nothing: a number sent as the account in
  // every request body is not something the vendor's client would have read
  const numeric = (v) => mkToken({ username: v, exp: Math.floor(Date.now() / 1000) + 600 })
  assert.equal(usernameOf(numeric(123)), "", "a number is not an account name")
  assert.equal(usernameOf(numeric(null)), "")
  assert.equal(usernameOf(numeric({ name: "u" })), "")
})

// A key with anything but visible ASCII would make fetch throw with the whole
// value in the message ("…is an invalid header value"), which magpie logs and
// shows on the card. tokenOf refuses it before it can be echoed.
test("only a key made of visible ASCII is one we can send", () => {
  assert.equal(tokenOf({ type: "api", key: "  eyJabc.def.ghi  " }), "eyJabc.def.ghi")
  assert.equal(tokenOf({ type: "api", key: "eyJ\u200babc" }), "")
  assert.equal(tokenOf({ type: "api", key: "a\nb" }), "")
  assert.equal(tokenOf({ type: "api", key: "a\u00e9b" }), "")
  assert.equal(tokenOf({ type: "api", key: "   " }), "")
  // an oauth sign-in (what a login or a renewal saves) carries the token
  // under access; one saved before that field existed has it under refresh
  assert.equal(tokenOf({ type: "oauth", access: " eyJabc.def.ghi ", refresh: "other" }), "eyJabc.def.ghi")
  assert.equal(tokenOf({ type: "oauth", refresh: "eyJabc.def.ghi" }), "eyJabc.def.ghi")
  assert.equal(tokenOf({ type: "oauth", key: "eyJabc.def.ghi" }), "")
  assert.equal(tokenOf({ type: "oauth", access: "aéb" }), "")
  assert.equal(tokenOf(null), "")
})

// The password sign-in: the account's own name and password go to the
// vendor's /v1/login once, and what the host gets back is a token in the
// shape it renews (access/refresh/expires). The password must reach nothing
// else — not the saved sign-in, not the text of a failure.
test("a password sign-in hands over a renew-able token and never the password", async () => {
  const fresh = mkToken({ username: "user_2", exp: Math.floor(Date.now() / 1000) + 604800 })
  const p = await CodarPlugin()
  const r = await withFetch({ "POST /v1/login": { body: { code: 200, token: fresh, username: "user_2" } } }, async (calls) => {
    const out = await p.auth.methods.find((x) => x.label === "科搭账号密码登录").authorize({ username: " user_2 ", password: "s3cret-pass" })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, `https://api.kuaipaper.com${LOGIN_PATH}`)
    const sent = JSON.parse(calls[0].init.body)
    assert.equal(sent.username, "user_2", "the name reaches the vendor trimmed")
    assert.equal(sent.password, "s3cret-pass")
    return out
  })
  assert.equal(r.type, "success")
  assert.equal(r.access, fresh)
  assert.equal(r.refresh, fresh, "without refresh the host would keep a bare api key and never renew it")
  assert.equal(r.expires, expiresAt(fresh), "expires is the token's own exp, so the host renews before it")
  assert.ok(!JSON.stringify([r.access, r.refresh, r.key ?? "", r.metadata ?? {}]).includes("s3cret-pass"), "the password is kept nowhere")
})

test("a password sign-in that wants an SMS check names the way that works", async () => {
  const p = await CodarPlugin()
  const wantsSms = await withFetch(
    { "POST /v1/login": { body: { code: 201, status: "ip_verify_required", message: "当前账号需要安全验证", username: "user_2", phone: "138****0000", token: "temp" } } },
    async () => p.auth.methods.find((x) => x.label === "科搭账号密码登录").authorize({ username: "user_2", password: "s3cret-pass" }),
  )
  assert.equal(wantsSms.type, "failed")
  assert.match(wantsSms.error, /短信安全验证/)
  assert.match(wantsSms.error, /科搭OAuth登录/, "it names the sign-in that works")
  assert.ok(!wantsSms.error.includes("s3cret-pass"), "the password never appears in what the card shows")

  // the vendor's own sentence for a wrong account or password
  const wrong = await withFetch(
    { "POST /v1/login": { status: 404, body: { code: 404, message: "用户名或密码错误", is_new: false } } },
    async () => p.auth.methods.find((x) => x.label === "科搭账号密码登录").authorize({ username: "user_2", password: "wrong" }),
  )
  assert.equal(wrong.type, "failed")
  assert.equal(wrong.error, "用户名或密码错误")
})

test("a renewal keeps the sign-in ahead of its exp, and a refused one marks it expired", async () => {
  const next = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 604800 })
  const p = await CodarPlugin()
  const live = { type: "oauth", access: TOKEN, refresh: TOKEN, expires: expiresAt(TOKEN) }
  const renewed = await withFetch({ "POST /v1/token/refresh": { body: { code: 200, token: next } } }, async (calls) => {
    const out = await p.auth.refresh(live)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, `https://api.kuaipaper.com${REFRESH_PATH}`)
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`, "the current token is what is renewed")
    return out
  })
  assert.equal(renewed.access, next)
  assert.equal(renewed.refresh, next)
  assert.equal(renewed.expires, expiresAt(next))

  // the vendor's 401 on the refresh is "signed out", not a failed renew to retry
  await withFetch({ "POST /v1/token/refresh": { body: { code: 401, message: "Invalid token" } } }, async () => {
    await assert.rejects(p.auth.refresh(live), (e) => e.signIn === "expired")
  })

  // The same refusal inside a wrapper: `{code:200, data:{code:401,…}}` passed
  // the top-level gate and then had no token, which was reported as "the
  // answer had no token" — a failure the host retries forever. It is the
  // expired sign-in it says it is.
  await withFetch({ "POST /v1/token/refresh": { body: { code: 200, data: { code: 401, message: "Token has expired" } } } }, async () => {
    await assert.rejects(p.auth.refresh(live), (e) => e.signIn === "expired")
  })
  await withFetch({ "POST /v1/token/refresh": { body: { code: 200, data: { code: "invalid_token", message: "Invalid token" } } } }, async () => {
    await assert.rejects(p.auth.refresh(live), (e) => e.signIn === "expired" && e.code === "invalid_token")
  })
  // but a wrapped refusal that is not about the sign-in stays a plain failure
  await withFetch({ "POST /v1/token/refresh": { body: { code: 200, data: { code: 500, message: "系统繁忙" } } } }, async () => {
    await assert.rejects(p.auth.refresh(live), (e) => e.signIn !== "expired" && /系统繁忙/.test(e.message))
  })

  // a token past its exp is never sent: the vendor would only refuse it
  const old = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) - 10 })
  await withFetch({}, async (calls) => {
    await assert.rejects(p.auth.refresh({ type: "oauth", access: old, refresh: old, expires: expiresAt(old) }), (e) => e.signIn === "expired")
    assert.equal(calls.length, 0, "an expired token must not reach the vendor")
  })
})

test("an oauth sign-in is the key the loader sends", async () => {
  const p = await CodarPlugin()
  const opts = await p.auth.loader(async () => ({ type: "oauth", access: TOKEN, refresh: "other", expires: expiresAt(TOKEN) }))
  assert.equal(opts.apiKey, TOKEN, "the host does not fall back to `key` for an oauth sign-in, so the loader must answer")
})

// The SMS sign-in: the vendor will not send a code without a solved captcha,
// so the plugin serves a page on 127.0.0.1 and makes every vendor call
// itself. These tests drive that page the way a browser would — the same
// URLs, the same bodies — with the vendor stubbed.
test("the SMS page sends a code only with a solved captcha, then trades the code for a token", async () => {
  const { startSignIn } = await import("../lib/signinpage.mjs")
  const sent = []
  const sms = await startSignIn({
    sendCode: async (phone, captcha) => { sent.push({ phone, captcha }) },
    verifyCode: async (phone, code) => {
      assert.equal(phone, "13800138000")
      assert.equal(code, "123456")
      return { token: TOKEN, username: "user_1" }
    },
  })
  try {
    assert.match(sms.url, /^http:\/\/127\.0\.0\.1:\d+\/s\/[0-9a-f]{32}\/$/, "the page is loopback-only, behind a random path")

    // the page itself, and nothing outside its path
    const page = await fetch(sms.url)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /ct4\.js/, "the page loads the vendor's own captcha bootstrap")
    assert.equal((await fetch(sms.url.replace(/\/s\/[0-9a-f]{32}\//, "/s/deadbeef/"))).status, 404, "another path token is not the page")

    // a send without the captcha fields is refused here, never asked of the vendor
    const bare = await fetch(`${sms.url}send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "13800138000" }) })
    assert.equal(bare.status, 400)
    assert.equal(sent.length, 0, "an unsolved captcha must not reach the vendor")

    // a bad phone is refused too
    const bad = await fetch(`${sms.url}send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "123", captcha: { lot_number: "a", captcha_output: "b", pass_token: "c", gen_time: "d" } }) })
    assert.equal(bad.status, 400)
    assert.equal(sent.length, 0)

    const ok = await fetch(`${sms.url}send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13800138000", captcha: { lot_number: "lot", captcha_output: "out", pass_token: "pass", gen_time: "123" } }),
    })
    assert.equal(ok.status, 200)
    assert.deepEqual(sent[0], { phone: "13800138000", captcha: { lot_number: "lot", captcha_output: "out", pass_token: "pass", gen_time: "123" } })

    // the code: a wrong shape is refused, the right one answers the token
    const wrong = await fetch(`${sms.url}verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "13800138000", code: "x" }) })
    assert.equal(wrong.status, 400)
    const signed = await fetch(`${sms.url}verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "13800138000", code: "123456" }) })
    assert.equal(signed.status, 200)
    const got = await sms.wait()
    assert.equal(got.token, TOKEN, "the page never sees the token; the caller does")
    assert.equal(got.username, "user_1")
  } finally {
    sms.close()
  }
})

test("the page can carry the IP-check step, with the vendor's phone filled in", async () => {
  // The same listener serves the vendor's second half of a sign-in its IP
  // check stopped: the title and the button are the check's, and a number the
  // vendor already showed is filled in and locked so the person types only
  // the code.
  const { startSignIn } = await import("../lib/signinpage.mjs")
  const sms = await startSignIn({
    verify: { sendCode: async () => {}, verifyCode: async () => ({ token: TOKEN, username: "user_1" }), hint: "该账号当前网络需要短信安全验证", phone: "13800138000" },
    copy: { title: "科搭短信安全验证", button: "完成验证" },
  })
  try {
    const html = await (await fetch(sms.url)).text()
    assert.match(html, /<title>科搭短信安全验证<\/title>/)
    assert.match(html, /完成验证/)
    assert.match(html, /value="13800138000" readonly/, "a number the vendor showed is not typed again")
  } finally {
    sms.close()
  }
})

test("a name the vendor echoed into the IP check reaches the page as text, not as markup", async () => {
  // The IP-check page's hint names the account, and that name can come from
  // the vendor's refusal body. The page is served from 127.0.0.1 with this
  // sign-in's path token and no CSP, so a name pasted in as HTML would run as
  // markup on the origin every POST names. It is interpolated as text.
  const { startSignIn } = await import("../lib/signinpage.mjs")
  const hostile = '<img src=x onerror="alert(1)">'
  const sms = await startSignIn({
    verify: { sendCode: async () => {}, verifyCode: async () => ({ token: TOKEN, username: "user_1" }), hint: `账号 ${hostile} 当前网络需要短信安全验证`, phone: "13800138000" },
    copy: { title: "科搭短信安全验证", button: "完成验证" },
  })
  try {
    const html = await (await fetch(sms.url)).text()
    assert.ok(!html.includes(hostile), `the account name went in as markup: ${html.slice(0, 400)}`)
    assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"), "the name is shown, escaped")
    assert.match(html, /value="13800138000" readonly/)
  } finally {
    sms.close()
  }
})

test("the listener holds its own resend cooldown, so a script on the path cannot spend SMS", async () => {
  // The page's 60-second countdown is client-side: anything that knows the
  // path can POST /send. The listener refuses a second send inside the
  // cooldown with 429 and the vendor's call is never made; once the cooldown
  // has passed the next send goes through.
  const { startSignIn } = await import("../lib/signinpage.mjs")
  const sent = []
  let clock = 1_000
  const sms = await startSignIn({
    sendCode: async (phone) => { sent.push(phone) },
    verifyCode: async () => ({ token: TOKEN, username: "user_1" }),
    now: () => clock,
  })
  const post = (rest, body) => fetch(`${sms.url}${rest}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  const send = { phone: "13800138000", captcha: { lot_number: "lot", captcha_output: "out", pass_token: "pass", gen_time: "123" } }
  try {
    assert.equal((await post("send", send)).status, 200)
    const again = await post("send", send)
    assert.equal(again.status, 429, "a second send inside the cooldown is refused")
    assert.match((await again.json()).error, /秒后再发送验证码/)
    assert.equal(sent.length, 1, "the refused send never reached the vendor")
    clock += 60_000
    assert.equal((await post("send", send)).status, 200, "a send after the cooldown goes through")
    assert.equal(sent.length, 2)
  } finally {
    sms.close()
  }
})

test("a page stops trading codes after its submit budget, refusals included", async () => {
  // A wrong code costs an attempt: five of them end the page's code trading
  // at the listener, before the vendor is asked again.
  const { startSignIn } = await import("../lib/signinpage.mjs")
  const asked = []
  const sms = await startSignIn({
    sendCode: async () => {},
    verifyCode: async (phone, code) => { asked.push(code); if (code === "000000") throw new Error("验证码错误"); return { token: TOKEN, username: "user_1" } },
    maxSubmits: 3,
  })
  const verify = (code) => fetch(`${sms.url}verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "13800138000", code }) })
  try {
    assert.equal((await verify("x")).status, 400, "a wrong shape still spends an attempt")
    assert.equal((await verify("000000")).status, 400)
    assert.equal((await verify("000000")).status, 400, "the third attempt reaches the vendor")
    assert.equal(asked.length, 2, "the two well-shaped codes were asked; the malformed one was not")
    const spent = await verify("123456")
    assert.equal(spent.status, 429, "the budget is spent before the correct code could be asked")
    assert.match((await spent.json()).error, /尝试次数过多/)
    assert.equal(asked.length, 2, "a spent page never reaches the vendor again")
  } finally {
    sms.close()
  }
})

test("the page module is lib/signinpage.mjs and the plugin imports it from there", async () => {
  // The page's module moved into lib/ with the rest of the runtime. The
  // plugin's own import is what matters: a path left behind would fail at
  // load, and this pins the two together.
  const { startSignIn, DEFAULT_CAPTCHA_ID } = await import("../lib/signinpage.mjs")
  assert.equal(typeof startSignIn, "function")
  assert.match(DEFAULT_CAPTCHA_ID, /^[0-9a-f]{32}$/)
  const p = await CodarPlugin()
  const page = p.auth.methods.find((x) => x.label === "科搭OAuth登录")
  assert.equal(typeof page.authorize, "function", "the method the page serves is loaded from lib/signinpage.mjs")
})

test("a password sign-in the IP check stopped is finished through verify_ip, not a second password", async () => {
  // The vendor answers a refused password sign-in with {code:201,
  // status:"ip_verify_required", token, username, phone}: the token is a temp
  // one, good for /v1/user/verify_ip alone. The SMS page then asks for the
  // code with type "ip_verify" and posts the three fields the endpoint takes,
  // as the vendor's own web app does in that state.
  const temp = mkToken({ username: "user_3", exp: Math.floor(Date.now() / 1000) + 600 })
  const fresh = mkToken({ username: "user_3", exp: Math.floor(Date.now() / 1000) + 604800 })
  const p = await CodarPlugin()
  await withFetch(
    { "POST /v1/login": { body: { code: 201, status: "ip_verify_required", message: "当前账号需要安全验证", username: "user_3", phone: "13800138000", token: temp } } },
    async () => {
      const out = await p.auth.methods.find((x) => x.label === "科搭账号密码登录").authorize({ username: "user_3", password: "s3cret-pass" })
      assert.equal(out.type, "failed")
      assert.match(out.error, /短信安全验证/)
      assert.ok(!JSON.stringify(out).includes(temp), "the temp token is not in what the card shows")
    },
  )

  const smsMethod = p.auth.methods.find((x) => x.label === "科搭OAuth登录")
  // The page's own URL is opened while the vendor is still stubbed: opening a
  // page itself makes no vendor call, and the stub answers a loopback request
  // with a 404 it should never get here.
  const opened = await withFetch({ "POST /v1/login": { body: { code: 200, token: fresh } } }, async () => smsMethod.authorize({}, {}))
  assert.match(opened.url, /^http:\/\/127\.0\.0\.1:\d+\/s\/[0-9a-f]{32}\/$/)
  const html = await (await fetch(opened.url)).text()
  assert.match(html, /科搭短信安全验证/, "the page says what it is verifying")
  assert.ok(!html.includes("手机号登录") && !html.includes("扫码登录"), "the security-check page carries no sign-in tabs")
  assert.match(html, /value="13800138000" readonly/, "and carries the number the vendor showed")

  const calls = []
  const realFetch = globalThis.fetch
  // The page's own URLs go to the page: only the vendor's hosts are stubbed,
  // or the test would answer its own POSTs and the page would never see them.
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.startsWith("http://127.0.0.1:")) return realFetch(u, init)
    calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : null, auth: new Headers(init?.headers).get("authorization") })
    if (u.includes("/v1/verification-code")) return new Response(JSON.stringify({ code: 200 }), { status: 200 })
    return new Response(JSON.stringify({ code: 200, data: { token: fresh, username: "user_3" } }), { status: 200 })
  }
  try {
    const sent = await fetch(`${opened.url}send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13800138000", captcha: { lot_number: "l", captcha_output: "o", pass_token: "p", gen_time: "1" } }),
    })
    assert.equal(sent.status, 200)
    const verify = await fetch(`${opened.url}verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "13800138000", code: "123456" }) })
    assert.equal(verify.status, 200)
    const answered = await opened.callback()
    assert.equal(answered.type, "success")
    assert.equal(answered.refresh, fresh, "the account's own token comes back, in the shape the host renews")

    const codeCall = calls.find((c) => c.url.includes("/v1/verification-code"))
    assert.equal(codeCall.body.type, "ip_verify", "the vendor's own code type for this step")
    assert.equal(codeCall.body.name, "user_3", "carried with the account's own name")
    const verifyCall = calls.find((c) => c.url.includes("/v1/user/verify_ip"))
    assert.deepEqual(verifyCall.body, { username: "user_3", phone: "13800138000", code: "123456" })
    assert.equal(verifyCall.auth, `Bearer ${temp}`, "the temp token is the only credential that call has")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("an IP-check handover is used once, expires, and is cleared by another sign-in", async () => {
  // The temp token a refused password sign-in leaves for the SMS page is a
  // credential, and it is taken (not peeked): one handover completes at most
  // one sign-in. Left in place, it would be picked up by a later SMS sign-in —
  // possibly for another account — or finish a check the person had already
  // walked away from.
  const temp = mkToken({ username: "user_9", exp: Math.floor(Date.now() / 1000) + 600 })
  const fresh = mkToken({ username: "user_9", exp: Math.floor(Date.now() / 1000) + 604800 })
  const p = await CodarPlugin()
  const sms = p.auth.methods.find((x) => x.label === "科搭OAuth登录")
  const password = p.auth.methods.find((x) => x.label === "科搭账号密码登录")
  const refused = { "POST /v1/login": { body: { code: 201, status: "ip_verify_required", message: "需要安全验证", username: "user_9", phone: "13800138000", token: temp } } }

  // first refusal leaves a handover; the page shows it
  await withFetch(refused, async () => {
    const out = await password.authorize({ username: "user_9", password: "pw" })
    assert.equal(out.type, "failed")
  })
  // A page is opened for each check and closed through its signal: the
  // listener would otherwise answer for its own ten minutes.
  const titleOf = async (inputs = {}) => {
    const ctl = new AbortController()
    const out = await sms.authorize(inputs, { signal: ctl.signal })
    try {
      return await (await fetch(out.url)).text()
    } finally {
      ctl.abort()
    }
  }
  assert.match(await titleOf(), /科搭短信安全验证/, "the handover reached the page")

  // second attempt in the same process: the handover is spent, so the page is
  // the ordinary sign-in again — one handover, one sign-in
  assert.match(await titleOf(), /登录科搭 Codar/, "a spent handover is not offered again")

  // a fresh handover, then a password attempt for another account: the new
  // attempt is a new flow, and must not be finished with the old temp token
  await withFetch(refused, async () => {
    await password.authorize({ username: "user_9", password: "pw" })
  })
  await withFetch({ "POST /v1/login": { body: { code: 400, message: "用户名或密码错误" } } }, async () => {
    await password.authorize({ username: "user_other", password: "pw" })
  })
  assert.match(await titleOf(), /登录科搭 Codar/, "another account's attempt cleared the handover")

  // a token sign-in is a sign-in too: the handover it did not make must not
  // outlive it, or the next SMS page would finish the other account's check
  await withFetch(refused, async () => {
    await password.authorize({ username: "user_9", password: "pw" })
  })
  const tokenMethod = p.auth.methods.find((x) => x.label === "科搭令牌（留空读本机）")
  const other = mkToken({ username: "user_other", exp: Math.floor(Date.now() / 1000) + 86400 })
  const signed = await tokenMethod.authorize({ token: other })
  assert.equal(signed.type, "success", "the pasted token signed in")
  assert.match(await titleOf(), /登录科搭 Codar/, "a token sign-in cleared the handover")
})

test("a handover past its window is dropped, not finished", async (t) => {
  // The temp token lives ten minutes. Past that the vendor would refuse it
  // anyway, and the page would be verifying an account the person no longer
  // has in front of them, so the handover is dropped without being offered.
  const temp = mkToken({ username: "user_11", exp: Math.floor(Date.now() / 1000) + 600 })
  const p = await CodarPlugin()
  const sms = p.auth.methods.find((x) => x.label === "科搭OAuth登录")
  const password = p.auth.methods.find((x) => x.label === "科搭账号密码登录")
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() })
  try {
    await withFetch(
      { "POST /v1/login": { body: { code: 201, status: "ip_verify_required", username: "user_11", token: temp } } },
      async () => password.authorize({ username: "user_11", password: "pw" }),
    )
    t.mock.timers.tick(10 * 60 * 1000 + 1000)
    const ctl = new AbortController()
    const opened = await sms.authorize({}, { signal: ctl.signal })
    try {
      assert.match(await (await fetch(opened.url)).text(), /登录科搭 Codar/, "an expired handover is not offered")
    } finally {
      ctl.abort()
    }
  } finally {
    t.mock.timers.reset()
  }
})

test("a request that carries no credential sends no Authorization at all", async () => {
  // The QR sign-in asks for its code and polls it anonymously, as the
  // vendor's own web client does. A token that is not a string used to be
  // spelled into the header anyway: the vendor saw `Bearer undefined`, which
  // is not a token and says the request came from something else.
  const seen = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") })
    return new Response(JSON.stringify({ code: 200 }), { status: 200, headers: { "Content-Type": "application/json" } })
  }
  try {
    await testables.request("https://api.kuaipaper.com/v1/wechat/login/qrcode", { method: "POST" })
    await testables.request("https://api.kuaipaper.com/v1/wechat/login/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: { scene: "s" }, token: "  " })
    await testables.request("https://api.kuaipaper.com/v1/codar/models", { token: "tok" })
  } finally {
    globalThis.fetch = real
  }
  assert.equal(seen[0].auth, null, "no token, no header")
  assert.equal(seen[1].auth, null, "a blank token is no token")
  assert.equal(seen[2].auth, "Bearer tok", "and a real one is still sent")
})

test("a renewal failure never carries the token into the sentence the host keeps", async () => {
  // The host writes failed renewals to its own file, and the request that
  // failed carried the token: a vendor that echoes it in its message would
  // put a credential on disk.
  const p = await CodarPlugin()
  const live = { type: "oauth", access: TOKEN, refresh: TOKEN, expires: expiresAt(TOKEN) }
  const leaked = `bad token ${TOKEN} refused`
  await withFetch({ "POST /v1/token/refresh": { status: 500, body: { detail: leaked } } }, async () => {
    const e = await p.auth.refresh(live).catch((x) => x)
    assert.ok(e instanceof Error, "a failed renewal still throws")
    assert.ok(!e.message.includes(TOKEN), `the token reached the host: ${e.message}`)
    assert.ok(e.message.trim(), "and the sentence is not emptied out")
  })
})

test("a QR status the vendor answers with 404 is an expired code, not a broken page", async () => {
  // The vendor states a scene it no longer knows with an HTTP status instead
  // of a business code. Read as a thrown error, the page showed a failure and
  // kept polling; read as an expiry, the person is told to scan the new code.
  // The page's own URLs go to the page: only the vendor's hosts are stubbed,
  // or the test would answer its own POSTs (see withFetch's note).
  const p = await CodarPlugin()
  const wechat = p.auth.methods.find((x) => x.label === "科搭OAuth登录")
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.startsWith("http://127.0.0.1:")) return real(u, init)
    if (u.includes("/v1/wechat/login/qrcode")) {
      return new Response(JSON.stringify({ code: 200, data: { scene: "s-gone", qr_url: "https://codar-web.speedai.com/qr.png" } }), { status: 200 })
    }
    return new Response(JSON.stringify({ message: "二维码已过期" }), { status: 404 })
  }
  const ctl = new AbortController()
  try {
    const opened = await wechat.authorize({}, { signal: ctl.signal })
    const answered = await (await real(`${opened.url}status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scene: "s-gone" }) })).json()
    assert.equal(answered.state, "expired", `a 404 was not read as an expiry: ${JSON.stringify(answered)}`)
  } finally {
    ctl.abort()
    globalThis.fetch = real
  }
})

test("a verification refusal the vendor echoes the temp token into never reaches the page", async () => {
  // /v1/user/verify_ip is the one vendor call whose bearer is the temp token,
  // and its refusal is shown in the page's status line. A vendor that quotes
  // the token back would put a credential in a browser, so the call site cuts
  // it before the page server ever sees the sentence.
  const temp = mkToken({ username: "user_echo", exp: Math.floor(Date.now() / 1000) + 600 })
  const fresh = mkToken({ username: "user_echo", exp: Math.floor(Date.now() / 1000) + 604800 })
  const p = await CodarPlugin()
  await withFetch(
    { "POST /v1/login": { body: { code: 201, status: "ip_verify_required", username: "user_echo", phone: "13800138000", token: temp } } },
    async () => p.auth.methods.find((x) => x.label === "科搭账号密码登录").authorize({ username: "user_echo", password: "pw" }),
  )
  const sms = p.auth.methods.find((x) => x.label === "科搭OAuth登录")
  const ctl = new AbortController()
  const opened = await sms.authorize({}, { signal: ctl.signal })
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.startsWith("http://127.0.0.1:")) return real(u, init)
    if (u.includes("/v1/verification-code")) return new Response(JSON.stringify({ code: 200 }), { status: 200 })
    // the refusal quotes the bearer it was given
    return new Response(JSON.stringify({ code: 400, message: `invalid token ${temp}` }), { status: 200 })
  }
  try {
    const answered = await (await real(`${opened.url}verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13800138000", code: "123456" }),
    })).json()
    assert.ok(answered.error, "the page is told the verification failed")
    assert.ok(!answered.error.includes(temp), `the temp token reached the page: ${answered.error}`)
    assert.match(answered.error, /验证失败|安全验证|token|invalid/i, "and the sentence is still a sentence")
  } finally {
    globalThis.fetch = real
    ctl.abort()
  }
})

test("a plain SMS sign-in still asks for a login code and calls login", async () => {
  // Nothing pending: the page is the sign-in it always was, and the code is
  // asked for with type "login" — the two steps must not be confused, or a
  // person with no IP check on them would be sent to verify_ip. The handover
  // is module state shared by every plugin in this process, so it is cleared
  // here rather than trusted to the test before this one: a failure there
  // must not decide what this page is.
  const p = await CodarPlugin()
  await withFetch({ "POST /v1/login": { body: { code: 400, message: "用户名或密码错误" } } }, async () => {
    await p.auth.methods.find((x) => x.label === "科搭账号密码登录").authorize({ username: "user_reset", password: "pw" })
  })
  const fresh = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 604800 })
  const smsMethod = p.auth.methods.find((x) => x.label === "科搭OAuth登录")
  const opened = await smsMethod.authorize({}, {})
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.startsWith("http://127.0.0.1:")) return realFetch(u, init)
    calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : null })
    if (u.includes("/v1/verification-code")) return new Response(JSON.stringify({ code: 200 }), { status: 200 })
    return new Response(JSON.stringify({ code: 200, token: fresh, username: "user_1" }), { status: 200 })
  }
  try {
    await fetch(`${opened.url}send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13900139000", captcha: { lot_number: "l", captcha_output: "o", pass_token: "p", gen_time: "1" } }),
    })
    await fetch(`${opened.url}verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "13900139000", code: "654321" }) })
    const answered = await opened.callback()
    assert.equal(answered.refresh, fresh)
    assert.equal(calls.find((c) => c.url.includes("/v1/verification-code")).body.type, "login")
    assert.ok(calls.some((c) => c.url.endsWith("/v1/login")), "a plain sign-in goes to /v1/login")
    assert.ok(!calls.some((c) => c.url.includes("/v1/user/verify_ip")), "and never to the IP check")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("an SMS code the vendor echoes back is not printed on the page", async () => {
  // In the plain flow the code goes out as the password field; a refusal that
  // quotes what it was sent would put the code on the local page. The exact
  // code this attempt sent is cut, and the rest of the vendor's sentence stays.
  const p = await CodarPlugin()
  const smsMethod = p.auth.methods.find((x) => x.label === "科搭OAuth登录")
  const ctl = new AbortController()
  const opened = await smsMethod.authorize({}, { signal: ctl.signal })
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.startsWith("http://127.0.0.1:")) return realFetch(u, init)
    if (u.includes("/v1/verification-code")) return new Response(JSON.stringify({ code: 200 }), { status: 200 })
    return new Response(JSON.stringify({ code: 400, message: "验证码 246802 已失效" }), { status: 200 })
  }
  try {
    await fetch(`${opened.url}send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13900139001", captcha: { lot_number: "l", captcha_output: "o", pass_token: "p", gen_time: "1" } }),
    })
    const refused = await (await fetch(`${opened.url}verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "13900139001", code: "246802" }) })).json()
    assert.ok(!JSON.stringify(refused).includes("246802"), `the code reached the page: ${JSON.stringify(refused)}`)
    assert.match(refused.error, /已失效/, "the vendor's own reason is still said")
  } finally {
    ctl.abort()
    globalThis.fetch = realFetch
  }
})

test("the scan status reads the vendor's words as the page's own states", () => {
  // The vendor's web app upper-cases the status and compares it against three
  // success words, "expired", "scanned" and the phone-required ones; business
  // code 404 is its other way of saying the code expired.
  const { wechatStatusOf, wechatQrOf } = testables
  const done = wechatStatusOf({ code: 200, data: { status: "success", token: TOKEN, username: "user_1" } })
  assert.deepEqual(done, { state: "done", token: TOKEN, username: "user_1" })
  assert.equal(wechatStatusOf({ data: { status: "AUTHORIZED", token: TOKEN } }).state, "done", "the case is not the vendor's")
  assert.equal(wechatStatusOf({ data: { status: "completed", token: TOKEN } }).state, "done")
  assert.equal(wechatStatusOf({ data: { status: "scanned" } }).state, "scanned")
  assert.equal(wechatStatusOf({ data: { status: "expired" } }).state, "expired")
  assert.equal(wechatStatusOf({ code: 404, message: "二维码已过期" }).state, "expired", "a 404 is the vendor's other way of saying it")
  assert.equal(wechatStatusOf({ data: { status: "required_bind_phone" } }).state, "error", "an unbound WeChat is a sign-in the vendor will not finish")
  assert.match(wechatStatusOf({ data: { status: "bind_phone_required" } }).message, /绑定手机号/)
  // the vendor's own list is BIND_PHONE / REQUIRE_PHONE_BINDING /
  // BIND_PHONE_REQUIRED; a spelling outside it is "waiting" like any other
  // word it does not know, so nothing is claimed either way
  assert.equal(wechatStatusOf({ data: { status: "BINDING_PHONE_REQUIRED" } }).state, "waiting")
  // a scan that lands on the IP check points at the sign-in that completes it
  assert.equal(wechatStatusOf({ data: { status: "required_ip_verify" } }).state, "error")
  assert.match(wechatStatusOf({ data: { status: "ip_verify_required" } }).message, /科搭OAuth登录/)
  assert.equal(wechatStatusOf({ data: { status: "waiting" } }).state, "waiting")
  // the poll's own success sentence is not news about the sign-in, and the
  // page's own "请使用微信扫码" is what should stand
  assert.equal(wechatStatusOf({ code: 200, message: "查询成功", data: { status: "pending" } }).message, "")
  assert.equal(wechatStatusOf({ code: 200, message: "系统维护中", data: { status: "pending" } }).message, "系统维护中", "an unusual sentence still reaches the person")
  assert.equal(wechatStatusOf({ data: { status: "SUCCESS" } }).state, "error", "a success with no token is not a sign-in")
  assert.equal(wechatStatusOf({}).state, "waiting", "an answer that says nothing is not done")
  assert.deepEqual(wechatQrOf({ data: { scene: "s1", qr_url: "https://codar-web.speedai.com/qr/s1.png" } }), { scene: "s1", qrUrl: "https://codar-web.speedai.com/qr/s1.png" })
  assert.equal(wechatQrOf({ data: { scene: "s1" } }), null, "a code without an image is no code")
  // The image is a src in the sign-in page's browser: an answer that points it
  // anywhere else (a loopback service, a scheme, the gateway) is no code.
  const { qrImageURL } = testables
  assert.equal(qrImageURL("https://codar-web.speedai.com/a.png"), true)
  assert.equal(qrImageURL("https://api.kuaipaper.com/a.png"), true)
  for (const bad of ["http://codar-web.speedai.com/a.png", "https://127.0.0.1:8080/x", "https://codar-web.speedai.com:8443/a.png", "https://user:pw@codar-web.speedai.com/a.png", "javascript:alert(1)", "data:image/png;base64,AA", "file:///etc/passwd", "https://evil.example/a.png", "https://api.claw.speedai.com/a.png"]) {
    assert.equal(qrImageURL(bad), false, bad)
    assert.equal(wechatQrOf({ data: { scene: "s1", qr_url: bad } }), null, bad)
  }
})

test("the QR page shows the vendor's image, polls to a token, and never sees the token", async () => {
  const { startSignIn } = await import("../lib/signinpage.mjs")
  const asked = []
  let polled = 0
  const page = await startSignIn({
    qrcode: async () => {
      asked.push("qr")
      return { scene: "scene-1", qrUrl: "https://codar-web.speedai.com/qr.png" }
    },
    status: async (scene) => {
      asked.push(scene)
      polled += 1
      return polled < 2 ? { state: "scanned" } : { state: "done", token: TOKEN, username: "user_1" }
    },
    pollMs: 10,
  })
  try {
    const html = await (await fetch(page.url)).text()
    assert.match(html, /<title>登录科搭 Codar<\/title>/)
    assert.match(html, /扫码登录/)
    assert.match(html, /手机号登录/, "both ways in are on the one page")
    assert.match(html, /\/qr/, "the page asks this listener for the code, not the vendor")

    const qr = await (await fetch(`${page.url}qr`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()
    assert.deepEqual(qr, { scene: "scene-1", qr_url: "https://codar-web.speedai.com/qr.png" })

    const first = await (await fetch(`${page.url}status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scene: "scene-1" }) })).json()
    assert.deepEqual(first, { state: "scanned", message: "" })
    const second = await (await fetch(`${page.url}status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scene: "scene-1" }) })).json()
    assert.equal(second.state, "done")
    assert.ok(!JSON.stringify(second).includes(TOKEN), "the token never reaches the page")

    const got = await page.wait()
    assert.equal(got.token, TOKEN, "the caller gets the credential instead")
    assert.equal(got.username, "user_1")
  } finally {
    page.close()
  }
})

test("the page's last screen is built from the card's own pieces, not a second design", async () => {
  // The end screens used to carry their own tick box and sizes, so the page
  // changed design at the moment it ended. They now reuse the card's brand
  // mark box and its type scale; this pins that shape, and the two rules the
  // shape depends on: the sign-in's heading and hint must make way for the
  // end screen's, and `hidden` must beat the page's own display rules.
  const { startSignIn } = await import("../lib/signinpage.mjs")
  const page = await startSignIn({ verify: { sendCode: async () => {}, verifyCode: async () => null, phone: "13800138000" } })
  try {
    const html = await (await fetch(page.url)).text()
    assert.match(html, /<div class="end" id="done" hidden>/, "the success screen is the card's last panel")
    assert.match(html, /<div class="end" id="bad" hidden>/, "and so is the failure screen")
    assert.match(html, /<div class="mark ok">/, "the mark is the card's own brand box, in green")
    assert.match(html, /<div class="mark bad">/, "... and in red")
    assert.match(html, /<h2>登录成功<\/h2>/)
    assert.match(html, /<h2>无法完成登录<\/h2>/)
    assert.match(html, /<p id="bad-why">科搭没有接受这次登录。<\/p>/, "the vendor's reason gets a line of its own")
    assert.match(html, /main\.ended > h1, main\.ended > p\.hint \{ display: none \}/, "the sign-in's heading and hint step aside")
    assert.match(html, /\[hidden\] \{ display: none !important \}/, "hidden beats the page's own display rules")
  } finally {
    page.close()
  }
})

test("the page hands the vendor's captcha widget the captchaId itself, not a variable", async () => {
  // The page's script said `captchaId: ${captchaId}`, which is a template
  // splice that never happens (the script is not a template): the page read a
  // variable of its own, had none, and the widget threw on undefined. The
  // page's own words ("人机验证加载失败") hid it, so only an opened page showed
  // it. The id must be a string literal in what the page parses.
  const { startSignIn, DEFAULT_CAPTCHA_ID } = await import("../lib/signinpage.mjs")
  const page = await startSignIn({ verify: { sendCode: async () => {}, verifyCode: async () => null, hint: "h", phone: "13800138000" } })
  try {
    const html = await (await fetch(page.url)).text()
    const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"))
    assert.ok(script.includes(`captchaId: ${JSON.stringify(DEFAULT_CAPTCHA_ID)}`), "the id is a literal in the script")
    assert.ok(!script.includes("${"), "no template splice was left unexpanded in the script")
    // the id is quoted: a value with quotes, angle brackets or a closing script
    // tag cannot end the literal, the attribute context, or the block
    const oddId = 'a"</script><b>${x}'
    const odd = await startSignIn({ captchaId: oddId, sendCode: async () => {}, verifyCode: async () => null })
    try {
      const got = await (await fetch(odd.url)).text()
      const body = got.slice(got.indexOf("<script>") + 8, got.lastIndexOf("</script>"))
      assert.ok(body.includes(`captchaId: ${JSON.stringify(oddId).replace(/</g, "\\u003c")}`), "quoted, with no < left to end the block")
      assert.equal(got.match(/<\/script>/g).length, 1, "one script block, whatever the value")
    } finally {
      odd.close()
    }
  } finally {
    page.close()
  }
})

test("a QR state the vendor will not finish settles the wait, not five minutes later", async () => {
  // The page stopped polling on an error, but the listener's deferred never
  // settled: magpie sat on the sign-in dialog until the page's TTL ran out,
  // long after the browser had said the account needs the SMS method.
  const { startSignIn } = await import("../lib/signinpage.mjs")
  const page = await startSignIn({
    qrcode: async () => ({ scene: "scene-2", qrUrl: "https://codar-web.speedai.com/qr.png" }),
    status: async () => ({ state: "error", message: "该账号当前网络需要短信安全验证：请改用「科搭OAuth登录」里的手机号登录" }),
    pollMs: 10,
  })
  try {
    // the page's own status poll is what makes the listener ask the vendor
    const polled = await (await fetch(`${page.url}status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scene: "scene-2" }) })).json()
    assert.equal(polled.state, "error")
    const started = Date.now()
    const answer = await Promise.race([
      page.wait(),
      new Promise((r) => setTimeout(() => r("timeout"), 2000)),
    ])
    assert.notEqual(answer, "timeout", "wait() answered without the TTL running out")
    assert.ok(Date.now() - started < 2000)
    assert.match(answer.error, /短信安全验证/, "and the vendor's sentence is the answer")
    assert.equal(answer.token, undefined, "no token is invented")
  } finally {
    page.close()
  }
})

// pageCall sends one request to a local sign-in page with headers of the
// test's choosing. fetch() will not let a caller set Host, and that header is
// the whole point of the check: a browser reached through DNS rebinding sends
// its own name there.
const pageCall = (url, { method = "GET", headers = {}, body = "" } = {}) =>
  new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = httpRequest({ host: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => {
      let text = ""
      res.on("data", (d) => (text += d))
      res.on("end", () => resolve({ status: res.statusCode, text }))
    })
    req.on("error", reject)
    if (body) req.write(body)
    req.end()
  })

test("a local sign-in page answers its own origin only, and only JSON", async () => {
  // The path token is the real secret, and the page is loopback-only. What is
  // checked here is the browser that knows the path but is not this page: DNS
  // rebinding (evil.com resolving to 127.0.0.1, so Host is evil.com) and a
  // cross-site text/plain POST (a simple request, which no preflight stands
  // before).
  const { startSignIn } = await import("../lib/signinpage.mjs")
  const sms = await startSignIn({ sendCode: async () => {}, verifyCode: async () => ({ token: TOKEN, username: "user_1" }) })
  const qr = await startSignIn({
    sendCode: async () => {},
    verifyCode: async () => ({ token: TOKEN, username: "user_1" }),
    qrcode: async () => ({ scene: "scene-1", qrUrl: "https://codar-web.speedai.com/qr.png" }),
    status: async () => ({ state: "waiting" }),
  })
  try {
    for (const [label, page, path, body] of [
      ["SMS", sms, "verify", { phone: "13800138000", code: "123456" }],
      ["QR", qr, "qr", {}],
    ]) {
      const url = new URL(page.url)
      const real = `127.0.0.1:${url.port}`
      const at = `${page.url}${path}`
      const json = JSON.stringify(body)

      const rebound = await pageCall(at, { method: "POST", headers: { Host: "evil.example", "Content-Type": "application/json" }, body: json })
      assert.equal(rebound.status, 403, `${label}: a foreign Host was answered`)

      const crossSite = await pageCall(at, { method: "POST", headers: { Host: real, Origin: "https://evil.example", "Content-Type": "application/json" }, body: json })
      assert.equal(crossSite.status, 403, `${label}: a foreign Origin was answered`)

      const simple = await pageCall(at, { method: "POST", headers: { Host: real, "Content-Type": "text/plain" }, body: json })
      assert.equal(simple.status, 415, `${label}: a text/plain POST was answered`)

      // and the page's own shape still goes through: the guard is not the answer
      const own = await pageCall(at, { method: "POST", headers: { Host: real, Origin: `http://${real}`, "Content-Type": "application/json" }, body: json })
      assert.equal(own.status, 200, `${label}: the page's own request was refused (${own.status}): ${own.text}`)
    }
  } finally {
    sms.close()
    qr.close()
  }
})

test("the QR sign-in is one method the host can open, and closes with the page", async () => {
  const p = await CodarPlugin()
  const m = p.auth.methods.find((x) => x.label === "科搭OAuth登录")
  assert.ok(m, "the QR method is offered")
  assert.equal(m.type, "oauth")
  assert.match(m.instructions, /扫码/)

  // The vendor's hosts are stubbed; the page's own loopback URLs must reach
  // the page, or the test would answer its own POSTs.
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.startsWith("http://127.0.0.1:")) return realFetch(u, init)
    calls.push({ url: u, method: String(init?.method ?? "GET").toUpperCase(), body: init?.body ? JSON.parse(init.body) : null })
    if (u.endsWith("/v1/wechat/login/qrcode")) return new Response(JSON.stringify({ code: 200, data: { scene: "s-9", qr_url: "https://codar-web.speedai.com/q.png" } }), { status: 200 })
    return new Response(JSON.stringify({ code: 200, data: { status: "scanned" } }), { status: 200 })
  }
  const ctl = new AbortController()
  let opened
  try {
    // the page's own URLs must reach the page once the vendor is stubbed
    // (opening the page makes no vendor call)
    // (withFetch delegates a loopback request to the fetch above, so the page
    // asks the vendor only when it is asked to)
    opened = await withFetch(
      { "http://127.0.0.1/": (u, init) => realFetch(u, init) },
      async () => m.authorize({}, { signal: ctl.signal }),
    )
    assert.match(opened.url, /^http:\/\/127\.0\.0\.1:\d+\/s\/[0-9a-f]{32}\/$/)
    const html = await (await realFetch(opened.url)).text()
    assert.match(html, /<title>登录科搭 Codar<\/title>/)
    assert.match(html, /手机号登录/, "the other way in is a tab on the same page")
    const qr = await (await realFetch(`${opened.url}qr`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()
    assert.equal(qr.scene, "s-9")
    const seen = await (await realFetch(`${opened.url}status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scene: "s-9" }) })).json()
    assert.equal(seen.state, "scanned")
    // the vendor calls are the plugin's, on the vendor's hosts, never the page's
    assert.ok(calls.every((c) => c.url.startsWith("https://api.kuaipaper.com/v1/wechat/login/")))
    // both are POSTs: the vendor's own helper defaults to it, and its qrcode
    // route answers a GET with "Method Not Allowed" (measured 2026-11-11)
    assert.deepEqual(calls.map((c) => c.method), ["POST", "POST"])
  } finally {
    // the sign-in ending (a cancel, or the host giving up) closes the page
    const waiting = opened?.callback?.()
    ctl.abort()
    await waiting?.catch?.(() => {})
    globalThis.fetch = realFetch
  }
  await assert.rejects(realFetch(opened.url), "the listener is closed with the sign-in")
})

test("an aborted SMS sign-in stops the page and answers nothing", async () => {
  const { startSignIn } = await import("../lib/signinpage.mjs")
  const sms = await startSignIn({ sendCode: async () => {}, verifyCode: async () => ({ token: TOKEN, username: "user_1" }) })
  const ctl = new AbortController()
  const waiting = sms.wait(ctl.signal)
  ctl.abort()
  assert.equal(await waiting, null, "an aborted sign-in is no sign-in")
  await assert.rejects(fetch(sms.url), "the listener is closed with it")
})

test("the sign-in page is one method the host can open, and it answers the token shape it renews", async () => {
  const p = await CodarPlugin()
  const m = p.auth.methods.find((x) => x.label === "科搭OAuth登录")
  assert.ok(m, "the sign-in page is offered")
  assert.equal(m.type, "oauth", "it opens a page, so it is the host's oauth shape")
  assert.equal(typeof m.authorize, "function")
})

test("an expired token is not sent, and says to sign in", async () => {
  const old = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) - 10 })
  const p = await CodarPlugin()
  await withFetch({}, async (calls) => {
    const r = await p.auth.checkin(async () => ({ type: "api", key: old }))
    assert.equal(r.outcome, "failed")
    assert.match(r.message, /过期/)
    assert.equal(calls.length, 0, "an expired token must not reach the vendor")
  })
})

test("check-in claims, reports the points it added, and reads the balance after", async () => {
  let points = 500
  const p = await CodarPlugin()
  const r = await withFetch(
    {
      "/v1/gettoken": () => {
        // the first read is before the claim, the second after it
        const now = points
        points += 50
        return new Response(JSON.stringify({ code: 200, token: now, agent_token: 1970 }), { status: 200 })
      },
      "/v1/daily-sign": { body: { code: 200, message: "Success" } },
    },
    async (calls) => {
      const out = await p.auth.checkin(auth)
      // two point reads: before and after
      assert.equal(calls.filter((c) => c.url.includes("/v1/gettoken")).length, 2)
      return out
    },
  )
  assert.equal(r.outcome, "claimed")
  assert.equal(r.credit, 50)
  assert.equal(r.message, "Success", "the vendor's own words are what the card says, not a line of ours")
})

test("the free-model campaign is claimed beside the check-in, and said on the card", async () => {
  // The vendor's activities page offers a one-time free-model campaign as a
  // button (packages/web index-*.js: rg posts /api/codar/activities/free-model
  // /claim when the GET said status "available" with an activity_id). The
  // check-in is the plugin's only act on the account, so it claims there.
  const p = await CodarPlugin()
  const r = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign": { body: { code: 200, message: "签到成功" } },
      "GET /api/codar/activities/free-model": { body: { code: 200, data: { status: "available", activity_id: 7, free_until: Math.floor(Date.now() / 1000) + 7 * 86400 } } },
      "POST /api/codar/activities/free-model/claim": { body: { code: 200, data: { ok: true } } },
    },
    async (calls) => {
      const out = await p.auth.checkin(auth)
      const claim = calls.filter((c) => c.url.includes("/activities/free-model/claim"))
      assert.equal(claim.length, 1, "the campaign is claimed once")
      assert.equal(claim[0].method, "POST")
      assert.equal(claim[0].url, "https://api.claw.speedai.com/api/codar/activities/free-model/claim", "the campaign lives on the gateway, not the account host")
      return out
    },
  )
  assert.equal(r.outcome, "claimed", "the claim does not change the check-in's outcome")
  assert.match(r.message, /签到成功/, "the vendor's own check-in words stay first")
  assert.match(r.message, /已领取免费模型/, "and the claim is said, or nothing on the card would say it")
})

test("a campaign that is not open is not claimed, and a refusal stays out of the check-in", async () => {
  const p = await CodarPlugin()
  const routes = {
    "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
    "/v1/daily-sign": { body: { code: 200, message: "签到成功" } },
  }
  const closed = await withFetch({ ...routes, "GET /api/codar/activities/free-model": { body: { code: 200, data: { status: "claimed", activity_id: 7 } } } }, async (calls) => {
    const out = await p.auth.checkin(auth)
    assert.equal(calls.filter((c) => c.url.includes("/free-model/claim")).length, 0, "a campaign already claimed is not asked for again")
    return out
  })
  assert.equal(closed.message, "签到成功", "and nothing is appended")

  const refused = await withFetch(
    {
      ...routes,
      "GET /api/codar/activities/free-model": { body: { code: 200, data: { status: "available", activity_id: 7 } } },
      "POST /api/codar/activities/free-model/claim": { status: 500, body: { message: "系统繁忙" } },
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(refused.outcome, "claimed", "a failed claim never fails the check-in")
  assert.equal(refused.message, "签到成功", "and never rewrites its words")
})

test("a claim the vendor refused is not reported as claimed", async () => {
  // The claim's own answer has to say it landed. A body carrying success:false
  // (flat or wrapped), or a code in words, was read as a claim: the card said
  // 已领取免费模型 over a campaign that was never opened, and the campaign was
  // recorded as done, so no later check-in tried again.
  const p = await CodarPlugin()
  const shapes = [
    ["flat false", { success: false, message: "今日已领取" }],
    ["flat false beside code 200", { code: 200, success: false, message: "系统繁忙" }],
    ["wrapped false", { code: 200, data: { success: false, message: "系统繁忙" } }],
    ["a code in words", { code: "already_claimed" }],
  ]
  for (const [i, [name, answer]] of shapes.entries()) {
    // its own account: the record of claimed campaigns is per account and
    // lives for the process, and a shared one would hide the second write
    const token = mkToken({ username: `user_claim_${i}`, exp: Math.floor(Date.now() / 1000) + 86400 })
    const call = () =>
      withFetch(
        {
          "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
          "/v1/daily-sign": { body: { code: 200, message: "签到成功" } },
          "GET /api/codar/activities/free-model": { body: { code: 200, data: { status: "available", activity_id: 7 } } },
          "POST /api/codar/activities/free-model/claim": { body: answer },
        },
        async (calls) => ({ out: await p.auth.checkin(async () => ({ type: "api", key: token })), writes: calls.filter((c) => c.url.includes("/free-model/claim")).length }),
      )
    const first = await call()
    assert.equal(first.out.outcome, "claimed", `${name}: the check-in itself is untouched`)
    assert.doesNotMatch(first.out.message, /已领取免费模型/, `${name}: a refusal is not a claim`)
    const again = await call()
    assert.equal(again.writes, 1, `${name}: the campaign was not recorded as claimed`)
  }
})

test("a second campaign in the same process is claimed, not skipped", async () => {
  // The guard remembers what was claimed so a vendor that keeps answering
  // "available" after a successful claim is not written to on every ask. Its
  // record is per campaign: keyed on the account alone, a campaign the vendor
  // opens later in the same process was never claimed at all.
  const username = "user_second_campaign"
  const token = mkToken({ username, exp: Math.floor(Date.now() / 1000) + 86400 })
  const p = await CodarPlugin()
  const claim = (activityId) =>
    withFetch(
      {
        "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
        "/v1/daily-sign": { body: { code: 200, message: "签到成功" } },
        "GET /api/codar/activities/free-model": { body: { code: 200, data: { status: "available", activity_id: activityId } } },
        "POST /api/codar/activities/free-model/claim": { body: { code: 200, data: { ok: true } } },
      },
      async (calls) => {
        const out = await p.auth.checkin(async () => ({ type: "api", key: token }))
        return { out, writes: calls.filter((c) => c.url.includes("/free-model/claim")).length }
      },
    )

  const first = await claim(101)
  assert.equal(first.writes, 1, "the first campaign is claimed")
  const again = await claim(101)
  assert.equal(again.writes, 0, "the same campaign is not written to twice")
  const second = await claim(202)
  assert.equal(second.writes, 1, "a campaign the vendor opened later is its own campaign")
})

test("two check-ins at once claim one campaign, not two", async () => {
  // The host can ask for the check-in twice at once. The record of what was
  // claimed is only written when the claim answers, so a guard that reads it
  // first and writes later let both calls write: two claims for one campaign,
  // and the second one's refusal overwriting the first one's success. The
  // in-flight promise is what makes the second call wait for the first.
  const p = await CodarPlugin()
  const token = mkToken({ username: "user_concurrent_claim", exp: Math.floor(Date.now() / 1000) + 86400 })
  let claims = 0
  const out = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign": { body: { code: 200, message: "签到成功" } },
      "GET /api/codar/activities/free-model": { body: { code: 200, data: { status: "available", activity_id: 99 } } },
      "POST /api/codar/activities/free-model/claim": async () => {
        claims += 1
        await new Promise((r) => setTimeout(r, 60))
        return new Response(JSON.stringify({ code: 200, data: { ok: true } }), { status: 200, headers: { "Content-Type": "application/json" } })
      },
    },
    async () => Promise.all([p.auth.checkin(async () => ({ type: "api", key: token })), p.auth.checkin(async () => ({ type: "api", key: token }))]),
  )
  assert.equal(claims, 1, "the campaign is written once")
  assert.equal(out.length, 2, "and both check-ins answered")
  assert.ok(out.every((r) => r.outcome === "claimed"))
})

test("a campaign read a level in refused is not claimed", async () => {
  // The GET's refusal can sit inside the wrapper (`{code:200, data:{success:
  // false, data:{status:"available"…}}}`). Read as available, the plugin spent
  // the claim write on an answer that had just refused it.
  const p = await CodarPlugin()
  const refusals = [
    { code: 200, data: { success: false, data: { status: "available", activity_id: 11 } } },
    { code: 200, data: { data: { code: "already_claimed" }, status: "available", activity_id: 11 } },
  ]
  for (const [i, got] of refusals.entries()) {
    const token = mkToken({ username: `user_campaign_${i}`, exp: Math.floor(Date.now() / 1000) + 86400 })
    await withFetch(
      {
        "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
        "/v1/daily-sign": { body: { code: 200, message: "签到成功" } },
        "GET /api/codar/activities/free-model": { body: got },
        "POST /api/codar/activities/free-model/claim": { body: { code: 200, data: { ok: true } } },
      },
      async (calls) => {
        const out = await p.auth.checkin(async () => ({ type: "api", key: token }))
        assert.equal(calls.filter((c) => c.url.includes("/free-model/claim")).length, 0, `shape ${i}: a refused read is not claimed`)
        assert.equal(out.message, "签到成功", `shape ${i}: and nothing is appended`)
      },
    )
  }
})

test("the claim's sentence leaves the vendor's words room to be cut, not cut short", async () => {
  // The card reads at most 400 code points, and the vendor's own words are cut
  // to that bound. Cutting first and appending the claim afterwards pushed the
  // whole "；已领取免费模型" past the bound, so the card never said it.
  const p = await CodarPlugin()
  const long = "签".repeat(500)
  const r = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign": { body: { code: 200, message: long } },
      "GET /api/codar/activities/free-model": { body: { code: 200, data: { status: "available", activity_id: 303 } } },
      "POST /api/codar/activities/free-model/claim": { body: { code: 200, data: { ok: true } } },
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal([...r.message].length, 400, "the card's bound still holds")
  assert.match(r.message, /已领取免费模型$/, "and the claim survives at the end of it")
})

test("a check-in that did not land claims nothing", async () => {
  // The campaign claim rides on the check-in; a check-in refused before it
  // settles (an expired sign-in, a vendor refusal) must not start a claim.
  const p = await CodarPlugin()
  const old = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) - 10 })
  const r = await withFetch({}, async (calls) => {
    const out = await p.auth.checkin(async () => ({ type: "api", key: old }))
    assert.equal(calls.length, 0, "nothing is sent, and no claim is attempted")
    return out
  })
  assert.equal(r.outcome, "failed")

  // The other shape of "did not land": the sign-in is good, the check-in goes
  // out, and the vendor refuses it. The campaign is still not read and not
  // written — a claim riding on a refusal would claim a day that is not the
  // person's.
  for (const refusal of [
    { "/v1/daily-sign": { status: 500, body: { message: "系统繁忙" } } },
    { "/v1/daily-sign": { body: { code: 403, message: "账号 API 访问受限" } } },
  ]) {
    const refused = await withFetch(
      { "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } }, ...refusal },
      async (calls) => {
        const out = await p.auth.checkin(auth)
        assert.equal(
          calls.filter((c) => c.url.includes("free-model")).length,
          0,
          `a refused check-in still asked for the campaign: ${calls.map((c) => c.url).join(", ")}`,
        )
        return out
      },
    )
    assert.equal(refused.outcome, "failed", "a refused check-in is a failure")
  }
})

test("already claimed today is `done`, with when to come back", async () => {
  const p = await CodarPlugin()
  const before = Date.now()
  const r = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign": { body: { code: 400, message: "24小时内仅可领取一次", data: { retry_after: 3600 } } },
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(r.outcome, "done")
  assert.match(r.message, /1 小时/)
  // until is magpie 0.1.1795's field: when this answer stops holding. Codar's
  // day is a rolling 24 hours, so it is exactly retry_after from now — said,
  // magpie stops re-asking a done account every 30 minutes before noon.
  assert.ok(r.until >= before + 3600 * 1000 && r.until <= Date.now() + 3600 * 1000, "the answer holds until the vendor's own next claim time")

  const noWait = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign": { body: { code: 400, message: "24小时内仅可领取一次" } },
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(noWait.outcome, "done")
  // A done with no until is settled for the whole day by magpie — and a
  // rolling 24-hour window would then lose the next claim. The floor is
  // "how long this answer is trusted", not an invented claim time.
  assert.ok(noWait.until > Date.now() && noWait.until <= Date.now() + 31 * 60 * 1000, "a vendor that names no time gets a bounded hold, not the whole day")
})

test("a claim the vendor confirmed without a code is a claim, not a failure", async () => {
  // The vendor's own check-in reads the answer through ft alone (app.asar's
  // k0): only a code that is a number other than 200 is a refusal, so an
  // answer that names no code is the claim it says it is. Read as `code ===
  // 200`, one said {"message":"Success","success":true} came back `failed` —
  // and the vendor's activity API already answers without a code today.
  const p = await CodarPlugin()
  const r = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign": { body: { message: "Success", success: true } },
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(r.outcome, "claimed")
  assert.equal(r.credit, 0, "no second balance read means no credit, not a made-up one")

  // The one flag the vendor does use for a refusal is read: success:false is
  // a failure the user should see, not a day magpie then settles.
  const no = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign": { body: { message: "系统繁忙", success: false } },
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(no.outcome, "failed")
  assert.match(no.message, /系统繁忙/)

  // …and it is a sufficient condition: a code:200 body that says success:false
  // is the HTTP layer saying yes and the vendor saying no — "the HTTP layer said yes, the business layer said no" — so the flag decides, not the code. It used to be consulted
  // only when the body named no code at all, so this exact shape was read as
  // a claim (and settled the day in magpie).
  const noWithCode = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign": { body: { code: 200, success: false, message: "签到失败，请稍后重试" } },
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(noWithCode.outcome, "failed", "success:false with a code is a refusal too")
  assert.match(noWithCode.message, /签到失败/)
  assert.equal(noWithCode.credit, undefined, "and no balance is read for a claim that did not happen")

  // A refusal that names neither a code nor a message is still a refusal, and
// the card says so in words. It used to print the vendor's words — a
  // question mark where a code goes, on a card the user cannot act on.
  const noWords = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign": { body: { success: false } },
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(noWords.outcome, "failed")
  assert.equal(noWords.message, "签到失败", "no code stated means no code printed, not a question mark")
})

test("a 200 JSON that says no claim is no claim", async () => {
  // A gateway or WAF that answers 200 with an empty object, a list, or a
  // `{"ok":true}` envelope is not the vendor confirming a claim. Read as a
  // claim, such a body settled the day at zero points and magpie stopped
  // asking; a claim now needs one positive signal — code 200, success true,
  // or the vendor's own success wording — and anything else is a failure the
  // host will retry.
  const p = await CodarPlugin()
  for (const [body, words] of [[{}, ""], [[], ""], [{ ok: true }, ""], [{ data: {} }, ""], [{ message: "系统维护中" }, "系统维护中"]]) {
    const r = await withFetch(
      {
        "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
        "/v1/daily-sign": { body },
      },
      async () => p.auth.checkin(auth),
    )
    assert.equal(r.outcome, "failed", `${JSON.stringify(body)} says nothing about a claim`)
    assert.equal(r.credit, undefined, "and nothing claims points for it")
    if (words) assert.match(r.message, new RegExp(words), "the vendor's own words are what the card says")
    else assert.match(r.message, /签到失败/, "and with no words at all it names the failure itself")
  }
  // a 200 whose words are the vendor's success wording is still a claim
  const said = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign": { body: { message: "领取成功" } },
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(said.outcome, "claimed", "the vendor's own success words are the signal they are")
})

test("an already-claimed answer is read in every spelling the vendor's client reads", async () => {
  // The vendor's client reads an answer's words as the first of message, msg,
  // error, detail — and the same four under `data` (app.asar's vo). Read as
  // `message` alone, an "already claimed" note spelled `msg` or under `data`
  // came out as no text at all, and the card said the check-in failed over a
  // day that was simply already claimed.
  const p = await CodarPlugin()
  const said = [
    { code: 400, message: "24小时内仅可领取一次" },
    { code: 400, msg: "24小时内仅可领取一次" },
    { code: 400, detail: "24小时内仅可领取一次" },
    { code: 400, data: { message: "24小时内仅可领取一次", retry_after: 900 } },
  ]
  for (const body of said) {
    const r = await withFetch(
      {
        "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
        "/v1/daily-sign": { body },
      },
      async () => p.auth.checkin(auth),
    )
    assert.equal(r.outcome, "done", `${JSON.stringify(body)} is "already claimed", not a failure`)
    assert.ok(r.until > Date.now(), "and it still says when to come back")
  }
  // a refusal the vendor spelled under `data` still says what it said
  const busy = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign": { body: { code: 500, data: { msg: "系统繁忙" } } },
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(busy.outcome, "failed")
  assert.match(busy.message, /系统繁忙/, "the vendor's own words, from whichever field it used")

  // a refusal that says nothing at all still names its code
  const mute = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign": { body: { code: 503 } },
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(mute.outcome, "failed")
  assert.match(mute.message, /code 503/)
})

test("a free-model read the vendor refused draws nothing, however it is shaped", async () => {
  // The vendor's own client refuses an answer whose code is a number other
  // than 200 before it reads the list (app.asar's EI calls ft first), so a
  // refusal carrying a data array is not a running activity. Today's activity
  // body has no code at all (only data, message and success), so the gate is
  // silent on it.
  const until = Math.floor(Date.now() / 1000) + 3600
  const p = await CodarPlugin()
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: false } } },
      "/api/codar/activities/mine": { body: { code: 500, message: "系统繁忙", data: [{ free_until: until, remaining_quota: null, model_ids: ["a"] }] } },
    },
    async () => p.auth.usage(auth),
  )
  assert.equal(u.error, undefined, "the points still make a card")
  assert.equal(u.windows.filter((w) => w.name.startsWith("免费模型")).length, 0, "a refused read is not an activity")

  // the same list with no code on the answer is the vendor's own shape: drawn
  const ok = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: false } } },
      "/api/codar/activities/mine": { body: { data: [{ free_until: until, remaining_quota: null, model_ids: ["a"] }], message: "ok", success: true } },
    },
    async () => p.auth.usage(auth),
  )
  assert.equal(ok.windows.filter((w) => w.name.startsWith("免费模型")).length, 1, "a body with no code is read as the vendor sends it")
})

test("an expiry the token spells as a string is an expiry, not something open-ended", () => {
  // The vendor's own client reads exp as a number or as a string that says
  // one (app.asar's Zh: typeof i == "number" ? i : Number(i)). Read as a
  // number alone, a token whose exp came back as "1793334853" was taken for
  // one that never runs out, and the plugin sent it: every endpoint answers
  // 401 and the card says the check-in failed instead of asking to sign in.
  const soon = Math.floor(Date.now() / 1000) + 60
  const stringy = mkToken({ username: "user_1", exp: String(soon) })
  assert.equal(expiresAt(stringy), soon * 1000, "a numeric string is a number")
  assert.ok(expiresAt(mkToken({ username: "user_1", exp: String(soon - 3600) })) < Date.now(), "and one in the past has run out")
  assert.equal(expiresAt(mkToken({ username: "user_1", exp: "later" })), 0, "words are not a time")
  assert.equal(expiresAt(mkToken({ username: "user_1", exp: true })), 0, "nor is a flag: Number(true) is 1, which is 1970")
  assert.equal(expiresAt(mkToken({ username: "user_1" })), 0, "and a token that says nothing says nothing")
})

test("a string expiry in the past is not sent, and asks for a sign-in", async () => {
  const past = mkToken({ username: "user_1", exp: String(Math.floor(Date.now() / 1000) - 60) })
  const p = await CodarPlugin()
  const calls = await withFetch({}, async (c) => {
    const r = await p.auth.checkin(async () => ({ type: "api", key: past }))
    assert.equal(r.outcome, "failed")
    assert.match(r.message, /重新登录/)
    return c
  })
  assert.equal(calls.length, 0, "an expired token must not reach the vendor")

  // an exp that names the epoch is a stated time that has passed, not the
  // "says nothing" reading a bare 0 ms would give it
  const epoch = mkToken({ username: "user_1", exp: 0 })
  const second = await withFetch({}, async (c) => {
    const r = await p.auth.checkin(async () => ({ type: "api", key: epoch }))
    assert.equal(r.outcome, "failed")
    assert.match(r.message, /重新登录/)
    return c
  })
  assert.equal(second.length, 0, "a token that says 1970 has run out")
})

test("a wait the daily window cannot produce gets the trust floor, not a time handed on", async () => {
  // A time handed on has to sit under two ceilings: host.js's checkinOf does
  // new Date(t).toISOString(), which throws RangeError past 8.64e15; and
  // magpie's Go side parses the ISO string with RFC3339's four-digit year, so
  // a "+275760-…" string parses to zero and the time is dropped — "done with
  // no until" then settles the whole day. And a wait has to be one Codar's
  // own day can produce: it rolls 24 hours (measured retry_after ≈ 23 h), so
  // 1e9 seconds is 31 years and magpie would not ask again until 2058. Each
  // of these is not a time this answer can hold on: it gets the same
  // 30-minute trust floor as a vendor that named none.
  const p = await CodarPlugin()
  for (const retry_after of [1e9, 1e13, 1e15, Number.MAX_SAFE_INTEGER, 1e308]) {
    const r = await withFetch(
      {
        "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
        "/v1/daily-sign": { body: { code: 400, message: "24小时内仅可领取一次", data: { retry_after } } },
      },
      async () => p.auth.checkin(auth),
    )
    assert.equal(r.outcome, "done")
    assert.ok(Number.isFinite(r.until), `retry_after ${retry_after} still gives a finite until`)
    const iso = new Date(r.until).toISOString()
    assert.match(iso, /^\d{4}-\d{2}-\d{2}T/, "a four-digit year, as Go's RFC3339 parse needs")
    assert.ok(r.until > Date.now() && r.until <= Date.now() + 31 * 60 * 1000, "the floor, not a day settled for decades")
    assert.doesNotMatch(r.message, /年|2058|11574 天/, "and the card does not repeat the number it cannot use")
  }

  // a wait the window can produce — up to a week — is handed on as it is
  const before = Date.now()
  const near = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign": { body: { code: 400, message: "24小时内仅可领取一次", data: { retry_after: 6 * 24 * 3600 } } },
    },
    async () => p.auth.checkin(auth),
  )
  assert.ok(near.until >= before + 6 * 24 * 3600 * 1000 && near.until <= Date.now() + 6 * 24 * 3600 * 1000, "six days is a wait a daily window can name")
  assert.match(near.message, /6 天后可再领/)

  // a vendor number that is not finite at all still yields a usable answer
  const inf = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      // 1e999 is valid JSON and parses to Infinity: withFetch would re-encode
      // it as null, so the answer is handed over as raw text
      "/v1/daily-sign": () => new Response('{"code":400,"message":"24小时内仅可领取一次","data":{"retry_after":1e999}}', { status: 200, headers: { "Content-Type": "application/json" } }),
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(inf.outcome, "done")
  assert.match(inf.message, /今天已领过/, "no \"Infinity 天\" on the card")
  assert.doesNotMatch(inf.message, /Infinity/)
  assert.ok(Number.isFinite(inf.until), "and a usable until")
})

test("a 401 from the sign-in endpoint is said as an expired sign-in", async () => {
  const p = await CodarPlugin()
  const r = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 1, agent_token: 0 } },
      "/v1/daily-sign": { status: 401, body: { detail: "Not authenticated" } },
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(r.outcome, "failed")
  assert.match(r.message, /过期/)
})

test("a body we do not recognise fails instead of reading as claimed", async () => {
  const p = await CodarPlugin()
  const r = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 1, agent_token: 0 } },
      "/v1/daily-sign": { body: { code: 500, message: "系统繁忙" } },
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(r.outcome, "failed")
  assert.match(r.message, /系统繁忙/)
})

test("usage reports both balances and the claim window", async () => {
  const p = await CodarPlugin()
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 1970 } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true, retry_after: 7200 } } },
      "/api/codar/activities/mine": { body: { code: 200, data: [] } },
    },
    async () => p.auth.usage(auth),
  )
  assert.equal(u.user, "user_1")
  assert.match(u.balance, /500/)
  assert.match(u.balance, /1970/)
  const win = u.windows.find((w) => w.name === "每日签到")
  assert.ok(win, "the claim window is there")
  assert.equal(win.used, undefined, "a check-in is not a share of an allowance: no used, so the host shows it as its text")
  assert.equal(win.aside, true, "and it is set aside, which is what makes the host read it as text")
  assert.ok(win.resetsAt > Date.now())
})

test("a balance that cannot be read fails the read, it does not become 0", async () => {
  const p = await CodarPlugin()
  const u = await withFetch({ "/v1/gettoken": { status: 500, body: { detail: "boom" } } }, async () => p.auth.usage(auth))
  assert.ok(u.error, "an unreadable balance is an error, not an empty card")
})

test("the claim row reads the vendor client's own spellings", async () => {
  // The vendor's client (app.asar's um) reads the state as the boolean data
  // itself or from any of four field names, each only as a real boolean. A
// rename its client still handles must not turn a claimed day into the vendor's words.
  const p = await CodarPlugin()
  const row = async (statusData) => {
    const u = await withFetch(
      {
        "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
        "/v1/daily-sign/status": { body: { code: 200, data: statusData } },
        "/api/codar/activities/mine": { body: { code: 200, data: [] } },
      },
      async () => p.auth.usage(auth),
    )
    return u.windows.find((w) => w.name === "每日签到")
  }
  assert.equal((await row({ signed: true })).display, "今天已领", "the client's `signed`")
  assert.equal((await row({ hasSigned: true })).display, "今天已领", "and `hasSigned`")
  assert.equal((await row({ has_signed: true })).display, "今天已领", "and `has_signed`")
  assert.equal((await row(true)).display, "今天已领", "a boolean answer is the state itself")
  assert.equal((await row(false)).display, "今天还没领，现在可以领")
  assert.equal((await row({ isSigned: "true" })).display, "今天还没领，现在可以领", "a string is not a boolean: Boolean(\"false\") is true")
  // the shapes the client does not read are no state at all: a string is
// truthy and an array is an object, so a looser test drew the vendor's words over
  // data the vendor never meant as a state
  for (const data of ["yes", [true], 1]) {
    assert.equal(await row(data), undefined, `data ${JSON.stringify(data)} is not a claim state`)
  }
  // an object that names no state field says nothing about the day: drawing
// the vendor's words over it offered a claim the account may not have
  assert.equal(await row({}), undefined, "an empty object names no state")
  assert.equal(await row({ retry_after: 60 }), undefined, "nor does one that only says when the next window opens")
  assert.equal((await row({ isSigned: "false", retry_after: 60 })).display, "今天还没领，1 分钟后可以领", "but a named field read strictly still draws the row")
})

test("the balances are read by the vendor client's own names", async () => {
  // app.asar's am reads general points by token/remaining_points/points/
  // balance and agent points by agent_token/agentToken/agent_points/
  // agentPoints; a rename its client still handles must not fail the card.
  const p = await CodarPlugin()
  const read = async (body) =>
    withFetch(
      {
        "/v1/gettoken": { body: { code: 200, ...body } },
        "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true } } },
        "/api/codar/activities/mine": { body: { code: 200, data: [] } },
      },
      async () => p.auth.usage(auth),
    )
  assert.match((await read({ remaining_points: 500 })).balance, /500 点/)
  assert.match((await read({ points: 500 })).balance, /500 点/)
  assert.match((await read({ balance: 500 })).balance, /500 点/)
  assert.match((await read({ agentToken: 7 })).balance, /Agent 7 点/)
  assert.match((await read({ agent_points: 7 })).balance, /Agent 7 点/)
  assert.match((await read({ agentPoints: 7 })).balance, /Agent 7 点/)
})

test("a negative reading is not a balance", async () => {
  // The host clamps a wallet reading to 0, so passing a negative on would put
// the vendor's words on the card beside a routing figure of 0 — two answers, neither
  // true. Nothing usable left is an error, as with any other unreadable read.
  const p = await CodarPlugin()
  const read = async (body) =>
    withFetch(
      {
        "/v1/gettoken": { body: { code: 200, ...body } },
        "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true } } },
        "/api/codar/activities/mine": { body: { code: 200, data: [] } },
      },
      async () => p.auth.usage(auth),
    )
  const neg = await read({ token: -5, agent_token: 3 })
  assert.equal(neg.windows.find((w) => w.name === "点数余额"), undefined, "a negative is not a balance")
  assert.doesNotMatch(neg.balance, /-5/)
  assert.match(neg.balance, /Agent 3 点/)

  const none = await read({ token: -5, agent_token: -1 })
  assert.match(none.error, /没有返回余额/, "nothing usable is an error, not a made-up 0")
})

test("a claim row's wait past the daily window carries no time", async () => {
  // The same week ceiling the check-in holds to: 1e9 seconds is 31 years, a
  // next-claim time the rolling 24-hour window cannot produce.
  const p = await CodarPlugin()
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true, retry_after: 1e9 } } },
      "/api/codar/activities/mine": { body: { code: 200, data: [] } },
    },
    async () => p.auth.usage(auth),
  )
  const win = u.windows.find((w) => w.name === "每日签到")
  assert.ok(win, "the row is still there")
  assert.equal("resetsAt" in win, false, "and carries no time it cannot use")
  assert.equal(win.display, "今天已领")
})

test("a token the vendor turns away is an error on the card, not an empty one", async () => {
  // The account API refuses with HTTP 200 and a body code (measured
  // 2026-10-27: {"code":401,"message":"Invalid token"} from /v1/gettoken).
  // Read as "two fields we cannot see", the card came out blank with no
  // error and no expired mark, while the same token's check-in said to sign
  // in again.
  const p = await CodarPlugin()
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 401, message: "Invalid token" } },
      "/v1/daily-sign/status": { body: { code: 401, message: "Invalid token" } },
      "/api/codar/activities/mine": { status: 401, body: { detail: "Invalid or expired token" } },
    },
    async () => p.auth.usage(auth),
  )
  assert.match(u.error, /登录已过期/, "a refused token is said in words, not left as a blank card")
  assert.equal(u.signIn, "expired", "and marks the sign-in for magpie")

  const busy = await withFetch(
    { "/v1/gettoken": { body: { code: 500, message: "系统繁忙" } } },
    async () => p.auth.usage(auth),
  )
  assert.match(busy.error, /系统繁忙/, "another body code is its own error, not an empty card")
  assert.equal(busy.signIn, "", "and is not mistaken for an expired sign-in")

  // The vendor's words are read the way its client reads them (vo): any of
  // message/msg/error/detail, or the same four under `data`. Read as
  // `message` alone, a refusal spelled `msg` came back as a bare code.
  const spelled = await withFetch(
    { "/v1/gettoken": { body: { code: 500, msg: "点数服务繁忙" } } },
    async () => p.auth.usage(auth),
  )
  assert.match(spelled.error, /点数服务繁忙/, "a msg-spelled refusal keeps its words")
  const wrapped = await withFetch(
    { "/v1/gettoken": { body: { code: 500, data: { message: "点数服务繁忙" } } } },
    async () => p.auth.usage(auth),
  )
  assert.match(wrapped.error, /点数服务繁忙/, "and so does one under data")
})

test("the claim window is on the card the moment it opens", async () => {
  // The card only drew the window while retry_after > 0, so at the moment
  // the wait ran out the row vanished — exactly when it should say it can
  // be claimed now.
  const p = await CodarPlugin()
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: false, retry_after: 0 } } },
      "/api/codar/activities/mine": { body: { code: 200, data: [] } },
    },
    async () => p.auth.usage(auth),
  )
  const win = u.windows.find((w) => w.name === "每日签到")
  assert.ok(win, "the window is still on the card when the wait is over")
  assert.equal(win.used, undefined)
  assert.match(win.display, /现在可以领/)

  const bad = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 1, agent_token: 0 } },
      "/v1/daily-sign/status": { body: { code: 401, message: "Invalid token" } },
      "/api/codar/activities/mine": { body: { code: 200, data: [] } },
    },
    async () => p.auth.usage(auth),
  )
  assert.equal(bad.windows.find((w) => w.name === "每日签到"), undefined, "a status body we cannot read is no claim window")
})

test("activities that are still running become windows; a failed read does not sink the card", async () => {
  const until = Math.floor(Date.now() / 1000) + 3600
  const p = await CodarPlugin()
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: false, retry_after: 60 } } },
      "/api/codar/activities/mine": {
        body: {
          code: 200,
          data: [
            { status: "active", free_until: until, remaining_quota: null, user_quota_limit: null, model_ids: ["a", "b"] },
            { status: "active", free_until: until - 7200, remaining_quota: 10, user_quota_limit: 100, model_ids: ["c"] },
          ],
        },
      },
    },
    async () => p.auth.usage(auth),
  )
  const free = u.windows.filter((w) => w.name.startsWith("免费模型"))
  assert.equal(free.length, 1, "only the one still running")
  assert.equal(free[0].resetsAt, until * 1000, "ms, as magpie's when() reads a number past 1e11")
  assert.equal(free[0].aside, true, "using the activity up does not stop the account")
  assert.match(free[0].name, /a、b/, "the window names the activity's own models")
  // The window must not carry `models`: it is aside, so routing never reads
  // it and the GUI has no field for it — while any window with `models` keeps
  // the whole card out of quotas.json (quota_last.go keepLast).
  assert.equal(free[0].models, undefined, "no models on the window: it would cost the card its last reading on disk")
  assert.equal(free[0].used, undefined, "an unlimited activity has no share to tell: the host reads used: 0 as a share of 0%, not as 'not said'")
  assert.equal(free[0].amount, undefined, "and no invented count")

  const capped = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: false, retry_after: 60 } } },
      "/api/codar/activities/mine": {
        body: { code: 200, data: [{ status: "active", free_until: until, remaining_quota: 25, user_quota_limit: 100, model_ids: ["c"] }] },
      },
    },
    async () => p.auth.usage(auth),
  )
  const one = capped.windows.find((w) => w.name.startsWith("免费模型"))
  assert.equal(one.used, 75, "amount is what is used of the limit: 100 given, 25 left")
  assert.equal(one.amount, 75, "amount of limit used")
  assert.equal(one.limit, 100, "the activity's own total")

  const u2 = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign/status": { status: 500, body: { detail: "boom" } },
      "/api/codar/activities/mine": { status: 500, body: { detail: "boom" } },
    },
    async () => p.auth.usage(auth),
  )
  assert.equal(u2.error, undefined, "the extra reads failing must not sink the balance")
  assert.match(u2.balance, /500/)
})

test("a free activity is drawn by the vendor app's own rule, and no other", async () => {
  // The desktop app decides with free_until and remaining_quota alone (its
  // own filter, read out of app.asar): a status it does not read decides
  // nothing, while a quota it does read that says "spent" means these
  // models are not free anymore.
  const now = Math.floor(Date.now() / 1000)
  const p = await CodarPlugin()
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true, retry_after: 60 } } },
      "/api/codar/activities/mine": {
        body: {
          code: 200,
          data: [
            { status: "ended", free_until: now + 3600, remaining_quota: null, model_ids: ["a"] },
            { status: "active", free_until: now - 3600, remaining_quota: null, model_ids: ["b"] },
            { status: "active", free_until: now + 3600, remaining_quota: 0, model_ids: ["c"] },
            { status: "active", free_until: now + 3600, remaining_quota: null, model_ids: ["d"] },
          ],
        },
      },
    },
    async () => p.auth.usage(auth),
  )
  const free = u.windows.filter((w) => w.name.startsWith("免费模型"))
  assert.equal(free.length, 2, "the ended one and the spent one are not drawn")
  assert.ok(free.some((w) => w.name.includes("a")), "a status the app doesn't read does not hide a running activity")
  assert.ok(free.some((w) => w.name.includes("d")))
})

test("the usage reads go out together, and a dead balance still reads the rest", async () => {
  // The card waits for the slowest read, not for four in a row. All four are
  // launched before any is awaited: a points read that fails must not stop the
  // others from having been asked, and they must overlap in flight (inFlight
  // reaches 4) rather than run one after another.
  //
  // The second balance read is part of that batch, not a fallback behind it:
  // the vendor's own client asks the two balances together (app.asar's S0 is
  // an allSettled over /v1/gettoken, /v1/agent/balance and /api/user/self),
  // and a read that only ever starts after the first one settles makes the
  // hook's worst case two timeouts, which is what magpie's 20-second deadline
  // has no room for (the host runs fresh() and a cold infoOf() before it).
  const p = await CodarPlugin()
  const seen = []
  let inFlight = 0
  let most = 0
  const real = globalThis.fetch
  globalThis.fetch = async (url) => {
    seen.push(String(url))
    inFlight++
    most = Math.max(most, inFlight)
    // all of them must be in before any answer goes out; a serial run would
    // hold each of these until the timeout
    await new Promise((ok) => setTimeout(ok, 15))
    inFlight--
    if (String(url).includes("/v1/gettoken")) return new Response(JSON.stringify({ detail: "boom" }), { status: 500 })
    if (String(url).includes("/v1/agent/balance")) return new Response(JSON.stringify({ detail: "boom" }), { status: 500 })
    if (String(url).includes("/v1/daily-sign/status")) return new Response(JSON.stringify({ code: 200, data: { isSigned: true, retry_after: 60 } }), { status: 200 })
    return new Response(JSON.stringify({ code: 200, data: [] }), { status: 200 })
  }
  try {
    const u = await p.auth.usage(auth)
    assert.ok(u.error, "both balance reads failing is the card's error")
    assert.equal(seen.length, 4, "the two balance reads, the status and the activity list")
    assert.equal(most, 4, "all four overlapped in flight, not one after another")
  } finally {
    globalThis.fetch = real
  }
})

test("the models hook replaces the list with the vendor's, and falls back to it", async () => {
  const p = await CodarPlugin()
  // the host hands the hook the whole provider; the list is provider.models,
  // and the host reads the answer as the list itself (host.js info()).
  const given = { id: "codar", name: "科搭 Codar", api: "https://api.claw.speedai.com/v1", models: { "deepseek-v4.1-flash": modelOf({ id: "deepseek-v4.1-flash", context: 1000000 }) } }

  const fresh = await withFetch(
    {
      "/v1/codar/models": {
        body: {
          catalog: {
            data: [
              { id: "new-model", display_name: "New", context_window: 2000, input_modalities: ["text"], output_modalities: ["text"], protocol: { type: "openai_chat_completions" } },
            ],
          },
        },
      },
    },
    async () => p.provider.models(given, { auth: await auth() }),
  )
  assert.deepEqual(Object.keys(fresh), ["new-model"])

  const fell = await withFetch({ "/v1/codar/models": { status: 500, body: { detail: "boom" } } }, async () =>
    p.provider.models(given, { auth: await auth() }),
  )
  assert.deepEqual(Object.keys(fell), ["deepseek-v4.1-flash"], "the list it was given is kept")
  assert.equal(fell[Symbol.for("magpie.fellBack")], true, "and says the vendor was not reached")
})

test("the live list keeps models the user added, and follows the vendor for its own", async () => {
  // The config hook keeps entries the user added to the provider; the live
  // refresh used to replace the whole list, dropping them while signed in.
  const p = await CodarPlugin()
  const given = {
    id: "codar",
    models: {
      [LISTED_ID]: modelOf({ id: LISTED_ID }),
      "my-model": { name: "自建", api: { id: "my-model", url: "https://api.claw.speedai.com/v1", npm: "@ai-sdk/openai-compatible" } },
    },
  }
  const fresh = await withFetch(
    {
      "/v1/codar/models": {
        body: { catalog: { data: [{ id: "new-model", display_name: "New", protocol: { type: "openai_chat_completions" } }] } },
      },
    },
    async () => p.provider.models(given, { auth: await auth() }),
  )
  assert.deepEqual(Object.keys(fresh).sort(), ["my-model", "new-model"], "the vendor's list plus the user's own entry")
  assert.equal(fresh[LISTED_ID], undefined, "a model the vendor dropped is gone")
})

test("the live hook keeps the base the user set, model by model", async () => {
  // magpie picks a model's base as firstOf(o.BaseURL, m.URL, pp.API, …) — a
  // URL written on the model wins over the provider's. The list used to carry
  // the vendor's gateway on every model, so a provider pointed at the user's
  // own proxy went through the vendor the moment a live refresh succeeded;
  // the proxy held only while the config list was the one in use.
  const p = await CodarPlugin()
  const given = {
    id: "codar",
    api: "https://proxy.example/v1",
    models: { "deepseek-v4.1-flash": modelOf({ id: "deepseek-v4.1-flash" }, "https://only-this-one.example") },
  }
  const fresh = await withFetch(
    {
      "/v1/codar/models": {
        body: {
          catalog: {
            data: [
              { id: "deepseek-v4.1-flash", protocol: { type: "openai_chat_completions" } },
              { id: "new-model", protocol: { type: "openai_chat_completions" } },
            ],
          },
        },
      },
    },
    async () => p.provider.models(given, { auth: await auth() }),
  )
  assert.equal(fresh["deepseek-v4.1-flash"].api.url, "https://only-this-one.example", "a model's own base wins over the provider's")
  assert.equal(fresh["new-model"].api.url, "https://proxy.example", "one without takes the provider's, not the vendor's")
  const bare = await withFetch(
    { "/v1/codar/models": { body: { catalog: { data: [{ id: "solo", protocol: { type: "openai_chat_completions" } }] } } } },
    async () => p.provider.models({ id: "codar", models: {} }, { auth: await auth() }),
  )
  assert.equal(bare["solo"].api.url, "https://api.claw.speedai.com", "with nothing set anywhere, the vendor's gateway")
})

test("the models hook hands back the list, never the provider around it", async () => {
  // host.js: `out.models = Object.fromEntries(Object.entries(next ?? {})…)` —
  // the answer is used as the model list itself. Handing back the provider
  // would list its fields (id, name, api, searches, models…) as models.
  const p = await CodarPlugin()
  const given = { id: "codar", name: "科搭 Codar", api: "https://api.claw.speedai.com/v1", models: { "deepseek-v4.1-flash": modelOf({ id: "deepseek-v4.1-flash" }) } }

  const old = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) - 60 })
  const lapsed = await p.provider.models(given, { auth: { type: "api", key: old } })
  assert.deepEqual(Object.keys(lapsed), ["deepseek-v4.1-flash"], "an expired sign-in keeps the list, not the provider")
  assert.equal(lapsed[Symbol.for("magpie.fellBack")], undefined, "nothing was tried, so nothing fell back")

  const signedOut = await p.provider.models(given, { auth: undefined })
  assert.deepEqual(Object.keys(signedOut), ["deepseek-v4.1-flash"])
})

test("the config hook names the provider and lists the catalog", async () => {
  const p = await CodarPlugin()
  const config = {}
  await p.config(config)
  assert.equal(config.provider.codar.name, "科搭 Codar")
  assert.equal(config.provider.codar.api, "https://api.claw.speedai.com/v1")
  assert.ok(config.provider.codar.models[LISTED_ID])
  assert.ok(config.provider.codar.models[ANTHROPIC_ID], "the anthropic models are listed too")
})

test("the config hook writes the user's own base onto each model", async () => {
  // host.js reads a config model's base as m.provider?.api ?? cfg.api — not
  // the model's own api.url — so the proxy held on that path either way. The
  // models the hook stores still say the address their requests will go to:
  // a file that names the vendor's gateway under a provider pointed
  // elsewhere is a file that lies about the next start. The model's own URL
  // is the bare base: magpie joins its SDK's "/v1" onto it itself (plugins.go).
  const p = await CodarPlugin()
  const config = { provider: { codar: { api: "https://proxy.example/v1" } } }
  await p.config(config)
  assert.equal(config.provider.codar.api, "https://proxy.example/v1", "the provider keeps the user's api")
  assert.equal(config.provider.codar.models[LISTED_ID].api.url, "https://proxy.example", "and each model is written at it, not at the vendor's gateway")
  assert.equal(config.provider.codar.models[ANTHROPIC_ID].api.npm, "@ai-sdk/anthropic", "the per-model SDK is unaffected")
})

test("a model the config hook lists keeps its reasoning and its eyes", async () => {
  // What host.js 0.1.1788 makes of the config entry (its `info()`, the
  // `...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {})` merge):
  // replayed here, since this is the list magpie has before the vendor's
  // catalog can be reached at all.
  const p = await CodarPlugin()
  const config = {}
  await p.config(config)
  const merged = (id) => {
    const m = config.provider.codar.models[id]
    return {
      ...{ temperature: true, toolcall: true, input: { text: true }, output: { text: true } },
      ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
      ...(m.attachment !== undefined ? { attachment: m.attachment } : {}),
      ...(m.tool_call !== undefined ? { toolcall: m.tool_call } : {}),
      ...(m.modalities?.input ? { input: Object.fromEntries(["text", "image", "audio", "video", "pdf"].map((k) => [k, m.modalities.input.includes(k)])) } : {}),
    }
  }
  const opus = merged(ANTHROPIC_ID)
  assert.equal(opus.reasoning, true, "the config-path list kept reasoning")
  const flash = merged(LISTED_ID)
  assert.equal(flash.input.image, true, "and the vendor's own catalog says this one takes images")
})

test("the config hook keeps a provider name the user set", async () => {
  // magpie keeps a provider's name in providers.json and runs every config
  // hook on each start: writing ours over it would undo a rename made in its
  // UI, with no sign of why. Everything else the entry carries stays too —
  // including model entries the user added or overrode themselves.
  const p = await CodarPlugin()
  const config = { provider: { codar: { name: "我的科搭", options: { note: "kept" }, models: { "my-model": { name: "自建" } } } } }
  await p.config(config)
  assert.equal(config.provider.codar.name, "我的科搭")
  assert.deepEqual(config.provider.codar.options, { note: "kept" })
  // The key is the id: the host reads m.id when creating this row; a custom
  // entry without an id would be a model with no name. Only the key itself is
  // added, nothing else is touched.
  assert.deepEqual(config.provider.codar.models["my-model"], { name: "自建", id: "my-model" }, "the user's own model entry survives, given the id the host reads from its key")
  assert.ok(config.provider.codar.models[LISTED_ID], "the catalog is still filled in")
})

test("the four spellings of the claim state are read as the vendor client reads them", () => {
  // app.asar's um takes the first of the four names that is a real boolean. The
  // plugin took the first name that was merely present, so a body naming two
  // of them — the first null or a string, the second true — was read as
  // "not claimed": the card offered a claim the account could not take, or hid
  // the row's real state.
  assert.equal(signStateOf({ isSigned: null, signed: true }), true, "a null first name does not shadow a later true")
  assert.equal(signStateOf({ signed: "yes", hasSigned: true }), true, "nor does a string")
  assert.equal(signStateOf({ isSigned: false, signed: true }), false, "the first boolean decides, in the client's order")
  assert.equal(signStateOf({ isSigned: "true" }), false, "a name present but not a boolean is still named (drawn as not claimed)")
  assert.equal(signStateOf({}), null, "a body naming none says nothing")
  assert.equal(signStateOf({ isSigned: true, signed: false }), true, "isSigned comes before signed")
})

test("an extra segment beside a success:false claim does not take the day away", async () => {
  // Three dots make a base64url segment look like a JWT's part, and the
  // username rule refused one; the claim-extension segment the vendor may add
  // to a success:false "already claimed" body carries one ("live.v.d1.abc"),
  // and the flag then has to order the body's own codes. Read as the day's
  // statement on every code, the sentence lost to a wrapped code 400 and the
  // day's wait went with it; an inner code that refuses still wins.
  const key = mkToken({ username: "user_1.exp", exp: Math.floor(Date.now() / 1000) + 86400, e: "live.v.d1.abc" })
  assert.equal(usernameOf(key), "user_1.exp", "a token with an extra segment still names its account")
  const p = await CodarPlugin()
  const read = (body) =>
    withFetch(
      {
        "/v1/gettoken": { body: { code: 200, token: 1, agent_token: 0 } },
        "/v1/daily-sign": { body },
      },
      async () => p.auth.checkin(async () => ({ type: "api", key })),
    )
  const flat = await read({ code: 200, success: false, message: "24小时内仅可领取一次", data: { retry_after: 3600 } })
  assert.equal(flat.outcome, "done", "the day's words beside a flat flag are the day claimed")
  assert.ok(flat.until > Date.now() + 3000000, "with the wait it stated")
  const wrapped = await read({ code: 200, success: false, message: "24小时内仅可领取一次", data: { code: 400, retry_after: 3600 } })
  assert.equal(wrapped.outcome, "failed", "an inner code refuses whatever the outer words say")
})

test("a config whose provider is not an object does not take the provider down", async () => {
  // `config.provider ??= {}` leaves a string or a number in place, and writing
  // a property onto one throws: the whole hook fails and the codar provider
  // is not there at startup. An array keeps the write but loses it in
  // JSON.stringify, so it is replaced too.
  for (const bad of ["x", 5, [], true, "科搭"]) {
    const p = await CodarPlugin()
    const config = { provider: bad }
    await p.config(config)
    assert.equal(typeof config.provider, "object", `${JSON.stringify(bad)} becomes an object`)
    assert.ok(!Array.isArray(config.provider), "and not an array, whose named fields would not be written")
    assert.equal(config.provider.codar.name, "科搭 Codar")
    assert.ok(config.provider.codar.models[LISTED_ID])
  }
  const missing = {}
  await (await CodarPlugin()).config(missing)
  assert.equal(missing.provider.codar.api, "https://api.claw.speedai.com/v1", "a config with no provider at all still gets ours")
})

test("the auth hook asks magpie for the vendor's three concurrent requests", async () => {
  // Codar turns away the 4th concurrent request of one model with 429
  // concurrent_limit_exceeded (measured 2026-10-27: 2 and 3 in flight pass,
  // 4 and 5 get 429 for all but three). magpie queues past maxConcurrency
  // and lets the user raise it on the provider.
  const p = await CodarPlugin()
  assert.equal(p.auth.maxConcurrency, 3)
})

test("a concurrency the vendor's catalog states is used, without a reload", async () => {
  // The number is read when magpie builds the provider's info (host.js
  // concurrencyOf), and the models hook runs before that in the same pass.
  // So a catalog that starts saying max_concurrency reaches the queue on
  // the next listing: no plugin update, no restart.
  const p = await CodarPlugin()
  const given = { id: "codar", models: {} }
  await withFetch(
    {
      "/v1/codar/models": {
        body: { catalog: { data: [{ id: "x", display_name: "X", protocol: { type: "openai_chat_completions" }, max_concurrency: 5 }] } },
      },
    },
    async () => p.provider.models(given, { auth: await auth() }),
  )
  assert.equal(p.auth.maxConcurrency, 5, "the vendor's own number replaces the measured default")

  const q = await CodarPlugin()
  await withFetch(
    {
      "/v1/codar/models": {
        body: { catalog: { data: [{ id: "x", display_name: "X", protocol: { type: "openai_chat_completions" } }] } },
      },
    },
    async () => q.provider.models({ id: "codar", models: {} }, { auth: await auth() }),
  )
  assert.equal(q.auth.maxConcurrency, 3, "a catalog with no number keeps the measured one")
})

test("claude models go out on the anthropic SDK, the rest on openai-compatible", () => {
  assert.equal(modelOf({ id: "claude-opus-5", protocol: "anthropic_messages" }).api.npm, "@ai-sdk/anthropic")
  assert.equal(modelOf({ id: "deepseek-v4.1-flash", protocol: "openai_chat_completions" }).api.npm, "@ai-sdk/openai-compatible")
})

test("a model's abilities reach both of the host's paths, not just one", () => {
  // host.js builds a config model's capabilities from the top-level
  // m.reasoning / m.attachment / m.tool_call / m.modalities alone (the
  // `...(m.reasoning !== undefined ? …)` merge), and reads the models hook's
  // answer through m.capabilities (`kinds(m.capabilities?.input)`). Only one
  // set was written, so a config-path model had neither reasoning nor image.
  const m = modelOf({ id: "claude-opus-5", protocol: "anthropic_messages", reasoning: true, input: ["text", "image"], output: ["text"] })
  assert.equal(m.reasoning, true, "the config path reads this")
  assert.equal(m.tool_call, true)
  assert.equal(m.attachment, true, "it takes images, so it takes attachments")
  assert.deepEqual(m.modalities.input, ["text", "image"])
  assert.deepEqual(m.modalities.output, ["text"])
  assert.equal(m.capabilities.reasoning, true, "the models hook path reads this")
  assert.equal(m.capabilities.toolcall, true, "and that path's own names for tools and sampling")
  assert.equal(m.capabilities.temperature, true)
  assert.deepEqual(m.capabilities.input, { text: true, image: true, audio: false, video: false, pdf: false })
  assert.deepEqual(m.capabilities.output, { text: true, image: false, audio: false, video: false, pdf: false })

  const plain = modelOf({ id: "deepseek-v4.1-flash", input: ["text"], output: ["text"] })
  assert.equal(plain.reasoning, false)
  assert.equal(plain.attachment, false)
})

test("a fallback list keeps each model's own SDK, not the provider's", () => {
  // host.js builds a config model's SDK as m.provider?.npm ?? cfg.npm ??
  // was?.api.npm ?? … (line ~1696) — api.npm is not read on that path. With
  // only api.npm set, the fallback list gave every model the provider-level
  // openai-compatible, so Claude models lost the anthropic protocol whenever
  // the vendor's catalog could not be fetched.
  const cfg = { npm: "@ai-sdk/openai-compatible", models: { "claude-opus-5": modelOf({ id: "claude-opus-5", protocol: "anthropic_messages" }) } }
  const m = cfg.models["claude-opus-5"]
  const npm = m.provider?.npm ?? cfg.npm ?? m.api?.npm ?? "@ai-sdk/openai-compatible"
  assert.equal(npm, "@ai-sdk/anthropic", "the per-model SDK wins over the provider default")
})

test("catalogOf reads the vendor's shape and refuses one it does not know", () => {
  const list = catalogOf({ catalog: { data: [{ id: "x", context_window: 10, protocol: { type: "anthropic_messages" } }] } })
  assert.equal(list[0].id, "x")
  assert.equal(list[0].protocol, "anthropic_messages")
  assert.equal(catalogOf({ data: "nope" }), null)
  assert.equal(catalogOf({}), null)
})

test("humanSecs says seconds, minutes, hours and days", () => {
  assert.equal(humanSecs(30), "30 秒")
  assert.equal(humanSecs(600), "10 分钟")
  assert.equal(humanSecs(3600), "1 小时")
  assert.equal(humanSecs(3600 + 1800), "1 小时 30 分钟")
  assert.equal(humanSecs(86400 * 2 + 3600), "2 天 1 小时")
})

test("a number of seconds no calendar can say is said as nothing", () => {
  // 1e308 is finite, so every "> 0" check passed it, while ×1000 overflows to
// Infinity — the vendor's words is not a thing a card says.
  assert.equal(humanSecs(Infinity), "", "an infinity is not \"Infinity 天\"")
  assert.equal(humanSecs(1e308), "", "nor is 1e308 \"1.15e+303 天\"")
  assert.match(humanSecs(1e11), /天/, "a long wait a calendar can still say is said")
})

test("a wait a vendor states as a fraction of a second is not said as no wait", () => {
  // Math.round(0.4) is 0, so retry_after 0.4 — a window the vendor opens
// almost now — came out as the vendor's words beside an until 400 ms away: a
  // wait stated as no wait at all. A stated zero is still a zero.
  assert.equal(humanSecs(0.4), "1 秒", "a positive wait rounds up, never to zero")
  assert.equal(humanSecs(0.04), "1 秒")
  assert.equal(humanSecs(0), "0 秒", "a stated zero is said as zero")
})

test("a sub-second wait the vendor states reads as a wait on both cards", async () => {
  const p = await CodarPlugin()
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true, retry_after: 0.4 } } },
      "/api/codar/activities/mine": { body: { code: 200, data: [] } },
    },
    async () => p.auth.usage(auth),
  )
  const win = u.windows.find((w) => w.name === "每日签到")
  assert.doesNotMatch(win.display, /0 秒/, "the row does not say the window opens in no time")
  assert.match(win.display, /1 秒后可再领/)
  assert.ok(win.resetsAt > Date.now(), "and the resetsAt is a time in the future")

  const r = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign": { body: { code: 400, message: "24小时内仅可领取一次", data: { retry_after: 0.4 } } },
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(r.outcome, "done")
  assert.doesNotMatch(r.message, /0 秒/, "nor does the check-in's own words")
  assert.match(r.message, /1 秒后可再领/)
  assert.ok(r.until > Date.now(), "and its until is a time in the future")
})

test("a time past the calendar is not a time, never a rounded one", () => {
  // Two ceilings meet here: Date.toISOString() throws past 8.64e15, and
  // magpie's Go side parses the ISO string with a four-digit-year layout, so
  // a "+275760-…" parses to zero and the time is dropped in silence. A time
  // past the last instant both accept is said as nothing — not clamped to
  // 9999-12-31, which is a date the vendor never stated. (The clamping
  // version was dead code: every caller bounds the wait first, so no test
  // could tell the two apart until this one asked safeTime directly.)
  assert.equal(safeTime(253402300799999), 253402300799999, "the last instant both accept is kept as it is")
  assert.equal(safeTime(253402300800000), 0, "one past it is not a time")
  assert.equal(safeTime(8.64e15), 0, "nor is a time toISOString would throw on")
  assert.equal(safeTime(1e17), 0)
  assert.equal(safeTime(0), 0, "a time that is not one is said as nothing")
  assert.equal(safeTime(-1), 0)
  assert.equal(safeTime(Infinity), 0)
  assert.equal(safeTime(NaN), 0)
  // A boolean or an array is not a time either. Number() reads them as 1 and
  // 3600, which put a moment in 1970 on the card that the vendor never said.
  assert.equal(safeTime(true), 0, "a boolean is not a time")
  assert.equal(safeTime(false), 0)
  assert.equal(safeTime([3600]), 0, "an array is not a time, whatever it holds")
  assert.equal(safeTime(["3600"]), 0)
  assert.equal(safeTime({}), 0, "nor is an object")
  // and the two shapes that do say one still say it
  assert.equal(safeTime("3600"), 3600, "a string that says a number still does")
  assert.equal(safeTime(3600), 3600)
})

test("every request carries the User-Agent the desktop app sends on that host", async () => {
  const p = await CodarPlugin()
  await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 1, agent_token: 0 } },
      "/v1/daily-sign": { body: { code: 400, message: "24小时内仅可领取一次", data: { retry_after: 10 } } },
      "/v1/codar/models": { body: { catalog: { data: [{ id: "x" }] } } },
    },
    async (calls) => {
      await p.auth.checkin(auth)
      await p.provider.models({}, { auth: await auth() })
      const sign = calls.find((c) => c.url.includes("/v1/daily-sign"))
      const cat = calls.find((c) => c.url.includes("/v1/codar/models"))
      assert.equal(sign.init.headers["User-Agent"], "node", "the desktop's own fetch sends `node`")
      assert.equal(cat.init.headers["User-Agent"], "node", "the catalog is read by that same main-process fetch (the sidecar's Go UA is chat only)")
    },
  )
  const out = { headers: {} }
  await p["chat.headers"]({ model: { providerID: "codar" }, provider: { info: { id: "codar" } } }, out)
  assert.equal(out.headers["User-Agent"], "Go-http-client/1.1", "chat goes out through the app's Go sidecar")

  // host.js tells the hook the provider both ways (input.model.providerID and
  // input.provider.info.id); a hook that read only one of them would leave
  // our own requests without the sidecar's UA on the hosts that pass the other
  const viaModel = { headers: {} }
  await p["chat.headers"]({ model: { providerID: "codar" } }, viaModel)
  assert.equal(viaModel.headers["User-Agent"], "Go-http-client/1.1", "our own request is recognised by the model too")

  // host.js always hands in an object with headers, but this hook runs inside
  // every provider's request path: one that is missing the bag is made, not
  // reached into. A shape the host does not send must not throw there.
  const bare = {}
  await p["chat.headers"]({ model: { providerID: "codar" } }, bare)
  assert.equal(bare.headers["User-Agent"], "Go-http-client/1.1", "a bag that is not there is made, not assumed")
})

test("chat.headers leaves another provider's request alone", async () => {
  // Every plugin's chat.headers hook is run for every provider's request
  // (host.js filters only on "is it a function"; the qoder plugin says so
  // too). Setting a User-Agent without checking would rewrite the traffic
  // of every other provider through magpie.
  const p = await CodarPlugin()
  for (const input of [
    { model: { providerID: "qoder-cn" }, provider: { info: { id: "qoder-cn" } } },
    { model: { providerID: "zcode" } },
    { provider: { info: { id: "trae-cn" } } },
    {},
    undefined,
  ]) {
    const out = { headers: {} }
    await p["chat.headers"](input, out)
    assert.deepEqual(out.headers, {}, `left ${JSON.stringify(input)} alone`)
  }
})

test("a request that never answers is aborted and says so in words", async () => {
  // The vendor has hung for 30s before (2026-10-27, every /v1/* 500 after a
  // long wait). The budget is what keeps a card from waiting that long, so
  // the timer's abort is what this exercises: a fetch that answers only when
  // the signal aborts, with a timeout small enough to run in a test.
  const hang = (_url, init) =>
    new Promise((_ok, fail) => {
      init.signal.addEventListener("abort", () => fail(Object.assign(new Error("aborted"), { name: "AbortError" })))
    })
  await assert.rejects(
    () => request("https://api.kuaipaper.com/v1/gettoken", { method: "POST", token: TOKEN, fetchImpl: hang, timeoutMs: 25 }),
    /请求超时/,
    "the timeout is said in words, not left as an AbortError",
  )
})

test("the plugin's timeouts land before magpie's own deadlines", () => {
  // magpie's Go side gives a usage read 20s and a check-in 2 minutes. When
  // the host cuts first the card shows the host's timeout, not the plugin's
// own the vendor's words — so the worst case of each hook must fit inside its own.
  //
  // The two deadlines are written as the literals magpie states, not read
  // from the plugin's own copies of them: compared against the copies, a
  // constant changed to 999s stays green, and the test would be asserting
  // that the plugin agrees with itself.
  const t = testables.timing
  const HOST_USAGE = 20 * 1000
  const HOST_CHECKIN = 120 * 1000
  // usage: four reads at once, so the hook's worst case is one timeout — and
  // the host runs fresh() and a cold infoOf() (a models read, one timeout of
  // its own) before the hook starts. Both have to fit the host's 20s.
  assert.ok(t.TIMEOUT_MS <= t.USAGE_BUDGET_MS, "one usage read gets its full timeout")
  assert.ok(t.USAGE_BUDGET_MS <= HOST_USAGE, "and the whole usage read lands before the host's deadline")
  assert.ok(2 * t.TIMEOUT_MS <= HOST_USAGE, "the host's models read and the usage hook's worst case both fit the 20s")
  // check-in: three reads in a row (points, the claim, points). If three full
  // timeouts did not fit the budget, a slow first read could leave the claim
  // itself only the 1s floor — a claim that would have answered in 3s,
  // reported as a timeout. The budget caps the rest; it lands before the
  // host's 2 minutes.
  assert.ok(3 * t.TIMEOUT_MS <= t.CHECKIN_BUDGET_MS, "a slow first read cannot starve the claim to the 1s floor")
  assert.ok(t.CHECKIN_BUDGET_MS <= HOST_CHECKIN, "and the whole check-in lands before the host's deadline")
  // the constants the plugin records about the host are those deadlines, not
  // whatever a later edit made them
  assert.equal(t.HOST_USAGE_DEADLINE_MS, HOST_USAGE, "the recorded usage deadline is magpie's 20s")
  assert.equal(t.HOST_CHECKIN_DEADLINE_MS, HOST_CHECKIN, "and the recorded check-in deadline its 2 minutes")
})

test("the timeouts each request is given are the ones the budget says", async () => {
  // Every request's timeout is min(TIMEOUT_MS, what is left of the budget),
  // and never under 1s. Measured from the timers request() really sets:
  // a vendor that hangs until aborted, and a clock the test moves forward.
  const realNow = Date.now
  const realSet = globalThis.setTimeout
  let now = realNow()
  const given = []
  Date.now = () => now
  globalThis.setTimeout = (fn, ms, ...a) => {
    given.push(ms)
    return realSet(fn, 0, ...a)
  }
  const p = await CodarPlugin()
  const realFetchForTimers = globalThis.fetch
  const hang = async (_u, init) => {
    // each request eats 10s of the clock before it is aborted
    now += 10 * 1000
    await new Promise((_ok, no) => init.signal.addEventListener("abort", () => no(Object.assign(new Error("a"), { name: "AbortError" }))))
  }
  try {
    const real = globalThis.fetch
    globalThis.fetch = hang
    try {
      given.length = 0
      const r = await p.auth.checkin(auth)
      assert.equal(r.outcome, "failed")
      const t = testables.timing
      // first two requests get the whole per-request cap; the third would
      // start with 25 - 20 = 5s left of the budget, but the sign already
      // failed — the check-in makes only the points read and the sign here
      assert.deepEqual(given.slice(0, 2), [t.TIMEOUT_MS, t.TIMEOUT_MS], "a fresh budget gives each request its full cap")
    } finally {
      globalThis.fetch = real
    }

    // a budget mostly spent: the floor is 1s, never 0 or negative
    given.length = 0
    now = realNow()
    let calls = 0
    globalThis.fetch = async (u, init) => {
      calls++
      // the first read eats almost the whole budget, then answers
      if (calls === 1) {
        now += testables.timing.CHECKIN_BUDGET_MS + 5000
        return new Response(JSON.stringify({ code: 200, token: 1, agent_token: 0 }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 400, message: "24小时内仅可领取一次", data: { retry_after: 60 } }), { status: 200 })
    }
    try {
      await p.auth.checkin(auth)
      assert.equal(given[1], 1000, "a spent budget leaves the next request the 1s floor, not 0 or a negative wait")
    } finally {
      globalThis.fetch = realFetchForTimers
    }

    // a budget partly spent: the middle of the expression. Every other reading
    // here lands on the cap (a fresh budget) or on the floor (a spent one), so
    // `min(TIMEOUT_MS, left())` could have been `TIMEOUT_MS` alone and stayed
    // green. 20s of the 25s gone leaves the second request 5s.
    given.length = 0
    now = realNow()
    calls = 0
    globalThis.fetch = async () => {
      calls++
      if (calls === 1) {
        now += 20 * 1000
        return new Response(JSON.stringify({ code: 200, token: 1, agent_token: 0 }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 200, message: "Success" }), { status: 200 })
    }
    try {
      const r = await p.auth.checkin(auth)
      assert.equal(r.outcome, "claimed")
      const t = testables.timing
      assert.equal(given[1], t.CHECKIN_BUDGET_MS - 20 * 1000, "a part-spent budget hands the next request what is left of it, not the full cap")
      // …and the same for the balance read after the claim: it is the third
      // request on this path, and it had its own min() that no reading here
      // reached (the claim and the first read both answered instantly).
      assert.equal(given[2], t.CHECKIN_BUDGET_MS - 20 * 1000, "the read after the claim is handed the same remainder, not the full cap")
    } finally {
      globalThis.fetch = realFetchForTimers
    }
  } finally {
    Date.now = realNow
    globalThis.setTimeout = realSet
  }
})

test("each of the usage hook's four reads is given the per-request cap", async () => {
  // The usage hook had no such reading: only the check-in path was measured,
  // so a mutant that handed the usage reads a different timeout (or dropped
  // the budget out of the expression) stayed green. Measured off the timers
  // request() really sets, as the check-in test above does.
  const realNow = Date.now
  const realSet = globalThis.setTimeout
  const realFetch = globalThis.fetch
  let now = realNow()
  const given = []
  Date.now = () => now
  globalThis.setTimeout = (fn, ms, ...a) => {
    given.push(ms)
    return realSet(fn, 0, ...a)
  }
  // a vendor that hangs until aborted. The clock stands still, so the four
  // reads (issued together) are all handed the same `left()` — which is what
  // the real path does, since nothing between two of them can move it. That
  // also means the 1s floor on this path is unreachable, so there is nothing
  // here to pin about it; the check-in test above is where the floor bites.
  globalThis.fetch = async (_u, init) =>
    new Promise((_ok, no) => init.signal.addEventListener("abort", () => no(Object.assign(new Error("a"), { name: "AbortError" }))))
  try {
    const p = await CodarPlugin()
    const u = await p.auth.usage(auth)
    assert.match(u.error, /超时/, "a read that never answers is reported as the plugin's own timeout")
    const t = testables.timing
    // three reads, then the balance fallback the first of them asked for:
    // each gets min(TIMEOUT_MS, what is left). The clock stands still here, so
    // that is the cap on all four.
    assert.deepEqual(given, [t.TIMEOUT_MS, t.TIMEOUT_MS, t.TIMEOUT_MS, t.TIMEOUT_MS], "every read is given the full per-request cap")
  } finally {
    Date.now = realNow
    globalThis.setTimeout = realSet
    globalThis.fetch = realFetch
  }
})

test("a request that has already answered is not aborted later", async () => {
  // request() arms an abort timer and clears it in `finally`. Deleting that
  // clearTimeout left every test green: the answer arrived either way. What
  // it costs is a stray timer per request that aborts a signal nobody is
  // reading any more — and, on a hook that runs on every card refresh, a
  // pile of them.
  const realFetch = globalThis.fetch
  let signal
  globalThis.fetch = async (_u, init) => {
    signal = init.signal
    return new Response(JSON.stringify({ code: 200 }), { status: 200, headers: { "Content-Type": "application/json" } })
  }
  try {
    const body = await request("https://api.claw.speedai.com/v1/x", { token: "t", timeoutMs: 40 })
    assert.deepEqual(body, { code: 200 })
    assert.equal(signal.aborted, false, "an answered request is not aborted while it is answering")
    await new Promise((ok) => setTimeout(ok, 150))
    assert.equal(signal.aborted, false, "nor once the timeout it did not need has passed")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("the token sign-in reads this machine's Codar login, and takes a pasted one", async () => {
  const p = await CodarPlugin()
  const tokenMethod = p.auth.methods.find((m) => m.label === "科搭令牌（留空读本机）")
  // One entry, two sources. It is not keyless: magpie calls a keyless method
  // with no prompts at all, and the optional pasted-token field is exactly
  // what the merged entry has to show.
  assert.equal(tokenMethod.keyless, undefined, "the optional field is shown, so the method is not keyless")
  assert.equal(typeof tokenMethod.authorize, "function")
  assert.deepEqual(tokenMethod.prompts.map((q) => q.key), ["token"], "one optional token field")
  assert.equal(tokenMethod.prompts[0].validate(""), null, "an empty field is a choice (read this machine), not an error")
  assert.deepEqual(
    p.auth.methods.map((m) => m.label),
    ["科搭令牌（留空读本机）", "科搭OAuth登录", "科搭账号密码登录"],
    "the token entry first, then the one page with the vendor's two ways in, and the password one after the page its IP check hands on to",
  )
  assert.deepEqual(
    p.auth.methods.find((m) => m.label === "科搭账号密码登录").prompts.map((q) => q.key),
    ["username", "password"],
    "the password sign-in asks for the account and the password, in that order",
  )

  // A pasted token gets the checks the app's own file gets: visible ASCII, an
  // account name, and not past its exp. One that failed here would be saved
  // and then fail on the card.
  const pastedToken = mkToken({ username: "user_9", exp: Math.floor(Date.now() / 1000) + 86400 })
  const pasted = await tokenMethod.authorize({ token: pastedToken })
  assert.equal(pasted.type, "success", "a pasted token signs in")
  assert.equal(pasted.access, pastedToken, "handed over as typed")
  assert.equal(pasted.expires, expiresAt(pastedToken), "with the exp the token states, so magpie renews ahead of it")
  assert.equal((await tokenMethod.authorize({ token: `${pastedToken.slice(0, 12)} ${pastedToken.slice(12)}` })).type, "failed", "a token with a space in it is refused")
  assert.match((await tokenMethod.authorize({ token: `${pastedToken.slice(0, 12)} ${pastedToken.slice(12)}` })).error, /无法识别/)
  assert.match((await tokenMethod.authorize({ token: mkToken({ exp: Math.floor(Date.now() / 1000) + 60 }) })).error, /没有账号名/, "a token that names no account is refused")
  assert.match((await tokenMethod.authorize({ token: mkToken({ username: "user_9", exp: 1 }) })).error, /已过期/, "a lapsed token is refused, not saved")

  // a file the app would leave: nested provider → speedai → token
  const dir = mkdtempSync(join(tmpdir(), "codar-plugin-"))
  const file = join(dir, "config.json")
  const token = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
  writeFileSync(file, JSON.stringify({ provider: { speedai: { token, username: "user_1" } } }))
  try {
    assert.equal(appToken(file).token, token, "the token is handed over as it is")
    // a config written on Windows may start with a BOM; JSON.parse refuses
    // the whole file over it, which read as "the config is broken"
    writeFileSync(file, "﻿" + JSON.stringify({ provider: { speedai: { token } } }))
    assert.equal(appToken(file).token, token, "a config with a BOM is read, not called corrupt")
    writeFileSync(file, JSON.stringify({ provider: { speedai: { token } } }))
    assert.match(appToken(join(dir, "nope.json")).error, /没找到/)
    // a file that is there but cannot be read is not "not found": telling the
    // user to sign in once on this machine would not fix a permission
    const dirError = appToken(dir)
    assert.match(dirError.error, /读不了/, "an unreadable path says so")
    assert.doesNotMatch(dirError.error, /先在这台机器上登录/, "and does not send them to sign in again")

    writeFileSync(file, "{ not json")
    assert.match(appToken(file).error, /读不出 JSON/)

    writeFileSync(file, JSON.stringify({ provider: { speedai: {} } }))
    assert.match(appToken(file).error, /没有 provider\.speedai\.token/)

    writeFileSync(file, JSON.stringify({ provider: { speedai: { token: "eyJ\u200Babc" } } }))
    assert.match(appToken(file).error, /无法识别/, "an invisible character is refused here, not by fetch")

    const old = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) - 60 })
    writeFileSync(file, JSON.stringify({ provider: { speedai: { token: old } } }))
    assert.match(appToken(file).error, /已过期/, "a lapsed token is caught before magpie saves it")

    // the method as magpie calls it: authorize() answers in the host's own
    // shape, reading the one file the app writes (CODAR_HOME points it at
    // this temp dir, as it points the app). It takes no path from the
    // caller: magpie's sign-in API must not become a JSON-file reader.
    const had = process.env.CODAR_HOME
    process.env.CODAR_HOME = dir
    try {
      rmSync(file, { force: true })
      const none = await tokenMethod.authorize({})
      assert.equal(none.type, "failed", "no file is a refusal with words")
      assert.match(none.error, /没找到/)

      const old = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) - 60 })
      writeFileSync(file, JSON.stringify({ provider: { speedai: { token: old } } }))
      const lapsed = await tokenMethod.authorize({})
      assert.equal(lapsed.type, "failed", "the lapsed token is refused, not handed to magpie")
      assert.match(lapsed.error, /已过期/)

      writeFileSync(file, JSON.stringify({ provider: { speedai: { token } } }))
      // handed over in the shape the host renews (access/refresh/expires):
      // a bare key would be kept as an api sign-in that nothing renews
      const fresh = await tokenMethod.authorize({})
      assert.equal(fresh.type, "success")
      assert.equal(fresh.access, token, "the app's own token, handed over")
      assert.equal(fresh.refresh, token)
      assert.equal(fresh.expires, expiresAt(token))
      const other = await tokenMethod.authorize({ file: join(dir, "other.json") })
      assert.equal(other.access, token, "an argument names no other file: the path is the app's own")
    } finally {
      if (had === undefined) delete process.env.CODAR_HOME
      else process.env.CODAR_HOME = had
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the token never leaves in a message", async () => {
  const p = await CodarPlugin()
  const r = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 1, agent_token: 0 } },
      "/v1/daily-sign": new Response(`{"detail":"bad token ${TOKEN}"}`, { status: 400, headers: { "Content-Type": "application/json" } }),
    },
    async () => p.auth.checkin(auth),
  )
  // the head is not enough: a server that quotes only the payload or the
  // signature back would pass a head-only assertion
  for (const part of TOKEN.split(".")) assert.ok(!r.message.includes(part.slice(0, 12)) || part.length < 12, `no segment of the token survives: ${r.message}`)
  assert.doesNotMatch(r.message, new RegExp(TOKEN.slice(0, 20)))
})

test("the points are a wallet window, so routing has a figure for this account", async () => {
  // magpie's routing page says "what's left not known yet" for an account
  // whose windows are all aside or text (routedAllowance skips them). The
  // points are a prepaid wallet: Balance leaves it known, with the figure
  // left, and no share invented (magpie #3950).
  const until = Math.floor(Date.now() / 1000) + 3600
  const p = await CodarPlugin()
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 2348, agent_token: 4000 } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true, retry_after: 60 } } },
      "/api/codar/activities/mine": {
        body: { code: 200, data: [{ status: "active", free_until: until, remaining_quota: null, user_quota_limit: null, model_ids: ["auto", "deepseek-v4.1-flash"] }] },
      },
    },
    async () => p.auth.usage(auth),
  )
  const wallet = u.windows.find((w) => w.name === "点数余额")
  assert.ok(wallet, "the wallet window is there")
  assert.equal(wallet.balance, 2348, "the figure left, as a wallet reading")
  assert.equal(wallet.used, undefined, "no share invented for a wallet")
  assert.equal(wallet.aside, undefined, "not set aside: it still counts")
})

test("an activity whose model ids spell the token is not drawn", async () => {
  // The card shows the first two ids, but the activity's own list is where
  // the token's pieces are: one id per piece, in order, and a reader who
  // looks at the card has them. A split of the token — or of a base32 copy
  // of it — across the ids costs the activity, not the card.
  const until = Math.floor(Date.now() / 1000) + 3600
  const A = "abcdefghijklmnopqrstuvwxyz234567"
  const b32 = (buf) => {
    let bits = 0
    let acc = 0
    let out = ""
    for (const c of buf) {
      acc = (acc << 8) | c
      bits += 8
      while (bits >= 5) {
        bits -= 5
        out += A[(acc >> bits) & 31]
      }
    }
    return bits ? out + A[(acc << (5 - bits)) & 31] : out
  }
  const pct = [...Buffer.from(TOKEN, "latin1")].map((n) => `%${n.toString(16).padStart(2, "0")}`).join("")
  const splits = [
    ["plain", TOKEN.match(/.{1,10}/g)],
    ["percent", pct.match(/.{1,10}/g)],
    ["base32", b32(Buffer.from(TOKEN, "latin1")).match(/.{1,10}/g)],
    ["base32 (padded)", b32(Buffer.from(TOKEN, "latin1")).match(/.{1,10}/g).map((piece, i) => `${piece} ${"ordinary model description ".repeat(4)}${i}`)],
  ]
  for (const [label, ids] of splits) {
    const p = await CodarPlugin()
    const u = await withFetch(
      {
        "/v1/gettoken": { body: { code: 200, token: 1, agent_token: 4 } },
        "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true, retry_after: 60 } } },
        "/api/codar/activities/mine": {
          body: {
            code: 200,
            data: [
              { status: "active", free_until: until, remaining_quota: null, model_ids: ids },
              { status: "active", free_until: until, remaining_quota: null, model_ids: ["auto"] },
            ],
          },
        },
      },
      async () => p.auth.usage(auth),
    )
    const free = u.windows.filter((w) => w.name.startsWith("免费模型"))
    assert.ok(!JSON.stringify(u).includes(ids[1]), `${label}: no piece of the token is drawn`)
    if (label === "plain") {
      // each piece is a window of the token, so the two the name shows are cut
      // to "…"; the activity itself stays, and the rest is only counted.
      assert.equal(free.length, 2, `${label}: the activity stays, its ids cut`)
      assert.match(free[0].name, /…/, `${label}: the shown ids are cut`)
    } else {
      // an encoded piece is nothing the per-id cut can see; the activity is
      // the pieces in order and is not drawn at all.
      assert.equal(free.length, 1, `${label}: only the ordinary activity is drawn`)
      assert.equal(free[0].name, "免费模型 · auto", `${label}: the split costs the activity`)
    }
  }
})

test("vendor strings are cleaned, and an id that needs cleaning is left out", () => {
  const list = catalogOf({
    data: [
      { id: "ok", display_name: "Fine\u0007Name", protocol: { type: "openai_chat_completions" } },
      { id: "bad\u0001id", display_name: "Bad", protocol: { type: "openai_chat_completions" } },
      { id: "  ", display_name: "Blank" },
    ],
  })
  assert.deepEqual(list.map((m) => m.id), ["ok"], "the two unusable ids are left out")
  assert.equal(list[0].name, "Fine Name", "the control character in the name is a space")
})

test("a reply that starts with a byte-order mark still reads", async () => {
  // Node's fetch and Bun's both drop a leading BOM from text(), but the
  // fetch the host hands in need not: this stub answers text() with the BOM
  // still in it, which is what the plugin's own strip is for.
  const p = await CodarPlugin()
  const bodied = (body) => ({ ok: true, status: 200, text: async () => body })
  const real = globalThis.fetch
  globalThis.fetch = async (url) =>
    String(url).includes("/v1/gettoken")
      ? bodied(JSON.stringify({ code: 200, token: 1, agent_token: 0 }))
      : bodied('\uFEFF{"code":200,"message":"Success"}')
  try {
    const r = await p.auth.checkin(auth)
    assert.equal(r.outcome, "claimed", "a BOM is not a broken reply")
  } finally {
    globalThis.fetch = real
  }
})

test("a token quoted back in an error is cut by its shape, even with no token in hand", async () => {
  // The getAuth-throw path has no token to split on. A vendor (or the fetch
  // underneath) that quotes the credential back must still not put it on the
  // card: the shape of a JWT is what is cut.
  const jwt = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 3600 })
  const boom = Object.assign(new Error(`bad key ${jwt}`), {})
  const p = await CodarPlugin()
  const r = await p.auth.checkin(async () => {
    throw boom
  })
  assert.doesNotMatch(r.message, new RegExp(jwt.slice(10, 30)))
  assert.match(r.message, /…/)

  const u = await p.auth.usage(async () => {
    throw boom
  })
  assert.doesNotMatch(u.error, new RegExp(jwt.slice(10, 30)))
})

test("a message is one line", async () => {
  const p = await CodarPlugin()
  const r = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 1, agent_token: 0 } },
      "/v1/daily-sign": { body: { code: 500, message: "line one\nline two\u0007" } },
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(r.message, "line one line two", "control characters never reach the card")
})

test("the read-from-this-machine sign-in follows CODAR_HOME, as the app does", () => {
  // `codar config path` answers <CODAR_HOME>/config.json when CODAR_HOME is
  // set (verified against the installed app's sidecar), so the plugin reads
  // the same file the app would have written.
  const dir = mkdtempSync(join(tmpdir(), "codar-home-"))
  const token = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
  writeFileSync(join(dir, "config.json"), JSON.stringify({ provider: { speedai: { token } } }))
  const had = process.env.CODAR_HOME
  process.env.CODAR_HOME = dir
  try {
    assert.deepEqual(appToken(), { token }, "the default path follows CODAR_HOME")
  } finally {
    if (had === undefined) delete process.env.CODAR_HOME
    else process.env.CODAR_HOME = had
    rmSync(dir, { recursive: true, force: true })
  }
})

test("without CODAR_HOME the file is the app's under the home directory", () => {
  // the path alone, not a read: this machine's own ~/.codar must not decide
  // what a test sees
  const had = process.env.CODAR_HOME
  delete process.env.CODAR_HOME
  try {
    assert.equal(configPath(), join(homedir(), ".codar", "config.json"))
  } finally {
    if (had !== undefined) process.env.CODAR_HOME = had
  }
})

test("a token with no account name is refused at sign-in, not saved", () => {
  // Every call the plugin makes sends the account name from the token's own
  // claims. A token without one used to be saved and then fail on the card.
  const dir = mkdtempSync(join(tmpdir(), "codar-plugin-"))
  const file = join(dir, "config.json")
  const nameless = mkToken({ exp: Math.floor(Date.now() / 1000) + 86400 })
  writeFileSync(file, JSON.stringify({ provider: { speedai: { token: nameless } } }))
  try {
    assert.match(appToken(file).error, /没有账号名/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the module exports one function, the plugin: magpie runs every exported function", async () => {
  // host.js servers() takes every function the module exports as a plugin
  // entry and calls it with the plugin input. A helper exported for a test
  // would run as a second plugin in every magpie, and a throw from it marks
  // the whole package as failed to load. Pure helpers live on `testables`.
  const seen = new Set()
  const entries = []
  for (const v of Object.values(mod)) {
    if (seen.has(v)) continue
    seen.add(v)
    if (typeof v === "function") entries.push(v)
  }
  assert.equal(entries.length, 1, `one entry, not ${entries.length}`)
  assert.equal(entries[0], CodarPlugin)
  // No default export either: OpenCode 2.x reads a package's default as its
  // {id, setup(ctx)} object and has no fallback for a 1.x plugin's named
  // functions, so a default here would be misread there.
  assert.ok(!("default" in mod), "index.mjs has no default export")
})

test("a sign-in with no token says to sign in, and a token with no name says which", async () => {
  const p = await CodarPlugin()
  const none = await p.auth.checkin(async () => ({ type: "api", key: "" }))
  assert.equal(none.outcome, "failed")
  assert.match(none.message, /没有登录信息/)

  const spaces = await p.auth.checkin(async () => ({ type: "api", key: "  \n " }))
  assert.match(spaces.message, /没有登录信息/, "whitespace only is an empty key, not an unusable one")

  const zero = await p.auth.checkin(async () => ({ type: "api", key: "eyJ\u200Babc" }))
  assert.match(zero.message, /无法识别/, "a key with an invisible character in it cannot be sent")

  const nameless = mkToken({ exp: Math.floor(Date.now() / 1000) + 60 })
  const r = await p.auth.checkin(async () => ({ type: "api", key: nameless }))
  assert.match(r.message, /没有账号名/)
})

test("a getAuth that throws fails the hook; the usage read marks a 401 as expired", async () => {
  // checkin's own answer carries no signIn: host.js's checkinOf keeps only
  // outcome, credit, streak, message and until, so a signIn here would be
  // written and never read. What marks an account is usage's.
  const p = await CodarPlugin()
  const plain = await p.auth.checkin(async () => {
    throw new Error("no account")
  })
  assert.equal(plain.outcome, "failed")
  assert.equal(plain.message, "no account")

  const denied = Object.assign(new Error("denied"), { status: 401 })
  const r = await p.auth.checkin(async () => {
    throw denied
  })
  assert.equal(r.outcome, "failed")
  assert.equal(r.signIn, undefined, "the check-in's own answer has no signIn to be read")

  const u = await p.auth.usage(async () => {
    throw denied
  })
  assert.equal(u.signIn, "expired")
  assert.ok(u.error)
})

test("usage with no token is an error, not a zero", async () => {
  const p = await CodarPlugin()
  const u = await p.auth.usage(async () => ({ type: "api", key: "" }))
  assert.match(u.error, /没有登录信息/)
  const nameless = mkToken({ exp: Math.floor(Date.now() / 1000) + 60 })
  const u2 = await p.auth.usage(async () => ({ type: "api", key: nameless }))
  assert.match(u2.error, /没有账号名/)
  // a key that is there but cannot go in a header says so, as check-in does:
  // "sign in again" would send the user to the wrong place
  const broken = await p.auth.usage(async () => ({ type: "api", key: "eyJ\u200Babc" }))
  assert.match(broken.error, /无法识别/)
})

test("an answer that is not JSON is a failure with its reason, not a crash", async () => {
  const p = await CodarPlugin()
  const r = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 1, agent_token: 0 } },
      "/v1/daily-sign": new Response("<html>bad gateway</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(r.outcome, "failed")
  assert.match(r.message, /不是 JSON/)
})

test("a JWT whose payload is not JSON reads as no claims", () => {
  const broken = `a.${Buffer.from("not json").toString("base64url")}.c`
  assert.equal(payloadOf(broken), null)
})

test("a credential with not exactly three parts is not read as a JWT", () => {
  // The vendor's client takes the middle of a three-part token; the plugin
  // reads the middle too, but only of something shaped like a JWT. A
  // two-part string whose middle happens to decode as claims was read as the
  // account's claims, and every request then named an account the token
  // never carried.
  const claims = Buffer.from(JSON.stringify({ username: "bob", exp: 1_900_000_000 })).toString("base64url")
  assert.equal(payloadOf(`header.${claims}`), null, "two parts is not a token")
  assert.equal(payloadOf(`${claims}`), null, "nor is one")
  assert.equal(payloadOf(`header.${claims}.sig.extra`), null, "nor is four")
  assert.equal(usernameOf(`header.${claims}`), "", "and no account name comes out of it")
  assert.equal(payloadOf(`header.${claims}.sig`).username, "bob", "three is")
})

test("a token runs out at the second it names, as the vendor's client reads it", () => {
  // app.asar's Zh: `i*1e3 - t <= 0 ? "expired"`. Read as `>` the exact
  // instant would be one more second of life the client does not give.
  const real = Date.now
  const at = 1_800_000_000
  try {
    Date.now = () => at * 1000
    assert.equal(expired(mkToken({ username: "u", exp: at })), true, "the second it names is already gone")
    Date.now = () => at * 1000 - 1
    assert.equal(expired(mkToken({ username: "u", exp: at })), false, "the millisecond before it is not")
  } finally {
    Date.now = real
  }
})

test("a claim whose point reads fail still claims, with no made-up credit", async () => {
  // The claim is what the vendor said; the points are a bonus we can only
  // report when both reads worked. A failed read must not turn a claim into
  // a failure, and must not report 0 as if it were the amount.
  let n = 0
  const p = await CodarPlugin()
  const r = await withFetch(
    {
      "/v1/gettoken": () => {
        n += 1
        return new Response(JSON.stringify({ detail: "boom" }), { status: 500 })
      },
      "/v1/daily-sign": { body: { code: 200, message: "Success" } },
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(n, 2, "both point reads were tried")
  assert.equal(r.outcome, "claimed")
  assert.equal(r.credit, undefined, "an unreadable read states no credit, not 0")
})

test("a reward that lands on the agent points is reported, and a fall is not a reward", async () => {
// The vendor only says a claim gives the vendor's words — it does not say which
  // balance holds it, and the agent balance has moved (3978 → 4000 across a
  // day) while the general one stayed put. Read from the general balance
  // alone, that reward was a 0.
  let n = 0
  const p = await CodarPlugin()
  const r = await withFetch(
    {
      "/v1/gettoken": () => {
        n += 1
        return new Response(JSON.stringify(n === 1 ? { code: 200, token: 500, agent_token: 3978 } : { code: 200, token: 500, agent_token: 4000 }), { status: 200 })
      },
      "/v1/daily-sign": { body: { code: 200, message: "Success" } },
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(r.credit, 22, "the agent balance's gain is this claim's reward")

  // a balance that fell between the reads is the app spending, not this
  // claim: the reward on the other balance still stands
  let m = 0
  const q = await CodarPlugin()
  const s = await withFetch(
    {
      "/v1/gettoken": () => {
        m += 1
        return new Response(JSON.stringify(m === 1 ? { code: 200, token: 500, agent_token: 3978 } : { code: 200, token: 480, agent_token: 4000 }), { status: 200 })
      },
      "/v1/daily-sign": { body: { code: 200, message: "Success" } },
    },
    async () => q.auth.checkin(auth),
  )
  assert.equal(s.credit, 22, "a fall is not subtracted from the reward")
})

test("each endpoint is asked with its own method, host, body and credential", async () => {
  // The plugin's core design is the split: chat and the catalog on the claw
  // gateway, the account, check-in and points on kuaipaper — and each read
  // is a POST with a JSON body or a GET without one. A stub that matched on
  // a path substring saw none of it; a regression here is every request
  // 401/404 in production while the suite stays green.
  const p = await CodarPlugin()
  const calls = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true, retry_after: 60 } } },
      "/api/codar/activities/mine": { body: { code: 200, data: [] } },
      "/v1/daily-sign": { body: { code: 400, message: "24小时内仅可领取一次", data: { retry_after: 60 } } },
      "/v1/codar/models": { body: { object: "list", data: [{ id: "x" }] } },
    },
    async (calls) => {
      await p.auth.usage(auth)
      await p.auth.checkin(auth)
      await p.provider.models({ models: {} }, { auth: await auth() })
      return calls
    },
  )
  const seen = calls.map((c) => {
    const u = new URL(c.url)
    return {
      method: c.method,
      host: u.host,
      path: u.pathname,
      auth: c.init.headers.Authorization,
      ua: c.init.headers["User-Agent"],
      type: c.init.headers["Content-Type"],
      body: c.init.body,
    }
  })
  const one = (path, method) => {
    const hit = seen.filter((s) => s.path === path && s.method === method)
    assert.ok(hit.length > 0, `${method} ${path} was made`)
    return hit[0]
  }

  const points = one("/v1/gettoken", "POST")
  assert.equal(points.host, "api.kuaipaper.com", "points are the account host's")
  assert.equal(points.auth, `Bearer ${TOKEN}`, "with the account's own bearer token")
  assert.deepEqual(JSON.parse(points.body), { username: "user_1", token: 0 }, "and the account name in the body")

  const status = one("/v1/daily-sign/status", "POST")
  assert.equal(status.host, "api.kuaipaper.com")
  assert.deepEqual(JSON.parse(status.body), { username: "user_1" })

  const sign = one("/v1/daily-sign", "POST")
  assert.equal(sign.host, "api.kuaipaper.com")
  assert.equal(sign.auth, `Bearer ${TOKEN}`)
  assert.deepEqual(JSON.parse(sign.body), { username: "user_1" })

  const acts = one("/api/codar/activities/mine", "GET")
  assert.equal(acts.host, "api.claw.speedai.com", "activities are the gateway host's")
  assert.equal(acts.auth, `Bearer ${TOKEN}`)
  assert.equal(acts.body, undefined, "a GET carries no body")

  const cat = one("/v1/codar/models", "GET")
  assert.equal(cat.host, "api.claw.speedai.com")
  assert.equal(cat.body, undefined)

  for (const s of seen) {
    assert.equal(s.type, "application/json", "every request says it is JSON")
    assert.equal(s.ua, "node", "and goes out as the desktop's own fetch does")
  }
})

test("a 200 whose body says the token is invalid marks the account expired", async () => {
  // Measured: /v1/daily-sign answers HTTP 200 with {"code":401,"message":
  // "Invalid token"} for a token it will not take. Read as an HTTP error
  // this branch never runs, and the card keeps showing a stale balance.
  const p = await CodarPlugin()
  const r = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign": { body: { code: 401, message: "Invalid token" } },
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(r.outcome, "failed")
  assert.match(r.message, /登录已过期/)
})

test("a usage read with a locally expired token never reaches the vendor", async () => {
  // The token says when it runs out; past that every call would be a 401.
  // Said here as expired, the card marks the account and no request goes out
// — a read that asked anyway showed the vendor's words instead of "sign in".
  const old = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) - 60 })
  const p = await CodarPlugin()
  await withFetch({}, async (calls) => {
    const u = await p.auth.usage(async () => ({ type: "api", key: old }))
    assert.equal(u.signIn, "expired", "the account is marked for magpie")
    assert.match(u.error, /登录已过期/)
    assert.equal(calls.length, 0, "and nothing was sent")
  })
})

test("the vendor's catalog shape, as it answers today, is read field for field", () => {
  // Measured 2026-10-29: top-level {object:"list", data:[…]}, reasoning an
  // OBJECT ({default, levels}) rather than a boolean, modalities arrays,
  // protocol an object with a type. A catalog read through a shape we only
  // imagine loses context, images, or the protocol without a word.
  const live = {
    object: "list",
    schema_version: 1,
    config_version: 7,
    data: [
      {
        id: "claude-opus-5",
        display_name: "claude-opus-5",
        context_window: 1000000,
        input_modalities: ["text"],
        output_modalities: ["text"],
        protocol: { type: "anthropic_messages", method: "POST", path: "/v1/messages", authentication: "x-api-key" },
        reasoning: { default: "high", levels: [{ id: "off" }, { id: "low" }] },
        rate_badge: "1.50x",
      },
      {
        id: "auto",
        display_name: "auto",
        context_window: 1000000,
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
        protocol: { type: "openai_chat_completions" },
        reasoning: { default: "high", levels: [] },
      },
    ],
  }
  const list = catalogOf(live)
  assert.equal(list.length, 2, "the top-level data array is the list")
  const opus = list.find((m) => m.id === "claude-opus-5")
  assert.equal(opus.context, 1000000)
  assert.deepEqual(opus.input, ["text"])
  assert.equal(opus.protocol, "anthropic_messages")
  assert.equal(opus.reasoning, true, "a reasoning object is reasoning: the vendor states levels, not a boolean")
  const auto = list.find((m) => m.id === "auto")
  assert.deepEqual(auto.input, ["text", "image"], "images survive")
  assert.equal(auto.protocol, "openai_chat_completions")

  // and the same list builds the same models through the provider path
  const m = modelOf(opus)
  assert.equal(m.provider.npm, "@ai-sdk/anthropic", "the anthropic model keeps its own SDK")
  assert.equal(m.attachment, false, "no image modality, no attachment")
  assert.equal(modelOf(auto).attachment, true)
})

test("the models hook is handed and answers the top-level catalog shape", async () => {
  // The host hands the hook the whole provider; the vendor answers with a
  // top-level {object:"list", data:[…]} (measured 2026-10-29). Fixtures in
  // the nested {catalog:{data}} shape would let a parser that only reads the
  // nested one pass while production falls back to the embedded list.
  const p = await CodarPlugin()
  const given = { id: "codar", models: { "deepseek-v4.1-flash": modelOf({ id: "deepseek-v4.1-flash" }) } }
  const fresh = await withFetch(
    {
      "/v1/codar/models": {
        body: { object: "list", schema_version: 1, config_version: 7, data: [{ id: "new-model", display_name: "New", context_window: 2000, input_modalities: ["text"], output_modalities: ["text"], protocol: { type: "openai_chat_completions" } }] },
      },
    },
    async () => p.provider.models(given, { auth: await auth() }),
  )
  assert.deepEqual(Object.keys(fresh), ["new-model"], "the live list replaces the embedded one")
  assert.equal(fresh[Symbol.for("magpie.fellBack")], undefined, "and is not marked as a fallback")
})

test("a catalog larger than the wire allows is cut, not handed to the host", async () => {
  // The host passes a hook's answer to Go as one JSON line and kills the
  // whole plugin host past 32 MiB (host.go maxWireLine) — every plugin in
  // it, not just this one. A vendor answering with an unbounded list must
  // not be able to take the host down with data.
  const many = Array.from({ length: 5000 }, (_, i) => ({ id: `m${i}`, display_name: `M${i}`, protocol: { type: "openai_chat_completions" } }))
  const list = catalogOf({ object: "list", data: many })
  assert.equal(list.length, 2000, "the list is capped")
  const p = await CodarPlugin()
  const fresh = await withFetch(
    { "/v1/codar/models": { body: { object: "list", data: many } } },
    async () => p.provider.models({ models: {} }, { auth: await auth() }),
  )
  assert.equal(Object.keys(fresh).length, 2000)
})

test("a balance that is not a number fails the read instead of becoming 0", async () => {
  // Number(" ") is 0, Number([]) is 0, Number(true) is 1. A fabricated 0 is
  // a balance the account does not have, and routing reads it as spent.
  const p = await CodarPlugin()
  for (const bad of [{ code: 200, token: " ", agent_token: null }, { code: 200 }, { code: 200, token: [], agent_token: null }]) {
    const u = await withFetch(
      {
        "/v1/gettoken": { body: bad },
        "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true, retry_after: 60 } } },
        "/api/codar/activities/mine": { body: { code: 200, data: [] } },
      },
      async () => p.auth.usage(auth),
    )
    assert.ok(u.error, `a body of ${JSON.stringify(bad)} is a read that failed, not a balance of 0`)
  }
  // and a numeric string still reads as the number it says
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: "2348", agent_token: "0" } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true, retry_after: 60 } } },
      "/api/codar/activities/mine": { body: { code: 200, data: [] } },
    },
    async () => p.auth.usage(auth),
  )
  assert.match(u.balance, /2348/)
})

test("isSigned as the string \"false\" is not read as signed", async () => {
  // Boolean("false") is true: a vendor that switches to string flags would
  // show an unclaimed day as claimed, and the claim window would say the
  // user already has it.
  const p = await CodarPlugin()
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 1, agent_token: 0 } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: "false", retry_after: 60 } } },
      "/api/codar/activities/mine": { body: { code: 200, data: [] } },
    },
    async () => p.auth.usage(auth),
  )
  const win = u.windows.find((w) => w.name === "每日签到")
  assert.match(win.display, /还没领/)
})

test("a payload-only or space-split echo of the token is still cut", async () => {
  // A server that quotes back part of the credential — the payload alone,
  // or the token with a space spliced in (even inside a segment, where the
  // shape alone would leave the halves behind) — used to leave it on the
  // card.
  const jwt = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 3600 })
  const [header, payload, sig] = jwt.split(".")
  const boom = (msg) => Object.assign(new Error(msg), {})
  const p = await CodarPlugin()
  for (const echoed of [
    `${header}.${payload}`,
    `${header} ${payload}.${sig}`,
    `${header.slice(0, 4)} ${header.slice(4)}.${payload}.${sig}`,
    jwt.slice(0, 40),
  ]) {
    const r = await p.auth.checkin(async () => {
      throw boom(`bad key ${echoed}`)
    })
    assert.doesNotMatch(r.message, /eyJ[\w-]{10,}|eqJ|yJh|\s{2}/, `"${echoed.slice(0, 20)}…" does not reach the card`)
    assert.match(r.message, /…/)
  }
})

test("a vendor string with a bidi override or a zero-width space is cleaned", () => {
  const list = catalogOf({
    data: [
      { id: "ok", display_name: "Fine\u202eName\u200b", protocol: { type: "openai_chat_completions" } },
      { id: "bad\u202eid", display_name: "Bad", protocol: { type: "openai_chat_completions" } },
    ],
  })
  assert.deepEqual(list.map((m) => m.id), ["ok"], "an id with a bidi override in it is not an id a request can ask for")
  assert.equal(list[0].name, "Fine Name", "the name is one clean line")
})

test("the usage account name is cleaned like every other vendor string", async () => {
  const p = await CodarPlugin()
  const odd = mkToken({ username: "user\u202e_1", exp: Math.floor(Date.now() / 1000) + 3600 })
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 1, agent_token: 0 } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true, retry_after: 60 } } },
      "/api/codar/activities/mine": { body: { code: 200, data: [] } },
    },
    async () => p.auth.usage(async () => ({ type: "api", key: odd })),
  )
  assert.equal(u.user, "user _1", "a bidi override never reaches the card")
})

test("the config hook keeps a provider-level api and npm the user set", async () => {
  // The config hook runs on every start. Writing ours over the user's
  // proxy address would silently undo it — the same rule the name follows.
  const p = await CodarPlugin()
  const config = { provider: { codar: { api: "https://my-proxy.example/v1", npm: "@ai-sdk/custom" } } }
  await p.config(config)
  assert.equal(config.provider.codar.api, "https://my-proxy.example/v1", "the user's api is left alone")
  assert.equal(config.provider.codar.npm, "@ai-sdk/custom", "and so is the user's npm")
  assert.equal(config.provider.codar.name, "科搭 Codar", "the default name still fills in when none was set")
})

test("the config hook fills in api and npm when the user set none", async () => {
  const p = await CodarPlugin()
  const config = {}
  await p.config(config)
  assert.equal(config.provider.codar.api, "https://api.claw.speedai.com/v1")
  assert.equal(config.provider.codar.npm, "@ai-sdk/openai-compatible")
})

test("a vendor answering with a pile of activities is cut to what a card holds", async () => {
  // Each running activity becomes a window in the one JSON line the host
  // passes to Go; an unbounded pile is the usage-side of the same 32 MiB
  // limit the catalog has to respect.
  const until = Math.floor(Date.now() / 1000) + 3600
  const many = Array.from({ length: 500 }, (_, i) => ({ status: "active", free_until: until, remaining_quota: null, model_ids: [`m${i}`] }))
  const p = await CodarPlugin()
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 1, agent_token: 0 } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true, retry_after: 60 } } },
      "/api/codar/activities/mine": { body: { code: 200, data: many } },
    },
    async () => p.auth.usage(auth),
  )
  const free = u.windows.filter((w) => w.name.startsWith("免费模型"))
  assert.equal(free.length, 20, "twenty windows, not five hundred")
})

test("a token split by two spaces or a CRLF is cut like any other", async () => {
  // The shape used to allow one whitespace character between chunks, so a
  // double space — or a CRLF, which controlChars turns into exactly two
  // spaces — left the payload tail and the whole signature on the card.
  const jwt = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 3600 })
  const [, payload, sig] = jwt.split(".")
  const p = await CodarPlugin()
  for (const echoed of [`${jwt.slice(0, 45)}  ${jwt.slice(45)}`, `${jwt.slice(0, 30)}\r\n${jwt.slice(30)}`]) {
    const r = await p.auth.checkin(async () => {
      throw new Error(`bad key ${echoed}`)
    })
    assert.doesNotMatch(r.message, new RegExp(payload.slice(0, 12)), "no payload tail reaches the card")
    assert.doesNotMatch(r.message, new RegExp(`${sig.slice(0, 3)}`), "and no signature")
    assert.match(r.message, /…/)
  }
})

test("a check-in wait no number can say is left out, not said as Infinity", async () => {
  // retry_after: 1e999 is valid JSON and parses to Infinity; "can claim again
  // in Infinity days" is not a thing a card should say.
  const p = await CodarPlugin()
  const r = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign": () => new Response('{"code":400,"message":"24小时内仅可领取一次","data":{"retry_after":1e999}}', { status: 200, headers: { "Content-Type": "application/json" } }),
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(r.outcome, "done")
  assert.doesNotMatch(r.message, /Infinity|NaN/)
  assert.equal(r.message, "今天已领过", "the wait is left out, the claim is still said")
})

test("an activity whose numbers are not finite says no share, not Infinity", async () => {
  const until = Math.floor(Date.now() / 1000) + 3600
  const p = await CodarPlugin()
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 1, agent_token: 0 } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true, retry_after: 60 } } },
      "/api/codar/activities/mine": () => new Response(JSON.stringify({ code: 200, data: [{ status: "active", free_until: until, remaining_quota: 10, user_quota_limit: Infinity, model_ids: ["a"] }] }).replace("null", "1e999"), { status: 200, headers: { "Content-Type": "application/json" } }),
    },
    async () => p.auth.usage(auth),
  )
  const free = u.windows.find((w) => w.name.startsWith("免费模型"))
  assert.ok(free, "the activity is still drawn")
  assert.doesNotMatch(free.display, /Infinity|NaN/, "the card says a usable thing")
  assert.equal(free.used, undefined, "no share invented from numbers nobody can use — and 'no share' is not the number 0")
})

test("a claim row whose time no calendar can state carries no resetsAt, not 1970", async () => {
  // host.js's when(0) is "1970-01-01T00:00:00.000Z", not "not said": a window
  // that computes its time as 0 draws the epoch on the card. retry_after
  // 1e308 is finite, so every "> 0" check passed it, while ×1000 overflowed
  // to Infinity — and safeTime turns that into 0.
  const p = await CodarPlugin()
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign/status": () => new Response('{"code":200,"data":{"isSigned":true,"retry_after":1e308}}', { status: 200, headers: { "Content-Type": "application/json" } }),
      "/api/codar/activities/mine": { body: { code: 200, data: [] } },
    },
    async () => p.auth.usage(auth),
  )
  const sign = u.windows.find((w) => w.name === "每日签到")
  assert.ok(sign, "the claim row is still there")
  assert.equal("resetsAt" in sign, false, "with no time, rather than the epoch")
  assert.equal(sign.display, "今天已领", "and a text a card can show")
})

test("an activity whose end no calendar can state carries no resetsAt, not 1970", async () => {
  // Two ways an end time cannot be written down, and one that can. 1e999 is
  // valid JSON that reads as Infinity; 316224000000 seconds is about the year
  // 12000, a real number a calendar cannot spell. Both pass the vendor app's
  // own rule (a free_until in the future), and neither may reach the card as
  // a time — the epoch (when(0)) or a rounded 9999-12-31 are both dates the
  // vendor never stated. A year-9999 end is a real instant and is drawn.
  const p = await CodarPlugin()
  // the body is written as text: JSON.stringify turns 1e999 into null, and
  // the point of that case is a body that really says Infinity
  const read = async (freeUntilText) =>
    withFetch(
      {
        "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
        "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true, retry_after: 3600 } } },
        "/api/codar/activities/mine": () =>
          new Response(`{"code":200,"data":[{"status":"active","free_until":${freeUntilText},"remaining_quota":null,"model_ids":["a"]}]}`, { status: 200, headers: { "Content-Type": "application/json" } }),
      },
      async () => p.auth.usage(auth),
    )
  const far = (await read("316224000000")).windows.find((w) => w.name.startsWith("免费模型"))
  assert.ok(far, "an activity ending in the year 12000 is still reported: it is running")
  assert.equal("resetsAt" in far, false, "but a date no calendar can spell is not handed on")

  const beyond = (await read("1e999")).windows.find((w) => w.name.startsWith("免费模型"))
  assert.ok(beyond, "and so is one whose end reads as Infinity")
  assert.equal("resetsAt" in beyond, false, "without a reset time the host would draw as 1970")
  assert.equal(beyond.display, "免费使用中（不限量）")

  const last = (await read("253402300799")).windows.find((w) => w.name.startsWith("免费模型"))
  assert.equal(last.resetsAt, 253402300799000, "the last instant both ends accept is a time, and is said")
})

test("a max_concurrency of the wrong type does not pin the account to one at a time", async () => {
  const p = await CodarPlugin()
  await withFetch(
    { "/v1/codar/models": { body: { object: "list", data: [{ id: "x", max_concurrency: true }] } } },
    async () => p.provider.models({ models: {} }, { auth: await auth() }),
  )
  assert.equal(p.auth.maxConcurrency, 3, "a boolean is not a number of requests")
  const q = await CodarPlugin()
  await withFetch(
    { "/v1/codar/models": { body: { object: "list", data: [{ id: "x", max_concurrency: 7 }] } } },
    async () => q.provider.models({ models: {} }, { auth: await auth() }),
  )
  assert.equal(q.auth.maxConcurrency, 7, "a real number still is")
  // The vendor can state one per model; the account queues at the smallest,
  // and only a count a host can keep is a count at all. The 700k-entry test
  // below puts the smallest value last, so a fold that kept the last one
  // would pass it — these put it first.
  assert.equal(publishedConcurrency({ data: [{ max_concurrency: 2 }, { max_concurrency: 9 }] }), 2, "the smallest wins, wherever it sits")
  assert.equal(publishedConcurrency({ max_concurrency: 5, data: [{ max_concurrency: 9 }] }), 5, "a provider-level count counts")
  assert.equal(publishedConcurrency({ data: [{ max_concurrency: 2.5 }] }), 0, "a fraction is not a count of requests")
  assert.equal(publishedConcurrency({ data: [{ max_concurrency: 5000 }] }), 0, "nor is a number no account could honour")
  assert.equal(publishedConcurrency({ data: [{ max_concurrency: 1000 }] }), 1000, "the cap itself is a count")
  assert.equal(publishedConcurrency({ data: [{ max_concurrency: "4" }] }), 4, "a numeric string is a number, as the vendor client reads them")
})

test("a catalog big enough to overflow a spread argument still yields its concurrency", async () => {
  // publishedConcurrency walks the vendor's whole list (the 2000-entry cap is
  // on the answer given the host, not on this reading) and used to fold it
  // with Math.min(...nums). A spread passes one argument per entry, and past
  // ~125k entries on Node (~640k on Bun) that throws "Maximum call stack size
  // exceeded" — inside the models hook, where the catch turns it into a
  // fallback, so a catalog that is merely enormous would cost the live list
  // and the vendor's concurrency. The fold is now a running minimum.
  const shared = { max_concurrency: 9 }
  const many = new Array(700000).fill(shared)
  many[699999] = { max_concurrency: 2 }
  assert.equal(publishedConcurrency({ data: many }), 2, "the smallest the catalog names, however long the list is")

  // the same shape through the models hook: no fallback, the number applied
  const entries = []
  for (let i = 0; i < 130000; i++) entries.push(i === 129999 ? { id: "m-last", max_concurrency: 2 } : { id: `m${i}`, max_concurrency: 9 })
  const p = await CodarPlugin()
  const out = await withFetch(
    { "/v1/codar/models": { body: { object: "list", data: entries } } },
    async () => p.provider.models({ models: {} }, { auth: await auth() }),
  )
  assert.equal(out[Symbol.for("magpie.fellBack")], undefined, "no fallback: the size alone is not a failure")
  assert.equal(p.auth.maxConcurrency, 2, "and the catalog's number reaches the account")
})

test("a context window that is not a positive number is read as not stated", () => {
  const list = catalogOf({
    data: [
      { id: "neg", context_window: -5, protocol: { type: "openai_chat_completions" } },
      { id: "inf", context_window: 1e999, protocol: { type: "openai_chat_completions" } },
      { id: "ok", context_window: 200000, protocol: { type: "openai_chat_completions" } },
    ],
  })
  const by = (id) => list.find((m) => m.id === id)
  assert.equal(by("neg").context, 0, "a negative window is not a size")
  assert.equal(by("inf").context, 0, "nor is an infinite one")
  assert.equal(by("ok").context, 200000)
  assert.equal(modelOf({ id: "neg", context: -5 }).limit.context, 0, "and the same on the model path")
})

test("the config hook merges a user's model override field by field", async () => {
  // A shallow merge replaced the whole entry: a user who only set a model's
  // name lost provider.npm with it, and a Claude model went out over the
  // chat protocol.
  const p = await CodarPlugin()
  const config = { provider: { codar: { models: { [ANTHROPIC_ID]: { name: "我的名字" } } } } }
  await p.config(config)
  const m = config.provider.codar.models[ANTHROPIC_ID]
  assert.equal(m.name, "我的名字", "the user's field wins")
  assert.equal(m.provider?.npm, "@ai-sdk/anthropic", "and the catalog's own fields stay")
  assert.ok(m.api?.url, "including the api entry")
})

test("a nested override keeps the catalog's fields beside it, as the host reads them", async () => {
  // The top-level merge kept the catalog's fields, but one level down it was
  // still a replacement: `{ provider: { api } }` dropped provider.npm, and
  // host.js's info() — m.provider?.npm ?? cfg.npm ?? … — then gave the Claude
  // model the provider-level openai-compatible, so it went out over the chat
  // protocol; `{ limit: { output } }` dropped the context window the same way.
  const p = await CodarPlugin()
  const config = {
    provider: {
      codar: {
        models: {
          [ANTHROPIC_ID]: { provider: { api: "https://proxy.example/v1" } },
          [LISTED_ID]: { limit: { output: 4096 } },
        },
      },
    },
  }
  await p.config(config)
  const opus = config.provider.codar.models[ANTHROPIC_ID]
  assert.equal(opus.provider.api, "https://proxy.example/v1", "the address the user set")
  assert.equal(opus.provider.npm, "@ai-sdk/anthropic", "and the SDK that address still needs")
  assert.equal(opus.limit.context, 1000000, "the catalog's limit is untouched")
  const glm = config.provider.codar.models[LISTED_ID]
  assert.equal(glm.limit.output, 4096, "the ceiling the user set")
  const listed = CATALOG.find((m) => m.id === LISTED_ID)
  assert.equal(glm.limit.context, listed.context, "beside the context window the catalog stated")
  assert.equal(glm.provider.npm, "@ai-sdk/openai-compatible", "and the model's own SDK")
})

test("a value that is not a map is taken as the user wrote it", () => {
  // The merge goes into maps only: a list (modalities.input, variants) or a
  // primitive is a value the user replaced, not a map to fold into ours.
  const ours = { modalities: { input: ["text", "image"], output: ["text"] }, name: "a", variants: ["low", "high"] }
  const merged = mergeModel(ours, { modalities: { input: ["text"] }, name: "b", variants: [] })
  assert.deepEqual(merged.modalities, { input: ["text"], output: ["text"] }, "the list is replaced, its sibling map field kept")
  assert.equal(merged.name, "b")
  assert.deepEqual(merged.variants, [], "an empty list is the user's answer, not a missing one")
  assert.equal(ours.name, "a", "the catalog's own entry is not changed")
})

test("a model override never writes the magic keys every object shares", () => {
  // A hand-written plugins.json entry is parsed from JSON, which can carry
  // keys that do not belong to a model: `__proto__` written onto an object
  // sets its prototype instead of a field — so a hostile or fat-fingered
  // entry would put inherited getters under m.name/m.provider through the
  // share from Object.prototype — and `constructor`/`toString` would ride
  // along as own keys the host copies into the model it lists. No model has
  // a field by any of those names, so each is simply dropped.
  const ours = { name: "ours", provider: { npm: "@ai-sdk/anthropic" } }
  const entry = JSON.parse('{"__proto__": {"name": "hijacked", "provider": {"npm": "evil"}}, "constructor": {"polluted": true}, "name": "x"}')
  const merged = mergeModel(ours, entry)
  assert.equal(Object.getPrototypeOf(merged), Object.prototype, "the merged entry's prototype is untouched")
  assert.equal(merged.constructor, Object, "the constructor key is not spliced in as an own key")
  assert.equal(merged.name, "x", "the real name the user wrote wins")
  assert.equal(merged.provider.npm, "@ai-sdk/anthropic", "and the catalog's provider survives")
  assert.equal(({}).name, undefined, "not a single object in the process is affected")
})

test("a model entry that is not an object is dropped, not handed to the host", async () => {
  // host.js's info() reads every config model's own id and provider while it
  // builds the provider's row; a null entry throws inside the Promise.all
  // that builds every provider, so one broken line took the whole provider
  // list down — not just that model. A model is a plain object; null, a
  // string, a number or an array is not one, and an array is not a map.
  const p = await CodarPlugin()
  // four catalog ids, asked of the catalog: the test is about the broken
  // entries, not about which names the vendor serves this month
  const chat = CATALOG.filter((m) => m.protocol !== "anthropic_messages").map((m) => m.id)
  const [a, b, c] = [chat[0], chat[1], chat[2]]
  const config = {
    provider: {
      codar: {
        models: {
          [ANTHROPIC_ID]: null,
          [a]: "not a model",
          [b]: 7,
          [c]: ["not", "a", "model"],
          "my-own": { id: "my-own", name: "Mine" },
        },
      },
    },
  }
  await p.config(config)
  const models = config.provider.codar.models
  for (const id of [ANTHROPIC_ID, a, b, c]) {
    assert.equal(models[id]?.id, id, `${id} is the catalog's own entry, not the broken one`)
    assert.ok(models[id].provider?.npm, `${id} still carries the fields the host reads`)
  }
  assert.equal(models["my-own"].name, "Mine", "a model of the user's own is kept")
  assert.equal(Object.keys(models).length, CATALOG.length + 1, "the whole catalog and the user's one")

  const other = { provider: { codar: { models: [{ id: "x" }] } } }
  await p.config(other)
  assert.equal(Object.keys(other.provider.codar.models).length, CATALOG.length, "an array of models is no model map")
})

test("a points answer whose code is not 200 is a refusal, not a balance of 0", async () => {
  // The vendor's own client refuses any answer whose code is a number other
  // than 200 before it reads the balances (app.asar's ft: Number(e.code),
  // finite and not 200, throws). Read only as ">= 400 is an error", a
// refusal spelled {code: 1, token: 0} came out as the vendor's words, and routing took
  // the account for spent.
  const p = await CodarPlugin()
  for (const bad of [{ code: 1, token: 0 }, { code: 0, token: 0 }]) {
    const u = await withFetch(
      {
        "/v1/gettoken": { body: bad },
        "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true, retry_after: 60 } } },
        "/api/codar/activities/mine": { body: { code: 200, data: [] } },
      },
      async () => p.auth.usage(auth),
    )
    assert.ok(u.error, `a body of ${JSON.stringify(bad)} is a read that failed, not a balance of 0`)
    assert.equal(u.windows, undefined, "and no card is drawn from it")
  }
  // the check-in still claims; an unreadable balance is no credit, not a zero
  const r = await withFetch(
    {
      "/v1/gettoken": { body: { code: 1, token: 0 } },
      "/v1/daily-sign": { body: { code: 200, message: "Success" } },
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(r.outcome, "claimed")
  // an unreadable balance is never stated as a credit: 0 would say the claim
  // gained nothing, which is not what an unreadable read knows
  assert.equal(r.credit, undefined)
})

test("the balances are read from data when the vendor wraps them, as its client does", async () => {
  // The vendor's client unwraps `data` when it is an object (app.asar's Gt)
  // before reading the balances. The live body is flat, but a wrapped one
  // used to read as "no balance at all" — an error card over a real account.
  const p = await CodarPlugin()
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, data: { token: 7, agent_token: 3 } } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true, retry_after: 60 } } },
      "/api/codar/activities/mine": { body: { code: 200, data: [] } },
    },
    async () => p.auth.usage(auth),
  )
  const wallet = u.windows.find((w) => w.name === "点数余额")
  assert.equal(wallet.balance, 7, "the wrapped figure is the balance")
  assert.match(u.balance, /7 点/)
  assert.match(u.balance, /Agent 3 点/)
})

test("a claim state the vendor refused is not drawn as claimable", async () => {
  // The vendor's client refuses a status answer with a numeric code other
  // than 200 (app.asar's b0: ft before um) and reads nothing from it.
  // Drawn from data alone, {code: 500, data: {isSigned: false}} said "can
  // claim now" — an offer the vendor would have refused.
  const p = await CodarPlugin()
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign/status": { body: { code: 500, message: "获取签到状态失败，请稍后重试", data: { isSigned: false, retry_after: 60 } } },
      "/api/codar/activities/mine": { body: { code: 200, data: [] } },
    },
    async () => p.auth.usage(auth),
  )
  assert.equal(u.windows.find((w) => w.name === "每日签到"), undefined, "a refused answer draws no claim row")
  assert.ok(u.windows.find((w) => w.name === "点数余额"), "the points still show")
})

test("a wait the vendor spelled as a boolean or an array is not a wait", async () => {
  // Number(true) is 1 and Number([3600]) is 3600, so a boolean retry_after
// was said as the vendor's words and an array as an hour. The vendor's own
  // client takes a number or a string that says one (app.asar's Po).
  assert.equal(humanSecs(true), "", "a boolean is not a number of seconds")
  assert.equal(humanSecs([3600]), "")
  assert.equal(humanSecs("3600"), "1 小时", "a numeric string still is")

  const p = await CodarPlugin()
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true, retry_after: true } } },
      "/api/codar/activities/mine": { body: { code: 200, data: [] } },
    },
    async () => p.auth.usage(auth),
  )
  const sign = u.windows.find((w) => w.name === "每日签到")
  assert.equal(sign.display, "今天已领", "the claim is said, the made-up wait is not")
  assert.equal("resetsAt" in sign, false)

  // and the check-in's own wait: an array is not a next-claim time
  const r = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign": { body: { code: 400, message: "24小时内仅可领取一次", data: { retry_after: [3600] } } },
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(r.outcome, "done")
  assert.equal(r.message, "今天已领过", "no hour the vendor never stated")
  assert.ok(r.until <= Date.now() + 31 * 60 * 1000, "the trust floor, not a time it never said")
})

test("the reply ceiling the vendor states is on the model", () => {
  // The vendor's request schema states max_tokens.maximum per model, and
  // magpie lowers a request asking for more to the model's limit.output
  // (gateway's maxoutput.go): without it, an agent asking past the ceiling
  // got the vendor's refusal instead of a lowered request.
  const list = catalogOf({
    data: [
      { id: "stated", request_schema: { properties: { max_tokens: { maximum: 131072 } } }, protocol: { type: "openai_chat_completions" } },
      { id: "unstated", protocol: { type: "openai_chat_completions" } },
      { id: "odd", request_schema: { properties: { max_tokens: { maximum: true } } }, protocol: { type: "openai_chat_completions" } },
    ],
  })
  const by = (id) => list.find((m) => m.id === id)
  assert.equal(by("stated").maxOutput, 131072, "the stated ceiling is read")
  assert.equal(by("unstated").maxOutput, 0, "none stated is not a ceiling")
  assert.equal(by("odd").maxOutput, 0, "a boolean is not a ceiling")
  assert.equal(modelOf(by("stated")).limit.output, 131072, "and it reaches the model magpie builds")
  assert.equal(modelOf(by("unstated")).limit.output, 0)
})

test("a catalog record that is not an object is skipped, not handed on", () => {
  // The same Promise.all trap as the config hook: the models hook answers
  // with this list, and one null in it would throw while the host builds its
  // rows. A record with no id has nothing to serve either.
  const list = catalogOf({ data: [null, true, 7, "x", ["also", "not", "a", "record"], { id: "ok", protocol: { type: "openai_chat_completions" } }] })
  assert.deepEqual(list.map((m) => m.id), ["ok"])
})

test("the day's own statements are read the same way whatever the envelope says", async () => {
  // Shapes the check-in used to read off the wrapper instead of the vendor's
  // own statement: a body the gateway re-labelled with another HTTP status, a
  // success sentence carrying the window rule, a 200 beside failure words, an
  // explicit success:false behind the weak 400-beside-a-wait pair, a wait only
  // the header carried, an expiry only the body code carried, a restriction
  // whose code the gateway stripped, and a refusal that said its wait twice.
  const p = await CodarPlugin()
  const read = (body, status = 200, headers = {}) =>
    withFetch(
      {
        "/v1/gettoken": { body: { code: 200, token: 1, agent_token: 0 } },
        "/v1/daily-sign": () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } }),
      },
      async () => p.auth.checkin(auth),
    )
  for (const status of [409, 422, 429, 500, 503]) {
    const r = await read({ code: 400, message: "24小时内仅可领取一次", data: { retry_after: 3600 } }, status)
    assert.equal(r.outcome, "done", "the claim body under any HTTP status is the day claimed")
    assert.ok(r.until > Date.now() + 3000000, "and the wait the body states still holds")
  }
  const both = await read({ code: 200, message: "领取成功，24小时内仅可领取一次" })
  assert.equal(both.outcome, "claimed", "a success sentence with the window rule appended is this claim")
  assert.equal(both.message, "领取成功，24小时内仅可领取一次", "and keeps the vendor's words")

  // A success word with no business code beside an HTTP error is not a claim.
  // A gateway shell that happens to contain the word ("Success"), or a server
  // that repeated it while failing, used to settle the day and stop magpie
  // from asking again — the day was recorded, the credit was not, and nothing
  // re-checked. The word needs a code that can carry a claim: 200 (the
  // business layer said yes) or 400 (the layer refused while the body said the
  // claim landed).
  for (const status of [400, 429, 500, 503]) {
    const bare = await read({ message: "签到成功" }, status)
    assert.equal(bare.outcome, "failed", `a bare success word under HTTP ${status} is not a claim`)
  }
  const bareEnglish = await read({ message: "Success" }, 502)
  assert.equal(bareEnglish.outcome, "failed", "nor is the English word a gateway error body may carry")

  // The same word with the business code that can carry it still claims: the
  // status came from a hop in front, the body is the vendor's.
  const coded = await read({ code: 200, message: "签到成功" }, 500)
  assert.equal(coded.outcome, "claimed", "a body that states business code 200 is the vendor's claim")

  const negated = await read({ code: 200, message: "签到失败，请稍后重试" })
  assert.equal(negated.outcome, "failed", "a 200 beside failure words is a refusal")

  const flag = await read({ code: 400, message: "Bad Request", data: { retry_after: 60 }, success: false })
  assert.equal(flag.outcome, "failed", "an explicit success:false is not overridden by the 400-beside-a-wait pair")
  assert.match(flag.message, /1 分钟后可重试/)

  const headerOnly = await read({ code: 400, message: "24小时内仅可领取一次" }, 400, { "Retry-After": "3600" })
  assert.equal(headerOnly.outcome, "done", "a claimed day whose wait is only in the header")
  assert.ok(headerOnly.until > Date.now() + 3000000, "reads that wait rather than the trust floor")

  const expired = await read({ code: 401, message: "Invalid token" }, 400)
  assert.equal(expired.message, "登录已过期，请重新登录", "a body business code of 401 is an expired sign-in")

  const restrictedBody = await read({ code: 200, message: "API access is restricted" })
  assert.equal(restrictedBody.outcome, "failed", "a restricted sentence without its code is still the restriction")
  assert.match(restrictedBody.message, /account_restricted/)

  const doubled = await read({ code: 999, message: "系统繁忙", data: { retry_after: 60 } }, 400, { "Retry-After": "120" })
  assert.equal((doubled.message.match(/可重试/g) || []).length, 1, "one wait, not two")
})

test("a claim sentence beside a failure word is not the day claimed", async () => {
  // The 200 path read the "already claimed" wording without the failure veto
// the HTTP-400 path applied: a body that said both the vendor's words and
  // that this attempt failed settled the day at zero points. The two branches
  // now read the sentence the same way.
  const p = await CodarPlugin()
  const read = (body) =>
    withFetch(
      {
        "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
        "/v1/daily-sign": { body },
      },
      async () => p.auth.checkin(auth),
    )
  const failed = await read({ message: "24小时内仅可领取一次，本次签到失败", data: { retry_after: 3600 } })
  assert.equal(failed.outcome, "failed", "a failure word beside the claim sentence is not a claim")
  assert.match(failed.message, /可重试/, "and the wait it stated is still said")
  const negated = await read({ message: "24小时内仅可领取一次, but this attempt didn't succeed" })
  assert.equal(negated.outcome, "failed", "the English veto covers this branch too")
  const claimed = await read({ message: "24小时内仅可领取一次" })
  assert.equal(claimed.outcome, "done", "the sentence alone is still the day claimed")
})

test("a day's sentence two data levels in is still the day's sentence", async () => {
  // A gateway can wrap the vendor's body more than once (the same shapes
  // request()'s and deepRefusal's comments describe). Read only off the
  // envelope, "Already signed today" two levels down was a claim with no
  // credit, and on the error branch a failure named "HTTP 400".
  const p = await CodarPlugin()
  const read = (answer) =>
    withFetch(
      {
        "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
        "/v1/daily-sign": answer,
      },
      async () => p.auth.checkin(auth),
    )
  const settled = await read({ body: { code: 200, data: { data: { message: "Already signed today", retry_after: 86400 } } } })
  assert.equal(settled.outcome, "done", "the sentence is the day's, not this attempt's claim")
  assert.match(settled.message, /1 天后可再领/, "and its wait is stated")
  const settled400 = await read({ status: 400, body: { code: 400, data: { data: { message: "Already signed today", retry_after: 86400 } } } })
  assert.equal(settled400.outcome, "done", "the same on the error branch")
  assert.doesNotMatch(settled400.message, /HTTP 400/, "the envelope's status is not the answer")
  const wordCode = await read({ body: { code: 200, data: { data: { code: "already_claimed", message: "Already signed today", retry_after: 3600 } } } })
  assert.equal(wordCode.outcome, "done", "a wrapped already_claimed is the day's, not a refusal")
  assert.match(wordCode.message, /1 小时/)
  // and a real refusal two levels in is still a failure
  const refused = await read({ body: { code: 200, data: { data: { code: 500, message: "系统繁忙" } } } })
  assert.equal(refused.outcome, "failed", "a wrapped 500 is still a refusal")
  assert.match(refused.message, /系统繁忙/)

  // the usage card's claim row reads the same depth
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign/status": { body: { code: 200, data: { data: { isSigned: true, retry_after: 3600 } } } },
      "/api/codar/activities/mine": { body: { code: 200, data: [] } },
    },
    async () => p.auth.usage(auth),
  )
  const row = u.windows.find((w) => w.name === "每日签到")
  assert.ok(row, "the claim row is drawn from the wrapped status")
  assert.match(row.display, /今天已领/)
  // a refusal at the same depth is not a signed day, even beside isSigned
  const refusedStatus = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign/status": { body: { code: 200, data: { data: { code: 500, isSigned: true } } } },
      "/api/codar/activities/mine": { body: { code: 200, data: [] } },
    },
    async () => p.auth.usage(auth),
  )
  assert.equal(refusedStatus.windows.find((w) => w.name === "每日签到"), undefined, "a wrapped refusal draws no claim row")
})

test("an already-claimed day is not turned into a failure by the success flag", async () => {
  // The vendor's 400 for a day already claimed is both "this call did not
  // claim" and "this day is claimed", and the success flag it added to its
  // activity API says the first. Read as a failure, magpie retries the whole
  // day every 30 minutes (workbuddy_checkin.go's wbCheckinRetry) while the
  // card says the check-in failed over a day that was claimed — the flag
  // decides a code:200 "say yes", never the vendor's own "today is in".
  const p = await CodarPlugin()
  const body = { code: 400, message: "24小时内仅可领取一次", data: { retry_after: 3600 }, success: false }
  const r = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign": { body },
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(r.outcome, "done", "the vendor's own words about the day win over the flag")
  assert.match(r.message, /1 小时/)
  assert.ok(r.until > Date.now(), "and the wait the vendor stated still holds")

  // and the flag still decides where it said something the words did not
  const busy = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign": { body: { code: 200, success: false, message: "系统繁忙" } },
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(busy.outcome, "failed", "a refusal with nothing about the day is still a refusal")

  // The "already claimed" words are only the day's when the code can be the
  // day's either: a 401 that happens to quote them is a lapsed sign-in, not a
  // claimed day — reading it as done would settle the day off a real failure.
  const lapsed = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign": { body: { code: 401, message: "24小时内仅可领取一次", success: false } },
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(lapsed.outcome, "failed", "a 401 is not a claimed day, whatever it quotes")
})

test("an activity with a stated total is not called unlimited", async () => {
  // user_quota_limit is the vendor stating how much this activity gives.
// With remaining_quota unreadable, the card fell to the vendor's words and dropped
  // the total — the vendor said a number and the card said there is none.
  // The total is now said; only with no total at all is it unlimited. And a
  // remaining that exceeds the total is not a share: magpie would draw
// the vendor's words beside the vendor's "150 left".
  const until = Math.floor(Date.now() / 1000) + 3600
  const p = await CodarPlugin()
  const read = async (activity) =>
    withFetch(
      {
        "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
        "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: false } } },
        "/api/codar/activities/mine": { body: { success: true, data: [{ free_until: until, model_ids: ["a"], ...activity }] } },
      },
      async () => p.auth.usage(auth),
    )
  const capped = (await read({ user_quota_limit: 100, remaining_quota: null })).windows.find((w) => w.name.startsWith("免费模型"))
  assert.match(capped.display, /共 100/, "the total the vendor stated is said")
  assert.doesNotMatch(capped.display, /不限量/, "not called unlimited over a stated total")
  assert.equal(capped.amount, undefined, "no used is invented from one number")

  const over = (await read({ user_quota_limit: 100, remaining_quota: 150 })).windows.find((w) => w.name.startsWith("免费模型"))
  assert.match(over.display, /还剩 150/, "a remaining past the total is said as it is")
  assert.equal(over.amount, undefined, "and no share is made of two numbers that disagree")

  const unlimited = (await read({ user_quota_limit: null, remaining_quota: null })).windows.find((w) => w.name.startsWith("免费模型"))
  assert.match(unlimited.display, /不限量/, "with no total, unlimited is the vendor's own shape")

  const rounded = (await read({ user_quota_limit: 8, remaining_quota: 7 })).windows.find((w) => w.name.startsWith("免费模型"))
  assert.equal(rounded.used, 13, "a share of 12.5% is rounded to 13, not floored to 12")
  assert.equal(rounded.display, "免费使用中，已用 1 / 8")
})

test("the six promises no test used to pin", async () => {
  // Each of these is a guard the suite stayed green without (mutation-tested):
  // dropping it changes what magpie draws, so each gets its own sentence.
  //
  // 1. cost stays 0: magpie reads any input/output price above it as USD
  //    (plugins.go's pluginPrice), and the vendor prices in CNY.
  assert.deepEqual(modelOf({ id: "m" }).cost, { input: 0, output: 0, cache: { read: 0, write: 0 } }, "no price of our own")
  // 2. a real 0 balance is a balance: the account is spent, not unreadable.
  const p = await CodarPlugin()
  const zero = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 0, agent_token: 0 } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true } } },
      "/api/codar/activities/mine": { body: { code: 200, data: [] } },
    },
    async () => p.auth.usage(auth),
  )
  assert.match(zero.balance, /0 点/, "a spent account reads as spent, not as unknown")
  assert.equal(zero.windows.find((w) => w.name === "点数余额").balance, 0)
  // 3. the week ceiling on a check-in wait: a week is sayable, a second past
  //    it is not (a rolling 24-hour day cannot produce it).
  const wait = async (secs) => {
    const r = await withFetch(
      {
        "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
        "/v1/daily-sign": { body: { code: 400, message: "24小时内仅可领取一次", data: { retry_after: secs } } },
      },
      async () => p.auth.checkin(auth),
    )
    return r
  }
  const week = await wait(7 * 24 * 3600)
  assert.match(week.message, /7 天后可再领/, "exactly a week is a wait the window can name")
  assert.ok(week.until > Date.now() + 6 * 24 * 3600 * 1000, "and it is handed on")
  const past = await wait(7 * 24 * 3600 + 1)
  assert.doesNotMatch(past.message, /天后可再领/, "one second past the week is not a time this answer can hold on")
  assert.ok(past.until <= Date.now() + 31 * 60 * 1000, "it falls to the trust floor")
  // 4. a vendor name a card can hold: no longer than 120 characters.
  const long = catalogOf({ data: [{ id: "m", display_name: "名".repeat(300), protocol: { type: "openai_chat_completions" } }] })
  assert.equal(long[0].name.length, 120, "an endless vendor name is cut to what a card reads")
  // 5. a vendor message a card can hold: at most 400 characters.
  const shout = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign": { body: { code: 500, message: "x".repeat(600) } },
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(shout.message.length, 400, "an endless vendor message is cut too")
  // 6. a base the user set keeps its path clean: one slash, so the URL magpie
  //    builds is not "...//chat/completions".
  const base = await withFetch(
    { "/v1/codar/models": { body: { object: "list", data: [{ id: "solo", protocol: { type: "openai_chat_completions" } }] } } },
    async () => p.provider.models({ id: "codar", api: "https://proxy.example/v1///", models: {} }, { auth: await auth() }),
  )
  assert.equal(base["solo"].api.url, "https://proxy.example", "a trailing slash is taken off the user's own base")
})

test("a record's modality list keeps only the kinds the host knows", () => {
  // The list is written into catalog.mjs and persisted by the host, so it is
  // the one place a vendor's arbitrary value — an object, a credential — could
  // ride into a committed file and into the model list. Only known kind names
  // survive; the order the vendor used is kept, and a list that names none is
  // "text alone", as kindsOf reads it.
  const token = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
  const [rec] = catalogOf({ code: 200, data: [{ id: "m", input_modalities: ["image", { [token]: "text" }, "Text", 7, "text"], output_modalities: [{}] }] })
  assert.deepEqual(rec.input, ["image", "text"], "known kinds survive in the vendor's order")
  assert.deepEqual(rec.output, ["text"], "and a list that names none is text alone")
  assert.equal(JSON.stringify(rec).includes(token), false, "no vendor value rides along")
})

test("a modality list that names no kind is not a model that takes nothing", () => {
  // Every model here is a chat model. A modalities name this host does not
  // know — an empty list, a case change, a rename — used to come out as
  // "takes nothing", and magpie writes a stated image:false onto its catalog
  // as a fact (host.js's imageSaid). A missing field read as text alone, so
  // the same silence had two meanings; now both read as text alone.
  for (const mods of [undefined, [], ["Text"], ["image_梗"]]) {
    const m = modelOf(mods === undefined ? { id: "m" } : { id: "m", input: mods })
    assert.deepEqual(m.modalities.input, ["text"], `${JSON.stringify(mods)} is "text alone", not "nothing"`)
    assert.equal(m.capabilities.input.text, true, "and the model still takes text")
    assert.equal(m.attachment, false, "with no eyes claimed")
  }
  assert.deepEqual(modelOf({ id: "m", input: ["text", "image"] }).modalities.input, ["text", "image"], "a list naming kinds the host knows is read as it is")
})

test("an empty catalog the vendor answered is an answer, not a fallback", async () => {
  // The vendor answering 200 with no models is it saying this account is
  // served none; a fallback is not being able to ask at all. Read as a
  // failure, the fifteen stale entries stayed on the card and the requests
  // failed at the gateway instead of the list being honestly empty. A list
  // whose every record we had to drop is the other case — that is a list we
  // could not read, and it still falls back.
  const p = await CodarPlugin()
  const empty = await withFetch(
    { "/v1/codar/models": { body: { object: "list", data: [] } } },
    async () => p.provider.models({ models: {} }, { auth: await auth() }),
  )
  assert.deepEqual(Object.keys(empty), [], "the empty list is the list")
  assert.equal(empty[Symbol.for("magpie.fellBack")], undefined, "and nothing fell back")

  const unreadable = await withFetch(
    { "/v1/codar/models": { body: { object: "list", data: [{ noId: 1 }, null] } } },
    async () => p.provider.models({ models: { x: { id: "x" } } }, { auth: await auth() }),
  )
  assert.deepEqual(Object.keys(unreadable), ["x"], "a list we could not read keeps the one we had")
  assert.equal(unreadable[Symbol.for("magpie.fellBack")], true, "and says the vendor's list was not usable")
})

test("a model id that names an object property never writes the model map's prototype", async () => {
  // The seventh round's magic-key guard covers the fields inside a model
  // entry; this is the sibling door one level up, where the entry's own id is
  // the key. A hand-written plugins.json parsed from JSON carries `__proto__`
  // as an own key, and `merged["__proto__"] = m` on a plain object writes the
  // map's prototype — so `models.name` read the planted entry.
  const p = await CodarPlugin()
  const config = { provider: { codar: { models: JSON.parse('{"__proto__": {"name": "evil", "provider": {"npm": "evil"}}}') } } }
  await p.config(config)
  const models = config.provider.codar.models
  assert.equal(Object.getPrototypeOf(models), Object.prototype, "the model map's prototype is untouched")
  assert.equal(models.name, undefined, "and no planted field shows through it")
  assert.equal(Object.keys(models).length, CATALOG.length, "the catalog is what is listed")
})

test("a provider entry that is an array is replaced, not written into", async () => {
  // An array is an object, so `was` used to keep it — and `{...was}` spilled
  // its indices into the provider entry ("0", "1"…) on the user's own
  // providers file. The provider slot takes an object or nothing.
  const p = await CodarPlugin()
  const config = { provider: { codar: ["a", "b"] } }
  await p.config(config)
  assert.deepEqual(Object.keys(config.provider.codar), ["name", "npm", "api", "models"], "no index keys survive")
  assert.equal(config.provider.codar.name, "科搭 Codar")
})

// ---- round 10 ---------------------------------------------------------------

// The vendor's client reads its base as written; so the plugin writes down
// what it uses on both paths. config (magpie's cfg.api starter) used to keep
// the user's whitespace and trailing slashes when the live path took them
// off, so an account with a token that could not refresh sent requests to
// ".../v1//chat/completions" — which magpie's own test notes the vendor reads
// as a different path. baseURL makes both paths one rule.
test("a base the user wrote with spaces and slashes is cleaned on either path", async () => {
  const p = await CodarPlugin()
  // [typed, the provider's api, a model's own URL]: the provider keeps the
  // gateway address (with its /v1); a model's URL is the bare base.
  for (const [typed, providerApi, clean] of [
    ["https://proxy.example/v1/", "https://proxy.example/v1", "https://proxy.example"],
    ["  https://proxy.example/v1  ", "https://proxy.example/v1", "https://proxy.example"],
    ["https://proxy.example/v1//", "https://proxy.example/v1", "https://proxy.example"],
    ["https://proxy.example", "https://proxy.example/v1", "https://proxy.example"],
    ["   ", "https://api.claw.speedai.com/v1", "https://api.claw.speedai.com"],
    ["/", "https://api.claw.speedai.com/v1", "https://api.claw.speedai.com"],
    ["///", "https://api.claw.speedai.com/v1", "https://api.claw.speedai.com"],
    [42, "https://api.claw.speedai.com/v1", "https://api.claw.speedai.com"],
    [undefined, "https://api.claw.speedai.com/v1", "https://api.claw.speedai.com"],
  ]) {
    const config = { provider: { codar: { api: typed } } }
    await p.config(config)
    assert.equal(config.provider.codar.api, providerApi, `config: ${JSON.stringify(typed)}`)
    assert.equal(config.provider.codar.models.auto.api.url, clean, `config model: ${JSON.stringify(typed)}`)

    const live = await withFetch(
      { "/v1/codar/models": { body: { data: [{ id: "solo", protocol: { type: "openai_chat_completions" } }] } } },
      async () => p.provider.models({ id: "codar", api: typed, models: {} }, { auth: await auth() }),
    )
    assert.equal(live.solo.api.url, clean, `live: ${JSON.stringify(typed)}`)
  }
})

// The host's next step on a models-hook answer is `out.models[key] = …`: a
// bracket assignment, which sets the prototype when key is "__proto__".
// fromEntries and spread both make it an own key instead, so both our maps
// were clean and the caller's was not. No model is named that; the hook drops
// it so it never becomes one.
test("a model the vendor names __proto__ is dropped, not handed on as a prototype key", async () => {
  const p = await CodarPlugin()
  const fresh = await withFetch(
    {
      "/v1/codar/models": {
        body: {
          data: [
            { id: "__proto__", display_name: "Evil", protocol: { type: "openai_chat_completions" } },
            { id: "constructor", display_name: "C", protocol: { type: "openai_chat_completions" } },
            { id: "prototype", display_name: "P", protocol: { type: "openai_chat_completions" } },
            { id: "ok", display_name: "Ok", protocol: { type: "openai_chat_completions" } },
          ],
        },
      },
    },
    async () => p.provider.models({ id: "codar", models: {} }, { auth: await auth() }),
  )
  assert.deepEqual(Object.keys(fresh), ["ok"], "only a model that is a model")
  assert.equal(Object.getPrototypeOf(fresh), Object.prototype, "the list's own prototype is untouched")
})

// Three promises of the plugin's own contract that the suite stayed green
// without (mutation-tested in round 9: each change below left 102/102 passing).
test("the promises round 9 found unpinned", async () => {
  const p = await CodarPlugin()
  const until = Math.floor(Date.now() / 1000) + 3600
  const ok = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 2348, agent_token: 4000 } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true, retry_after: 3600 } } },
      "/api/codar/activities/mine": {
        body: { code: 200, data: [{ free_until: until, remaining_quota: 3, user_quota_limit: 10, model_ids: ["auto"] }] },
      },
    },
    async () => p.auth.usage(auth),
  )
  // 1. no window may name models: the host drops the whole card from
  //    quotas.json the moment any window has them (quota_last.go's keepLast,
  //    "a pool that can't be written down isn't kept"), costing the account
  //    its reading across restarts. The model names live in the window's name.
  for (const w of ok.windows) assert.equal(w.models, undefined, `no models on the ${w.name} window`)
  // (notModels too: an agent could then think the models-named window excludes them)
  for (const w of ok.windows) assert.equal(w.notModels, undefined, `no notModels either on ${w.name}`)

  // 2. a token that states no exp is not called expired: that client calls it
  //    "unknown" and lets the vendor answer. Read as expired, a token the
  //    vendor would have accepted is refused locally instead.
  const noExp = mkToken({ username: "user_1" })
  const sent = await withFetch(
    {
      "/v1/daily-sign": { body: { code: 400, message: "24小时内仅可领取一次", data: { retry_after: 3600 } } },
      "/v1/gettoken": { body: { code: 200, token: 1, agent_token: 1 } },
    },
    async (calls) => {
      const r = await p.auth.checkin(async () => ({ type: "api", key: noExp }))
      return { r, calls }
    },
  )
  assert.equal(sent.r.outcome, "done", "a token with no exp reaches the vendor and is read")
  assert.ok(sent.calls.length > 0, "and a request really went out")

  // 3. constructor and prototype, as model *ids*, are dropped like __proto__:
  //    `merged[id] = …` on the model map writes a property every object has.
  const config = { provider: { codar: { models: JSON.parse('{"constructor": {"name": "c"}, "prototype": {"name": "p"}}') } } }
  await p.config(config)
  const models = config.provider.codar.models
  assert.equal(Object.hasOwn(models, "constructor"), false, "a model named constructor is dropped")
  assert.equal(Object.hasOwn(models, "prototype"), false, "a model named prototype is dropped")
  assert.equal(models.constructor, Object, "and the map's own constructor is what it always was")
})

test("the guards round 12 found unpinned", async () => {
  // Each of these was a guard the suite stayed green without (mutation-tested
  // against this same run): dropping the guard changed what magpie draws, so
  // each gets its own sentence.
  const p = await CodarPlugin()
  const sign = async (body) =>
    withFetch(
      {
        "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
        "/v1/daily-sign": { body },
      },
      async () => p.auth.checkin(auth),
    )

  // 1. the "already claimed" words are the day's only when the code can be
  //    the day's either (400, or no code at all). A 500 has the words but is
  //    a server failure: read as `done`, magpie settles the day off an error
  //    and stops asking until tomorrow. Only the 400/no-code half was pinned.
  assert.equal((await sign({ code: 500, message: "24小时内仅可领取一次" })).outcome, "failed", "a 500 quoting the words is a failure, not a claimed day")
  assert.equal((await sign({ code: 503, message: "24小时内仅可领取一次" })).outcome, "failed", "and so is a 503")
  //    the other half: no code at all is the day's own shape, and is `done`
  assert.equal((await sign({ message: "24小时内仅可领取一次", data: { retry_after: 60 } })).outcome, "done", "the same words with no code are the day's")

  // 2. an id the vendor pads with spaces is kept under its trimmed name,
  //    rather than dropped for not being clean (the trim is what makes it
  //    clean: cleanText would fold the pad away and the ids would differ).
  const padded = catalogOf({ data: [{ id: "  spaced  ", display_name: "S" }] })
  assert.equal(padded.length, 1, "a space-padded id is not an uncleanable one")
  assert.equal(padded[0].id, "spaced", "it is kept as its trimmed self")

  // 3. a record that states no protocol is an OpenAI-compatible one: the
  //    vendor's default, and what the desktop app assumes. A record that
  //    named no protocol read as anthropic would send the wrong SDK.
  assert.equal(catalogOf({ data: [{ id: "noproto" }] })[0].protocol, "openai_chat_completions", "no protocol stated is the OpenAI-compatible one")

  // 4. an activity over three models says how many, not just the first two:
//    the vendor's words alone reads as an activity about two models.
  const until = Math.floor(Date.now() / 1000) + 3600
  const many = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true } } },
      "/api/codar/activities/mine": { body: { code: 200, data: [{ free_until: until, model_ids: ["a", "b", "c", "d"] }] } },
    },
    async () => p.auth.usage(auth),
  )
  const free = many.windows.find((w) => w.name.startsWith("免费模型"))
  assert.match(free.name, /等 4 个/, "an activity over four models says so")
})

test("a model id that is nothing but a control character does not leave a separator on the card", async () => {
  // The filter kept any non-empty string and cleanText then folded "\n" away,
  // so a name of ["\n","auto"] was joined as "、auto" — a name that reads as an activity
  // over an unnamed model. Cleaning first and dropping what is left empty is
  // the same order catalogOf uses for a record's id.
  const until = Math.floor(Date.now() / 1000) + 3600
  const p = await CodarPlugin()
  const nameFor = async (model_ids) => {
    const u = await withFetch(
      {
        "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
        "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: false, retry_after: 60 } } },
        "/api/codar/activities/mine": { body: { code: 200, data: [{ free_until: until, remaining_quota: null, model_ids }] } },
      },
      async () => p.auth.usage(auth),
    )
    const w = u.windows.find((x) => x.name.startsWith("免费模型"))
    assert.ok(w, "the activity is still on the card")
    return w.name
  }

  assert.equal(await nameFor(["\n", "auto"]), "免费模型 · auto", "the empty one is dropped, not left as a separator")
  assert.equal(await nameFor(["\n", "\t", "  "]), "免费模型", "an activity whose every id cleans to nothing is named without them")
  assert.equal(await nameFor(["a", "\n", "b", "c"]), "免费模型 · a、b 等 3 个", "the count is of the ids that are left")
  assert.equal(await nameFor(["a", 7, null, "b"]), "免费模型 · a、b", "a non-string id is dropped as before")
})

// The config path builds its model list from catalog.mjs, which cannot carry
// a magic id today — but the guard there exists for the day catalog.mjs is
// regenerated from the vendor and can. CATALOG is an import binding a test
// cannot swap, so this loads a copy of the plugin whose catalog.mjs holds a
// `__proto__` record and checks the guard against that copy.
// Under Bun the first `import()` of a file from a fresh temp directory costs
// ~1.8s, once per process — a second copy at another path loads in ~2ms —
// and this is the test that pays it. Bun's default per-test timeout is 5s,
// and a loaded machine crossed it (1 fail in ~26 full runs). Node's runner
// has no such default. The test does no waiting of its own, so the budget is
// stated here rather than left to the runner.
test("a regeneration that put a __proto__ id in the catalog does not become the map's prototype", { timeout: 30000 }, async () => {
  const { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { fileURLToPath, pathToFileURL } = await import("node:url")
  // fileURLToPath, not `.pathname`: pathname keeps the percent-encoding a
  // repo in a folder with a space ("my project") puts in the URL, and gives a
  // leading slash in front of a Windows drive letter — both made the copied
  // plugin unloadable, so the suite went red on a developer machine whose
  // checkout path has a space in it (CI's has none).
  const here = fileURLToPath(new URL("..", import.meta.url))
  const root = mkdtempSync(join(tmpdir(), "codar-cat-"))
  try {
    cpSync(join(here, "lib"), join(root, "lib"), { recursive: true })
    for (const f of ["index.mjs", "package.json"]) cpSync(join(here, f), join(root, f))
    const cat = readFileSync(join(root, "lib", "catalog.mjs"), "utf8")
    writeFileSync(join(root, "lib", "catalog.mjs"), cat.replace(/export const CATALOG = \[/, 'export const CATALOG = [\n  { "id": "__proto__", "name": "E", "context": 1, "maxOutput": 1, "input": ["text"], "output": ["text"], "protocol": "openai_chat_completions", "reasoning": false },') )
    const { CodarPlugin: Other } = await import(pathToFileURL(join(root, "index.mjs")).href)
    const p = await Other()
    const config = {}
    await p.config(config)
    const models = config.provider.codar.models
    assert.equal(Object.hasOwn(models, "__proto__"), false, "the id is not an own key of the map handed on")
    assert.equal(Object.getPrototypeOf(models), Object.prototype, "and the map's prototype is the map's own")
    assert.equal(models.name, undefined, "no planted field answers for the map")
    assert.ok(models["auto"], "the rest of the catalog is still there")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// The embedded catalog is the list served when the vendor cannot be reached,
// and nothing at runtime can tell it has gone stale — a model's context or
// reply ceiling moving is a silent wrong number on the card. `scripts/
// catalog.mjs` regenerates it; this pins the shape an offline run can check,
// so a hand-edit or a bad regeneration is caught without a network.
test("the embedded catalog is a well-formed model list", async () => {
  const { CATALOG } = await import("../lib/catalog.mjs")
  assert.ok(Array.isArray(CATALOG) && CATALOG.length > 0, "it is a non-empty list")
  const ids = new Set()
  const kinds = ["text", "image", "audio", "video", "pdf"]
  const whole = (v) => Number.isInteger(v) && v >= 0
  for (const m of CATALOG) {
    assert.ok(m && typeof m === "object" && !Array.isArray(m), `a record is a plain object: ${JSON.stringify(m)}`)
    assert.equal(typeof m.id, "string", "with a string id")
    assert.ok(m.id.trim() && !/[\u0000-\u001f\u007f]/.test(m.id), `whose id is usable as asked: ${JSON.stringify(m.id)}`)
    assert.equal(ids.has(m.id), false, `and unique: ${m.id}`)
    ids.add(m.id)
    assert.equal(typeof m.name, "string", `${m.id} names itself`)
    // the name is a card's line, and cleanText is what makes one: a record
    // whose name still held a control character (a bidi override reverses
    // what follows it; a zero-width space rides along invisibly) would reach
    // the card as written. The plugin's own cleanText is the rule — the shape
    // check applies it rather than assuming the generator did.
    assert.equal(m.name, cleanText(m.name), `${m.id}'s name is already a cleaned line`)
    assert.ok(m.name.length > 0, `${m.id}'s name is not empty`)
    assert.ok(whole(m.context) && m.context > 0, `${m.id} has a positive whole context`)
    assert.ok(whole(m.maxOutput), `${m.id}'s reply ceiling is a whole number (0 is "not stated")`)
    for (const field of ["input", "output"]) {
      assert.ok(Array.isArray(m[field]) && m[field].length > 0, `${m.id}.${field} is a non-empty list`)
      for (const k of m[field]) assert.ok(kinds.includes(k), `${m.id}.${field} names a kind magpie knows: ${k}`)
    }
    assert.ok(["text", "image"].includes(m.input[0]), `${m.id} takes text first`)
    assert.ok(["openai_chat_completions", "anthropic_messages"].includes(m.protocol), `${m.id} names a protocol the plugin serves`)
    assert.equal(typeof m.reasoning, "boolean", `${m.id} says whether it reasons`)
  }
  // and it reads as the models hook's own answer would: a model record, built
  // into magpie's list shape, carries its context and ceiling through
  const built = modelOf(CATALOG[0])
  assert.equal(built.limit.context, CATALOG[0].context, "the record's context reaches limit.context")
  assert.equal(built.limit.output, CATALOG[0].maxOutput, "and its ceiling reaches limit.output")
})

// scripts/catalog.mjs writes the fallback the plugin ships, and it used to be
// a second copy of the rules the live path applies — which drifted the day it
// was written (a size the vendor spells as a string, a name with a control
// character, an id no request could ask for). It now builds its records with
// the plugin's own catalogOf; these drive its main() with a stubbed fetch and
// its outside world injected, so the tool that writes the file is itself
// pinned, offline.
const { recordsOf, render, parseCatalog, main, sortRows, configPathOf } = await import("../scripts/catalog.mjs")
const { quoteArg } = await import("../scripts/tarball.mjs")

// genRun drives the generator against a stub vendor and a scratch directory.
const genRun = async ({ body, argv = [], seeded, out = "catalog.mjs", throwOnFetch, onReady, onDone, token } = {}) => {
  const { mkdtempSync } = await import("node:fs")
  const { readFileSync, writeFileSync } = await import("node:fs")
  const root = mkdtempSync(join(tmpdir(), "codar-gen-"))
  const outPath = join(root, out)
  const key = token ?? mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
  writeFileSync(join(root, "config.json"), JSON.stringify({ provider: { speedai: { token: key } } }))
  if (seeded) writeFileSync(outPath, seeded)
  // onReady runs once the directory is set up and before the generator does:
  // a test that needs to occupy the path the generator writes to (or make the
  // directory refuse a new file) has no other moment to do it. onDone runs
  // after the generator, before the scratch directory is removed — the place
  // to put back a permission onReady took away.
  if (onReady) onReady(outPath)
  const logs = []
  const exit = await main({
    argv: ["node", "scripts/catalog.mjs", ...argv],
    env: { CODAR_HOME: root },
    out: outPath,
    fetchImpl: async () => {
      if (throwOnFetch) throw throwOnFetch instanceof Error ? throwOnFetch : new TypeError("fetch failed")
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
    },
    log: { log: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) },
  })
  const after = (() => {
    try {
      return readFileSync(outPath, "utf8")
    } catch {
      return null
    }
  })()
  const siblings = readdirSync(root)
  if (onDone) onDone(outPath)
  rmSync(root, { recursive: true, force: true })
  return { exit, logs, after, outPath, siblings }
}

test("the catalog generator builds its records with the plugin's own rules", async () => {
  // The vendor spells a size as a string, plants an id a request could not
  // ask for, wraps a name in a control character and a bidi override, repeats
  // an id, and names one __proto__. Everything except the list itself is the
  // live path's business: this asserts the generator's records are the ones
  // catalogOf would have made, not a looser read of the same body.
  const body = {
    code: 200,
    data: [
      { id: "strsizes", display_name: "Strings", context_window: "1000000", request_schema: { properties: { max_tokens: { maximum: "131072" } } } },
      { id: "ctrl", display_name: "Na‮me​", context_window: 1000 },
      { id: "bad\u0001id", display_name: "Bad", context_window: 1000 },
      { id: "dup", display_name: "First", context_window: 1000 },
      { id: "dup", display_name: "Second", context_window: 2000 },
      { id: "__proto__", display_name: "Proto", context_window: 1000 },
      null,
      "str",
      [1, 2],
      { display_name: "no id" },
    ],
  }
  const rows = await recordsOf(body)
  const byId = new Map(rows.map((r) => [r.id, r]))
  assert.deepEqual([...byId.keys()].sort(), ["ctrl", "dup", "strsizes"], "an uncleanable id, a magic id and a non-record are left out")
  assert.equal(byId.get("strsizes").context, 1000000, "a size the vendor spells as a string is a size")
  assert.equal(byId.get("strsizes").maxOutput, 131072, "and so is its reply ceiling")
  assert.equal(byId.get("dup").name, "Second", "a repeated id keeps the later record, as the run's map does")
  assert.equal(byId.get("ctrl").name, cleanText("Na‮me​"), "a name is a cleaned line")
  assert.equal(await recordsOf({ code: 200, data: "nope" }), null, "an answer naming no list is no rows, not an empty list")
})

test("the generator writes what it would serve, and says so", async () => {
  const body = { code: 200, data: [{ id: "only", display_name: "Na\u0007me", context_window: 1000, request_schema: { properties: { max_tokens: { maximum: 10 } } } }] }
  const { exit, logs, after } = await genRun({ body })
  assert.equal(exit, 0)
  assert.ok(logs.some((l) => l.includes("wrote 1 models")))
  const written = parseCatalog(after)
  assert.deepEqual(written, [...(await recordsOf(body))].map(({ rate, ...rest }) => rest),
    "the file holds exactly the records the live path would serve, but a model with no rate is written without one")
  assert.equal(written[0].name, cleanText("Na\u0007me"), "with the name cleaned, as the card will show it")
  // The file is read by people as much as by the plugin: its header says what
  // it is and how to regenerate it. --check compares records, so a run that
  // dropped the header would otherwise leave the committed file unreadable
  // prose-less on its next regeneration.
  assert.ok(after.startsWith("// catalog is Codar's model list"), "the file's own header is written")
  assert.match(after, /export const CATALOG = \[/)
})

test("the committed catalog is exactly what the generator would write for it", async () => {
  // The generator's header is kept verbatim so a regeneration of a current
  // file produces no diff at all. That only holds while the committed file's
  // header and the generator's copy are the same text: they drifted once (the
  // header was rewrapped by hand), and the next regeneration would have
  // rewritten the comment over an unchanged list.
  const { readFileSync } = await import("node:fs")
  const text = readFileSync(new URL("../lib/catalog.mjs", import.meta.url), "utf8")
  assert.equal(render(sortRows(parseCatalog(text))), text, "regenerating the committed catalog would change it")
})

test("the generator writes records in id order, whatever order the vendor used", async () => {
  // A vendor that reorders its list is not a change: the committed file is
  // sorted by id so the diff stays about models. The record set is the same,
  // only the order differs.
  const body = {
    code: 200,
    data: [
      { id: "zeta", display_name: "Z", context_window: 1 },
      { id: "alpha", display_name: "A", context_window: 1 },
      { id: "mike", display_name: "M", context_window: 1 },
    ],
  }
  const { exit, after } = await genRun({ body })
  assert.equal(exit, 0)
  assert.deepEqual(parseCatalog(after).map((r) => r.id), ["alpha", "mike", "zeta"], "the file is written in id order")
})

test("a generator run that cannot read the vendor writes nothing and does not say 'out of date'", async () => {
  const seeded = render(sortRows(await recordsOf({ code: 200, data: [{ id: "sentinel", display_name: "s", context_window: 1 }] })))
  for (const [label, opts] of [
    ["network failure", { body: undefined, throwOnFetch: true }],
    ["an HTML body", { body: "<html>maintenance</html>" }],
    ["an answer with no list", { body: { code: 200, message: "nope" } }],
    ["an empty list", { body: { code: 200, data: [] } }],
  ]) {
    const { exit, logs, after } = await genRun({ ...opts, seeded })
    assert.equal(exit, 2, `${label}: a failed read is exit 2, never the 1 that means "regenerate"`)
    assert.equal(after, seeded, `${label}: the committed fallback is left alone`)
    assert.equal(logs.some((l) => l.includes("catalog.mjs is out of date")), false, `${label}: and is not reported as stale`)
  }
})

test("an answer that states no context window is not written into the fallback", async () => {
  // Every model the vendor lists today states context_window. A record
  // without one means the field moved (renamed, or answered as null), and
  // writing it would put a model with no window at all into the committed
  // fallback — magpie would lower or refuse requests by a size the vendor
  // never gave — where the older file still carries the last real figure.
  // The run is "ask again" (2), not "out of date" (1), and it writes nothing.
  const windowless = { id: "windowless", display_name: "W", request_schema: { properties: { max_tokens: { maximum: 10 } } } }
  const seeded = render(sortRows(await recordsOf({ code: 200, data: [{ id: "kept", display_name: "K", context_window: 1 }] })))
  const { exit, logs, after } = await genRun({ body: { code: 200, data: [windowless] }, seeded })
  assert.equal(exit, 2, "a record with no window is a read failure, not a catalog")
  assert.equal(after, seeded, "the committed fallback is left as it was")
  assert.match(logs.join(" "), /context_window/, "and the message names the field")
  assert.match(logs.join(" "), /windowless/, "and the record")
  const checked = await genRun({ body: { code: 200, data: [windowless] }, seeded, argv: ["--check"] })
  assert.equal(checked.exit, 2, "--check does not call the file stale over an answer it cannot use")
})

test("the generator's --check compares values, not the bytes of the file", async () => {
  const body = { code: 200, data: [{ id: "m", display_name: "M", context_window: 1000, request_schema: { properties: { max_tokens: { maximum: 10 } } } }] }
  const seeded = render(await recordsOf(body))
  // same records, keys written in another order: prose, not drift
  const reordered = seeded.replace('"context": 1000,\n    "maxOutput": 10', '"maxOutput": 10,\n    "context": 1000')
  assert.notEqual(reordered, seeded, "the fixture really did reorder a record")
  assert.equal((await genRun({ body, argv: ["--check"], seeded: reordered })).exit, 0, "a reordered record is not a change")

  const drifted = seeded.replace('"context": 1000', '"context": 999')
  const moved = await genRun({ body, argv: ["--check"], seeded: drifted })
  assert.equal(moved.exit, 1, "a size that really moved is the 1 that means 'regenerate'")
  assert.ok(moved.logs.some((l) => l.startsWith("changed: m")), "and says which record moved")
})

test("a --check that cannot read the catalog file is exit 2, not 'out of date'", async () => {
  const body = { code: 200, data: [{ id: "m", context_window: 1000 }] }
  const missing = await genRun({ body, argv: ["--check"], seeded: undefined, out: "catalog.mjs" })
  // seeded: undefined means the file was never written at all
  assert.equal(missing.exit, 2, "a file we cannot read is a failure to read, not drift")
  const truncated = await genRun({ body, argv: ["--check"], seeded: "export const CATALOG = [ this is not json" })
  assert.equal(truncated.exit, 2, "and so is a file that does not parse")
  assert.equal(truncated.logs.some((l) => l.includes("catalog.mjs is out of date")), false)
  const noExport = await genRun({ body, argv: ["--check"], seeded: "// a file we did not write\n" })
  assert.equal(noExport.exit, 2, "and so is a file with no CATALOG export in it")
  const notAList = await genRun({ body, argv: ["--check"], seeded: "export const CATALOG = { \"id\": 1 }\n" })
  assert.equal(notAList.exit, 2, "and so is one whose export is not a list")
  assert.ok(notAList.logs.some((l) => l.includes("not a list")), "said as what it is, not as a crash")
})

test("a generator that cannot write the file says so, as exit 2", async () => {
  const { mkdtempSync } = await import("node:fs")
  const root = mkdtempSync(join(tmpdir(), "codar-gen-"))
  writeFileSync(join(root, "config.json"), JSON.stringify({ provider: { speedai: { token: mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 }) } } }))
  const logs = []
  try {
    const exit = await main({
      argv: ["node", "scripts/catalog.mjs"],
      env: { CODAR_HOME: root },
      // a directory that is not there: the write fails, and the run says so
      out: join(root, "missing-dir", "catalog.mjs"),
      fetchImpl: async () => new Response(JSON.stringify({ code: 200, data: [{ id: "m", context_window: 1 }] }), { status: 200 }),
      log: { log: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) },
    })
    assert.equal(exit, 2, "a failed write is exit 2")
    assert.ok(logs.some((l) => l.includes("cannot write")), "and names the file it could not write")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// a child process: ~1s here, and slower on a loaded Windows runner, where
// Bun's 5s default would flake for the same reason as the test above
test("a generator run whose plugin rules cannot be loaded is exit 2, not 'out of date'", { timeout: 30000 }, async () => {
  // The generator builds its records with the plugin's own catalogOf. If
  // lib/internal.mjs or lib/catalog.mjs is not beside the script (a broken checkout, a
  // partial copy), that import fails — and a module-loader stack with exit 1
  // would read as "the catalog is stale, regenerate it".
  const { mkdtempSync } = await import("node:fs")
  const root = mkdtempSync(join(tmpdir(), "codar-gen-"))
  writeFileSync(join(root, "config.json"), JSON.stringify({ provider: { speedai: { token: "t" } } }))
  // a fresh copy of the generator with no lib/ beside it: the import of the
  // plugin's rules is what fails, in a process that has not cached it
  const { cpSync } = await import("node:fs")
  const { fileURLToPath } = await import("node:url")
  const root2 = mkdtempSync(join(tmpdir(), "codar-gen-copy-"))
  try {
    const here2 = fileURLToPath(new URL("..", import.meta.url))
    cpSync(join(here2, "scripts"), join(root2, "scripts"), { recursive: true })
    const { spawnSync } = await import("node:child_process")
    const run = spawnSync(process.execPath, [join(root2, "scripts", "catalog.mjs"), "--check"], {
      env: { ...process.env, CODAR_HOME: root },
      encoding: "utf8",
    })
    assert.equal(run.status, 2, "a run that cannot load the plugin's rules exits 2")
    assert.match(run.stderr + run.stdout, /cannot read the plugin's catalog rules/, "and says so in words, not a loader stack")
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(root2, { recursive: true, force: true })
  }
})

test("the generator never sends, or prints, a token it cannot put in a header", async () => {
  // A token with a newline, a CR or a NUL inside it is refused by fetch with
  // the whole header — the token — quoted in its error, which the generator
  // used to print. It now applies the sign-in's own gate (tokenOf) first.
  const { mkdtempSync } = await import("node:fs")
  const secret = "eyJhbGciOiJIUzI1NiJ9.FAKE"
  for (const bad of [`${secret}\nSECRET.sig`, `${secret}\rSECRET.sig`, `${secret}\u0000SECRET.sig`, `${secret}中SECRET.sig`]) {
    const root = mkdtempSync(join(tmpdir(), "codar-gen-"))
    writeFileSync(join(root, "config.json"), JSON.stringify({ provider: { speedai: { token: bad } } }))
    const logs = []
    let sent = 0
    try {
      const exit = await main({
        argv: ["node", "scripts/catalog.mjs", "--check"],
        env: { CODAR_HOME: root },
        out: join(root, "catalog.mjs"),
        // the real fetch's behaviour: it refuses the header by quoting it
        fetchImpl: async (_u, init) => {
          sent++
          throw new TypeError(`Headers.append: "${init.headers.Authorization}" is an invalid header value.`)
        },
        log: { log: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) },
      })
      assert.equal(exit, 2, "an unsendable token is a read failure")
      assert.equal(sent, 0, "and is never handed to fetch")
      assert.equal(logs.some((l) => l.includes("SECRET") || l.includes(secret)), false, `no part of the token is printed: ${JSON.stringify(logs)}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test("a generator fetch error that names the token has the token cut", async () => {
  const { mkdtempSync } = await import("node:fs")
  const token = mkToken({ username: "u", exp: Math.floor(Date.now() / 1000) + 3600 })
  const root = mkdtempSync(join(tmpdir(), "codar-gen-"))
  writeFileSync(join(root, "config.json"), JSON.stringify({ provider: { speedai: { token } } }))
  const logs = []
  try {
    const exit = await main({
      argv: ["node", "scripts/catalog.mjs", "--check"],
      env: { CODAR_HOME: root },
      out: join(root, "catalog.mjs"),
      fetchImpl: async (_u, init) => {
        throw new TypeError(`refused ${init.headers.Authorization}`)
      },
      log: { log: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) },
    })
    assert.equal(exit, 2)
    assert.equal(logs.some((l) => l.includes(token)), false, "the token never reaches the output")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a generator run with no readable token says what to do, as exit 2", async () => {
  const { mkdtempSync, readFileSync } = await import("node:fs")
  const root = mkdtempSync(join(tmpdir(), "codar-gen-"))
  const logs = []
  const run = (env) =>
    main({ argv: ["node", "scripts/catalog.mjs"], env, out: join(root, "catalog.mjs"), fetchImpl: async () => new Response("{}", { status: 200 }), log: { log: (m) => logs.push(m), error: (m) => logs.push(m) } })
  try {
    assert.equal(await run({ CODAR_HOME: join(root, "absent") }), 2, "no config file")
    assert.ok(logs.some((l) => l.includes("sign in once on this machine first")))
    writeFileSync(join(root, "config.json"), "{not json")
    assert.equal(await run({ CODAR_HOME: root }), 2, "a config that is not JSON")
    writeFileSync(join(root, "config.json"), JSON.stringify({ provider: { speedai: { token: "" } } }))
    assert.equal(await run({ CODAR_HOME: root }), 2, "a config with no token")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Round 19: the four gaps a full review found in code that was green.
test("a wording the plugin has never seen is still the day already claimed", async () => {
  // "already claimed" used to be one Chinese sentence, tested against the card's
  // copy — already cut at 400 characters. Both halves of that were holes:
  // a vendor answering in English ("You can only claim once every 24 hours")
  // read as a plain refusal, and magpie then retried the claim every 30
  // minutes while the card said it failed. The answer's own retry_after is
  // the other statement of the same fact: a 400 that still knows when the
  // next claim opens is a day already claimed, whatever it says in words.
  const p = await CodarPlugin()
  const read = (body) =>
    withFetch(
      {
        "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
        "/v1/daily-sign": { body },
      },
      async () => p.auth.checkin(auth),
    )
  for (const [label, body] of [
    ["English words", { code: 400, message: "You can only claim once every 24 hours" }],
    ["a plain 400 with a wait", { code: 400, data: { retry_after: 3600 } }],
    ["the sentence buried past the card's cut", { code: 400, message: "x".repeat(600) + "24小时内仅可领取一次", data: { retry_after: 60 } }],
    // …and with no wait to fall back on, so it is the un-truncated words that
    // have to say it: the card's copy is cut at 400 characters, and this
    // sentence sits at 601.
    ["buried, with no wait either", { code: 400, message: "x".repeat(600) + "24小时内仅可领取一次" }],
  ]) {
    const r = await read(body)
    assert.equal(r.outcome, "done", `${label}: this day is claimed, not a failure`)
    assert.ok(r.until > Date.now(), `${label}: and it says when the window opens again`)
  }
  // the other side: a 200 that says the day is already claimed is not a new
  // claim. It was read as one — a claimed outcome over a day that had already
  // been settled, with a credit of 0.
  const twice = await read({ code: 200, data: { message: "24小时内仅可领取一次", retry_after: 3600 } })
  assert.equal(twice.outcome, "done", "a success code beside the already-claimed words is that day, not a second claim")
  assert.equal(twice.message, "今天已领过，1 小时后可再领")
})

test("an activity's numbers are read the way every other vendor number is", async () => {
  // free_until and remaining_quota were the two fields read with `typeof ===
  // "number"` while every other number in the plugin goes through numOf. A
  // vendor spelling either as a string made the activity vanish from the card
  // without a word — the hardest kind of fault to see.
  const now = Math.floor(Date.now() / 1000)
  const p = await CodarPlugin()
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true, retry_after: 60 } } },
      "/api/codar/activities/mine": {
        body: {
          code: 200,
          data: [
            { free_until: String(now + 3600), remaining_quota: "3", user_quota_limit: "10", model_ids: ["a"] },
            { free_until: String(now + 3600), remaining_quota: "0", user_quota_limit: "10", model_ids: ["b"] },
            { free_until: "later", remaining_quota: null, model_ids: ["c"] },
          ],
        },
      },
    },
    async () => p.auth.usage(auth),
  )
  const free = u.windows.filter((w) => w.name.startsWith("免费模型"))
  assert.equal(free.length, 1, "a string-wrapped time is a time; a spent string quota still ends the activity; a word is not a time")
  assert.equal(free[0].amount, 7, "and the share is the two numbers the strings spelled")
  assert.equal(free[0].limit, 10)
  assert.equal(free[0].display, "免费使用中，已用 7 / 10")
})

test("a name cut to fit the card never ends mid-character", () => {
  // 120 UTF-16 units can end between the halves of a surrogate pair, and the
  // lone high surrogate that leaves behind is a character nobody wrote:
  // JSON carries it as \ud83d and the host's decoder draws U+FFFD. The cut is
  // by code point, so each emoji is one of the 120 and none is halved.
  const emoji = "😀".repeat(130) // 130 code points, 260 UTF-16 units
  const cleaned = cleanText(emoji)
  assert.equal(Array.from(cleaned).length, 120, "120 characters, not 120 code units")
  assert.equal(cleaned, "😀".repeat(120), "and every one of them whole")
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cleaned), false, "no lone high surrogate is left behind")
  // a name already inside the limit is untouched
  assert.equal(cleanText("😀".repeat(70)), "😀".repeat(70), "70 whole pairs stay as they are")
})

test("a self-written model entry gets the id its key names", async () => {
  // The host builds every model row from m.id; a hand-written entry that
  // names only `name` used to reach it with an id of undefined.
  const p = await CodarPlugin()
  const config = { provider: { codar: { models: { "my-model": { name: "自建", provider: { api: "https://my.example/v1" } } } } } }
  await p.config(config)
  const mine = config.provider.codar.models["my-model"]
  assert.equal(mine.id, "my-model", "the key is the id the host reads")
  assert.equal(mine.name, "自建", "and the user's own fields are kept beside it")
  assert.equal(mine.provider.api, "https://my.example/v1")
  // an entry that names its own id keeps it: the key is only the fallback
  const named = { provider: { codar: { models: { "k": { id: "other", name: "Other" } } } } }
  await p.config(named)
  assert.equal(named.provider.codar.models.k.id, "other", "an id the user wrote is never overwritten by the key")
})

test("the generator cuts a wrapped or payload-only token out of what it says", async () => {
  // The generator's failure path used to split on the exact token string; a
  // server that wrapped the credential or quoted back only its payload would
  // have had it printed into a CI log. It now cuts by the JWT's shape, the
  // same rule the plugin's own messages use.
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
  const jwt = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
  const folded = jwt.match(/.{1,24}/g).join("\n")
  for (const [label, said] of [
    ["the token folded", `bad key ${folded}`],
    ["only its payload", `bad key ${jwt.split(".")[1]}`],
  ]) {
    const { exit, logs } = await genRun({ body: undefined, throwOnFetch: new Error(said), token: jwt })
    assert.equal(exit, 2, `${label}: a failed fetch is still exit 2`)
    const said2 = logs.join("\n")
    assert.doesNotMatch(said2, /eyJ[\w-]{10,}/, `${label}: no credential reaches the log`)
    assert.match(said2, /…/, `${label}: and the place it was is marked`)
  }
})

test("a token in a record's object key is cut before it is written", async () => {
  // withoutToken scrubbed every value but not the keys of an object: a
  // credential the gateway echoed as an object key inside a record (say, in
  // the input_modalities array) was written whole into the committed file.
  const token = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
  const { exit, after, logs } = await genRun({
    token,
    body: {
      code: 200,
      data: [
        { id: "model-safe", display_name: "Safe", context_window: 1000, input_modalities: [{ [token]: "text" }], output_modalities: ["text"], request_schema: { properties: { max_tokens: { maximum: 10 } } } },
        { id: "auto", display_name: "Auto", context_window: 128000 },
      ],
    },
  })
  assert.equal(exit, 0, "the answer still writes")
  assert.equal(String(after).includes(token), false, "the token echoed as an object key is not written")
  assert.equal(logs.join("\n").includes(token), false, "nor printed")
  assert.match(String(after), /"input": \[\s*"text"\s*\]/, "a modality the host does not know is dropped, not carried")

  // …and a token folded into a field the record keeps is cut, not dropped
  const foldedName = [...token].join("\u180e")
  const named = await genRun({
    token,
    body: { code: 200, data: [{ id: "model-named", display_name: `early access ${foldedName}`, context_window: 1000, output_modalities: ["text"] }] },
  })
  assert.equal(named.exit, 0)
  assert.equal(String(named.after).includes(token), false, "a token folded at U+180E is not written")
  assert.match(String(named.after), /early access …/, "and the place it was is marked")

  // and a branch nested past the walk's own depth is cut whole, not handed on
  // raw: the old cap returned the subtree untouched, which is another way the
  // token reached the file.
  let deep = { text: token }
  for (let i = 0; i < 80; i++) deep = { nest: deep }
  const far = await genRun({
    token,
    body: { code: 200, data: [{ id: "model-deep", display_name: "Deep", context_window: 1000, input_modalities: [deep], output_modalities: ["text"] }] },
  })
  assert.equal(far.exit, 0)
  assert.equal(String(far.after).includes(token), false, "a token past the depth cap is not written either")
})

test("the generator cuts a token the vendor wrapped inside a catalog field", async () => {
  // The fields of a vendor answer are written into a committed file, so an
  // echo of the account's own token there would land in the repository. The
  // generator cut only the contiguous copy: a gateway that wraps the token
  // every 20 characters left no such copy, and the rest of the key was
  // written out. It now cuts the plugin's way (cutKey), which follows the key
  // through whitespace and control characters folded between its characters.
  const token = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
  for (const [label, wrap] of [
    ["at a space every 20 characters", (t) => t.match(/.{1,20}/g).join(" ")],
    ["at a newline every 16", (t) => t.match(/.{1,16}/g).join("\n")],
  ]) {
    const echoed = wrap(token)
    const { exit, after, logs } = await genRun({
      token,
      body: {
        code: 200,
        data: [
          { id: "gpt-6.1-sol", display_name: `early access ${echoed}`, context_window: 128000, request_schema: { properties: { max_tokens: { maximum: 8192 } } } },
          { id: "auto", display_name: "Auto", context_window: 128000 },
        ],
      },
    })
    assert.equal(exit, 0, `${label}: the answer is still written`)
    for (const piece of echoed.split(/[\s\n]+/).filter((p) => p.length >= 8)) {
      assert.equal(String(after).includes(piece), false, `${label}: no piece of the wrapped token is written (${piece})`)
      assert.equal(logs.join("\n").includes(piece), false, `${label}: nor printed`)
    }
    assert.match(String(after), /early access …/, `${label}: the place it was is marked`)
  }
})

test("a failure word covers an English negation of any width", async () => {
  // "not successful" was the only negation the veto knew; the same sentence
  // written as "this is not a success", "no confirmation yet" or "sign-in did not
  // succeed" carried a success word and no veto, and settled the day as
  // claimed at zero points.
  const p = await CodarPlugin()
  const read = (body) =>
    withFetch(
      {
        "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
        "/v1/daily-sign": { body },
      },
      async () => p.auth.checkin(auth),
    )
  for (const message of [
    "This is not a success",
    "this check-in is not a success",
    "No confirmation of success yet, please retry",
    "the sign-in did not succeed",
    "sign-in has never been successful",
    "check-in wasn't successful",
    "we cannot confirm success right now",
    "not successful",
    "did not succeed",
    // a typographic apostrophe, and the bare verb with its own endings: the
    // veto listed "did not succeed" and "succe(ss|ssful|eded)" only, so a
    // card that said these settled the day at zero points
    "Check-in didn’t succeed",
    "wasn’t successful",
    "can’t confirm success",
    "the sign-in didn't succeed",
    // the negation written after the success word, which the veto only knew
    // in front of it: "success not confirmed" carried a success word and no
    // veto, and settled the day at zero points
    "check-in success not confirmed",
    "success was not achieved",
    "success hasn’t been confirmed",
    "sign-in success could not be verified",
    "签到成功未确认",
    "签到成功尚未到账",
  ]) {
    const r = await read({ message })
    assert.equal(r.outcome, "failed", `${message} is not a claim`)
  }
  // a success said on its own is still one, and the line stops at the
  // sentence's end: a note after a full stop is not a veto on success
  for (const message of [
    "领取成功",
    "Sign-in successful",
    "Check-in successful. No points were added",
    "Check-in succeeded",
    "check-in succeeds",
    // an aside after a comma is a note about the claim, not a veto on it
    "Check-in successful, no points were added",
    "领取成功，未使用的积分明天清零",
  ]) {
    const r = await read({ message })
    assert.equal(r.outcome, "claimed", `${message} is a claim`)
  }
})

test("the readings no test used to pin, spelled out one by one", () => {
  // Each of these is a branch the suite stayed green without: deleting it
  // changed what a card says, and nothing went red.
  //
  // saidBy reads eight spellings; five were covered. The three below are the
  // ones a vendor actually uses for a refusal.
  assert.equal(saidBy({ error: "boom" }), "boom", "a refusal spelled `error`")
  assert.equal(saidBy({ data: { error: "boom" } }), "boom", "and one under data")
  assert.equal(saidBy({ data: { detail: "why" } }), "why", "and `detail` under data")
  // the order is the client's (app.asar's vo): a top-level field wins over the
  // same name under data, whatever order the object was written in
  assert.equal(saidBy({ data: { message: "inner" }, msg: "outer" }), "outer", "a top-level msg beats data.message")
  assert.equal(saidBy({ detail: "d", message: "m" }), "m", "and message comes before detail")
  assert.equal(saidBy({ message: "   ", msg: "real" }), "real", "a blank string is not words")
  assert.equal(saidBy("nope"), "", "and a body that is not an object says nothing")

  // secsOf directly: every call site guards the zero, so its own reading of
  // "not stated" was never asked.
  assert.equal(secsOf(0), 0, "a zero is not a wait")
  assert.equal(secsOf(-1), 0, "nor is a negative")
  assert.equal(secsOf(true), 0, "nor is a boolean: Number(true) is 1 second nobody stated")
  assert.equal(secsOf([3600]), 0, "nor is a one-element array")
  assert.equal(secsOf(""), 0, "nor is a blank string")
  assert.equal(secsOf("3600"), 3600, "a number spelled as a string is one")
  assert.equal(secsOf(3600), 3600)
  // the check-in's week ceiling, at the instant it bites
  assert.equal(checkinWaitSecs(7 * 24 * 3600), 7 * 24 * 3600, "exactly a week is a wait this window can name")
  assert.equal(checkinWaitSecs(7 * 24 * 3600 + 1), 0, "one second past it is not")

  // humanSecs' own ceiling: the last second both ends accept is said, the
  // next one is not.
  assert.match(humanSecs(253402300799), /天/, "the last instant a card can hold is said as a wait")
  assert.equal(humanSecs(253402300800), "", "one second past the calendar is said as nothing, not as year 10000")

  // cleanText's control-character classes: only four of them had a test, so
  // half the regex could have been deleted in silence. C1, the soft hyphen,
  // the line and paragraph separators, the bidi isolates and the BOM alike
  // are one space on a card.
  for (const [label, ch] of [
    ["a C1 control", "\u0085"],
    ["a soft hyphen", "­"],
    ["a line separator", " "],
    ["a bidi isolate", "⁦"],
    ["a byte-order mark", "﻿"],
    ["an interlinear annotation", "￹"],
  ]) {
    assert.equal(cleanText(`a${ch}b`), "a b", `${label} is a space on a card, not a character`)
  }
})

test("a 200 with nothing in it is a failure with a reason, not a crash", async () => {
  // text() empty is its own branch: JSON.parse("") would throw, so the plugin
  // decides on the empty string first. A card that says nothing at all over a
  // blank 200 would be worse than a sentence.
  const p = await CodarPlugin()
  const blank = () => new Promise((ok) => ok(new Response("", { status: 200 })))
  const real = globalThis.fetch
  globalThis.fetch = async (url) => (String(url).includes("/v1/gettoken") ? blank() : blank())
  try {
    const u = await p.auth.usage(auth)
    assert.match(u.error, /不是 JSON|失败/, "a blank answer is said as what it is")
    assert.ok(u.error, "and not as an empty card")
  } finally {
    globalThis.fetch = real
  }
})

test("a status or activity read that never answers does not sink the card", async () => {
  // Both are extra information: the points read is the card. Their promises
  // are read through allSettled, so a rejection (a timeout, a dropped socket)
  // is dropped while the card still comes out of the points. Only the
  // answered-with-500 shape was pinned; the rejected one was read from code.
  const p = await CodarPlugin()
  const real = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes("/v1/gettoken")) return new Response(JSON.stringify({ code: 200, token: 77, agent_token: 5 }), { status: 200 })
    throw new TypeError("fetch failed")
  }
  try {
    const u = await p.auth.usage(auth)
    assert.equal(u.error, undefined, "the points still make a card")
    assert.match(u.balance, /77 点/, "with the balance they answered")
    assert.equal(u.windows.filter((w) => w.name === "每日签到").length, 0, "a status read that never came back draws no row")
    assert.equal(u.windows.filter((w) => w.name.startsWith("免费模型")).length, 0, "and neither does an activity read")
  } finally {
    globalThis.fetch = real
  }
})

test("a concurrency on the catalog envelope itself is read too", () => {
  // publishedConcurrency reads three places for the number: the body, the
  // catalog wrapper, and each model. Only the first and the last had a test,
  // so the wrapped spelling could have been dropped in silence.
  assert.equal(publishedConcurrency({ catalog: { max_concurrency: 4, data: [{ id: "a" }] } }), 4, "a count on the catalog wrapper is a count")
  assert.equal(publishedConcurrency({ catalog: { max_concurrency: 6, data: [{ max_concurrency: 9 }] } }), 6, "and the smallest of all of them still wins")
})

test("a word where a number belongs is not a wait, on any of the four fields", () => {
  // numOf accepts numbers and numeric strings; a boolean, an array and an
  // object are none of them. Every field read with it had its own guard, but
  // the reader itself was only pinned through secsOf.
  const now = Math.floor(Date.now() / 1000)
  const running = runningActivities({
    code: 200,
    data: [
      { free_until: now + 3600, remaining_quota: true, user_quota_limit: true, model_ids: ["a"] },
      { free_until: [now + 3600], remaining_quota: null, model_ids: ["b"] },
      { free_until: { at: now + 3600 }, remaining_quota: null, model_ids: ["c"] },
      { free_until: now + 3600, remaining_quota: 5, user_quota_limit: 10, model_ids: ["d"] },
    ],
  })
  assert.deepEqual(running.map((a) => a.model_ids[0]), ["d"], "a boolean, an array and an object are not times; an unreadable quota is not drawn")
  assert.equal(secsOf(true), 0, "and it is the reading that refuses them, not a comparison that happens to")
})

test("an activity whose remaining quota cannot be read is not drawn as unlimited", () => {

  // remaining_quota is not that, and drawing it as unlimited states something
  // the vendor did not. A null (the vendor's "no quota") is still unlimited,
  // and a readable number is still drawn.
  const now = Math.floor(Date.now() / 1000)
  const data = runningActivities({
    code: 200,
    data: [
      { free_until: now + 3600, remaining_quota: "many", model_ids: ["x"] },
      { free_until: now + 3600, remaining_quota: null, model_ids: ["y"] },
      { free_until: now + 3600, remaining_quota: "12", model_ids: ["z"] },
    ],
  })
  assert.deepEqual(data.map((a) => a.model_ids[0]), ["y", "z"], "an unreadable quota is hidden, a null and a number are not")
})

// ---- readings the review found unpinned -----------------------------------

test("a business code a JSON number cannot hold is still a code", async () => {
  // `1e999` is legal JSON and parses to Infinity. Every gate was written
  // `Number.isFinite(code) && code !== 200`, so a refusal that stated this
  // code was read as one that stated no code at all: the catalog, the
  // activities, the free model, the balances and the check-in were served
  // from answers that had just refused them.
  assert.equal(codeOf(1e999), Infinity)
  assert.equal(catalogOf({ code: 1e999, data: [{ id: "m", protocol: { type: "openai_chat_completions" }, context_window: 1 }] }, "eyJabcdefghijklmnopqrstuvwxyz0123456789"), null, "a catalog refusal is not a catalog")
  assert.deepEqual(runningActivities({ code: 1e999, data: [{ free_until: Math.floor(Date.now() / 1000) + 3600, model_ids: ["a"] }] }), [], "nor an activities list")
  assert.equal(freeModelOf({ code: 1e999, data: { status: "available", activity_id: "a" } }), null, "nor a campaign")
  // JSON.stringify turns Infinity into null, so the bodies go out as text.
  const raw = (text) => () => new Response(text, { status: 200, headers: { "Content-Type": "application/json" } })
  const p = await CodarPlugin()
  const r = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 5, agent_token: 0 } },
      "/v1/daily-sign": raw('{"code":1e999,"success":true,"message":"签到成功"}'),
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(r.outcome, "failed", "a check-in stating this code is not this attempt's claim")
  const u = await withFetch({ "/v1/gettoken": raw('{"code":1e999,"token":500,"agent_token":0}') }, async () => p.auth.usage(auth))
  assert.ok(u.error, "and a balance read stating it is not a balance")
})

test("the claim row's next-claim time is that many seconds from now, in ms", async () => {
  // The sign-in's `until` had a tight reading (>= before + 3600s); the row this
  // same rule builds for the card did not — only "> Date.now()", which a
  // millisecond/second slip of 1000x still passes. A two-hour wait that came
  // out as 7.2 seconds would tell the user to claim again in a moment.
  const p = await CodarPlugin()
  const before = Date.now()
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 1, agent_token: 0 } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true, retry_after: 7200 } } },
      "/api/codar/activities/mine": { body: { code: 200, data: [] } },
    },
    async () => p.auth.usage(auth),
  )
  const win = u.windows.find((w) => w.name === "每日签到")
  const gap = win.resetsAt - before
  assert.ok(Math.abs(gap - 7200 * 1000) < 2000, `a two-hour wait is 7.2e6 ms, not 7.2e3 (got ${gap})`)
})

test("a user's model field that is not a map is taken as written, not spread into one", () => {
  // mergeModel folds the user's entry into the catalog's at every depth. The
  // guard on `theirs` is load-bearing: without it a nested value the user
  // wrote as a string is handed to Object.entries, which spreads a string by
  // index — {0:"h",1:"t",…} beside the catalog's npm — and the host then sends
  // that model to an address nobody set.
  const merged = mergeModel({ provider: { npm: "@ai-sdk/anthropic" } }, { provider: "https://my-proxy.example/v1" })
  assert.equal(merged.provider, "https://my-proxy.example/v1", "the string the user wrote, not a map of its characters")
  assert.deepEqual(merged, { provider: "https://my-proxy.example/v1" })
})

test("a space inside a key is not visible ASCII either", () => {
  // tokenOf refuses anything that cannot go in a header, and a space is the
  // one character a trimmed key can still carry inside it. Sent, fetch quotes
  // the whole header value — the key — back in an error magpie logs.
  assert.equal(tokenOf({ type: "api", key: "eyJhbG ciOi.abc" }), "", "an inner space is refused, as a newline is")
  assert.equal(tokenOf({ type: "api", key: "  eyJabc.def.ghi  " }), "eyJabc.def.ghi", "the surrounding ones are trimmed, as before")
})

test("an agent figure the first read leaves out is read from the second", async () => {
  // The vendor keeps the two balances in separate reads, and its own client
  // takes the agent one from /v1/agent/balance when /v1/gettoken didn't give
  // it (app.asar's S0). Measured the same day: both answer 4000.
  const p = await CodarPlugin()
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500 } },
      "/v1/agent/balance": { body: { code: 200, message: "Success", data: { username: "user_1", agent_balance: 1970 } } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true, retry_after: 60 } } },
      "/api/codar/activities/mine": { body: { code: 200, data: [] } },
    },
    async () => p.auth.usage(auth),
  )
  assert.equal(u.error, undefined)
  assert.equal(u.balance, "500 点 · Agent 1970 点 可用", "the agent figure the second endpoint names")
  assert.equal(u.windows.find((w) => w.name === "点数余额").balance, 500, "and the wallet is still the first read's")
})

test("a dead balance read still leaves the agent figure, and does not blank the card", async () => {
  // Measured 2026-11-02: /v1/gettoken and /v1/agent/balance both answer, and
  // the second names the same agent figure. The vendor's own client falls
  // back across them (S0); with one read the card was an error instead.
  const p = await CodarPlugin()
  const u = await withFetch(
    {
      "/v1/gettoken": { status: 500, body: { detail: "boom" } },
      "/v1/agent/balance": { body: { code: 200, message: "Success", data: { username: "user_1", agent_balance: 4000 } } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true, retry_after: 60 } } },
      "/api/codar/activities/mine": { body: { code: 200, data: [] } },
    },
    async () => p.auth.usage(auth),
  )
  assert.equal(u.error, undefined, "a card that read the agent figure is not an error card")
  assert.equal(u.balance, "Agent 4000 点 可用")
  assert.equal(u.windows.find((w) => w.name === "点数余额"), undefined, "no wallet: the general figure was not said, and 0 is not it")
  assert.ok(u.windows.find((w) => w.name === "每日签到"), "the check-in row is still drawn")
})

test("both balance reads failing is still the card's error, with its reason", async () => {
  const p = await CodarPlugin()
  const u = await withFetch(
    {
      "/v1/gettoken": { status: 500, body: { detail: "boom" } },
      "/v1/agent/balance": { status: 500, body: { detail: "also boom" } },
    },
    async () => p.auth.usage(auth),
  )
  assert.match(u.error, /boom/, "the vendor's own words for the first read")
  assert.equal(u.windows, undefined, "and nothing is drawn beside it")
})

test("a sign-in the vendor turns away is the card's answer, whatever the other reads say", async () => {
  // A 403 means every read of this account says the same thing, and the card
  // must keep the "sign in again" mark that is the only thing the user can
  // act on. The balance read still goes out with the rest — the vendor's own
  // client asks all three together (S0) — so what this pins is that a
  // sign-out answer wins over a balance the same batch happened to return,
  // rather than being reported as a partial read.
  const p = await CodarPlugin()
  const seen = []
  const real = globalThis.fetch
  globalThis.fetch = async (url) => {
    seen.push(String(url))
    if (String(url).includes("/v1/agent/balance")) return new Response(JSON.stringify({ code: 200, data: { agent_balance: 1 } }), { status: 200 })
    return new Response(JSON.stringify({ code: 403, message: "Forbidden" }), { status: 200 })
  }
  try {
    const u = await p.auth.usage(auth)
    assert.equal(u.signIn, "expired")
    assert.equal(u.error, "登录已过期，请重新登录")
    assert.equal(u.windows, undefined, "no row is drawn beside a sign-out answer")
    assert.ok(seen.some((u2) => u2.includes("/v1/agent/balance")), "the balance read went out with the batch, not after it")
  } finally {
    globalThis.fetch = real
  }
})

test("a refusal spelled with a small code is a refusal on the activity and status reads too", async () => {
  // pointsOf's code gate was pinned against {code:1}; the activity list and
  // the sign-in status had the same gate and only ever saw 500. A vendor that
  // says no with {code:1} would have had its data drawn as live.
  const p = await CodarPlugin()
  const until = Math.floor(Date.now() / 1000) + 3600
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 1, agent_token: 0 } },
      "/v1/daily-sign/status": { body: { code: 1, data: { isSigned: false } } },
      "/api/codar/activities/mine": { body: { code: 1, data: [{ free_until: until, remaining_quota: null, model_ids: ["auto"] }] } },
    },
    async () => p.auth.usage(auth),
  )
  assert.equal(u.windows.find((w) => w.name === "每日签到"), undefined, "{code:1} is not a state to draw")
  assert.equal(u.windows.filter((w) => w.name.startsWith("免费模型")).length, 0, "nor a live campaign")
})

test("an HTTP refusal keeps the vendor's own words, not just the status", async () => {
  // request() prefers what the body says over "HTTP 429". Nothing pinned that:
  // the 401 path is answered by signedOut() before the body is read, so a
  // rate limit came out as a bare status code the user cannot act on.
  const p = await CodarPlugin()
  const u = await withFetch(
    { "/v1/gettoken": { status: 429, body: { detail: "quota exceeded for this account" } }, "/v1/agent/balance": { status: 429, body: { detail: "quota exceeded for this account" } } },
    async () => p.auth.usage(auth),
  )
  assert.match(u.error, /quota exceeded for this account/)
})

test("an HTTP 403 is a sign-in to redo, on both the card and the sign-in", async () => {
  // 401 was the only status tested. A vendor that answers 403 (measured on
  // this very account's chat gateway: "API access is restricted") would have
  // left the card showing a bare code and no "sign in again".
  const p = await CodarPlugin()
  const u = await withFetch({ "/v1/gettoken": { status: 403, body: { detail: "Forbidden" } } }, async () => p.auth.usage(auth))
  assert.equal(u.signIn, "expired")
  assert.equal(u.error, "登录已过期，请重新登录")

  const r = await withFetch({ "/v1/daily-sign": { status: 403, body: { detail: "Forbidden" } } }, async () => p.auth.checkin(auth))
  assert.equal(r.outcome, "failed")
  assert.equal(r.message, "登录已过期，请重新登录")
})

test("a model record with no name is named by its id", () => {
  // Two fallbacks guard the name, and neither was pinned: catalogOf's
  // `said || id` and modelOf's `name: m.name || m.id`. Drop either and a
  // vendor record with no display_name becomes a nameless row on the list.
  assert.equal(catalogOf({ data: [{ id: "x" }] })[0].name, "x")
  assert.equal(modelOf({ id: "m" }).name, "m")
})

test("chat.headers finds its provider by the info the listing hands it, too", async () => {
  // The hook reads input.model.providerID ?? input.provider.info.id. Only the
  // first was tested; a listing that handed it the second left the chat
  // request without the sidecar's User-Agent.
  const p = await CodarPlugin()
  const out = { headers: {} }
  await p["chat.headers"]({ provider: { info: { id: "codar" } } }, out)
  assert.equal(out.headers["User-Agent"], "Go-http-client/1.1")
})

test("the sign-in budget keeps room above three requests, and both stay under magpie's", () => {
  // The old assertions were `3 * TIMEOUT <= BUDGET` and `BUDGET < HOST_*`,
  // which a budget shrunk to exactly 3 timeouts still passes — no room for the
  // read after the claim — and which compare the host deadlines only to the
  // plugin's own copy of them. The host deadlines are the literals magpie
  // states: 20s for a usage read, 2 minutes for a check-in.
  const t = testables.timing
  assert.ok(3 * t.TIMEOUT_MS + 1000 <= t.CHECKIN_BUDGET_MS, "the check-in's three reads plus a second to spare")
  assert.ok(t.USAGE_BUDGET_MS > t.TIMEOUT_MS, "the usage reads are not cut short by their own budget")
  assert.ok(t.CHECKIN_BUDGET_MS <= 120 * 1000, "and the plugin's check-in lands before magpie's 2 minutes")
  assert.ok(t.USAGE_BUDGET_MS <= 20 * 1000, "and its usage read before magpie's 20s")
})

test("a protocol this provider cannot carry is not listed as the one it can", () => {
  // The vendor's sidecar schema names three protocols and posts
  // openai_responses to /v1/responses. This plugin's only OpenAI wire is the
  // chat one, so a record that says responses is left out rather than listed
  // as chat — where every request would go out in the wrong shape.
  assert.equal(protocolOf({ protocol: { type: "openai_responses" } }), "openai_responses", "the vendor's own word is kept")
  assert.equal(protocolOf({ protocol: { type: "anthropic_messages" } }), "anthropic_messages")
  assert.equal(protocolOf({}), "openai_chat_completions", "and a record that says nothing is the chat one")
  assert.equal(protocolOf({ protocol: { type: "some_future_wire" } }), "", "a name this plugin has never seen is no wire it can send, not the chat one by default")
  const list = catalogOf({ data: [{ id: "a", protocol: { type: "openai_chat_completions" } }, { id: "b", protocol: { type: "openai_responses" } }, { id: "c", protocol: { type: "anthropic_messages" } }, { id: "d", protocol: { type: "some_future_wire" } }] })
  assert.deepEqual(list.map((m) => m.id), ["a", "c"], "neither a responses model nor a wire we have never seen is served over the chat one")
})

// ---- round 22: the holes the review left, each pinned by a named test ----

test("a second balance endpoint that refuses with a body code is still a refusal", async () => {
  // /v1/gettoken's body-code gate was pinned; the second balance read
  // (agentPointsOf) had the same gate and no test ever answered it with a
  // numeric code other than 200. Read as a balance, a refusal's data would be
  // drawn on the card — {code:500, ...} painting a wallet of 0 over an account
  // that has points, which is the one thing every read here refuses to do.
  await assert.rejects(
    () =>
      withFetch({ "/v1/agent/balance": { body: { code: 500, message: "读取失败", data: { agent_balance: 0 } } } }, () =>
        testables.agentPointsOf(TOKEN, "user_1", { fetchImpl: globalThis.fetch }),
      ),
    /读取失败/,
    "the vendor's own words, not its data",
  )
})

test("a sign-out on the second balance endpoint is the sign-out, not a balance", async () => {
  // {code:401} on /v1/agent/balance is how the vendor says the sign-in is
  // gone. The card must not print its data as a figure.
  await assert.rejects(
    () =>
      withFetch({ "/v1/agent/balance": { body: { code: 401, data: { agent_balance: 9999 } } } }, () =>
        testables.agentPointsOf(TOKEN, "user_1", { fetchImpl: globalThis.fetch }),
      ),
    /登录已过期/,
    "a 401 body code is the sign-in gone",
  )
})

test("the two balances' gains add up, they do not take turns", async () => {
  // The card's credit is the sum of both balances' increases (the check-in's
// contract: the vendor says a claim grants the vendor's words without saying which
  // balance holds it). Each existing test moved one balance at a time, so `+`
  // could quietly become `Math.max` — a reward split across the two pots would
  // be halved.
  let n = 0
  const p = await CodarPlugin()
  const r = await withFetch(
    {
      "/v1/gettoken": () => {
        n += 1
        return new Response(JSON.stringify(n === 1 ? { code: 200, token: 500, agent_token: 3978 } : { code: 200, token: 510, agent_token: 4000 }), { status: 200 })
      },
      "/v1/daily-sign": { body: { code: 200, message: "Success" } },
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(r.credit, 32, "+10 on the general balance and +22 on the agent one is +32")
})

test("a first balance read that failed means no credit, not the whole balance", async () => {
  // If the read before the claim failed, the gain afterwards is unknown: the
  // card must say nothing rather than report the account's whole balance as
  // this claim's reward. `before?.general ?? 0` did exactly that.
  let n = 0
  const p = await CodarPlugin()
  const r = await withFetch(
    {
      "/v1/gettoken": () => {
        n += 1
        if (n === 1) return new Response(JSON.stringify({ detail: "boom" }), { status: 500 })
        return new Response(JSON.stringify({ code: 200, token: 900, agent_token: 4000 }), { status: 200 })
      },
      "/v1/daily-sign": { body: { code: 200, message: "Success" } },
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(r.outcome, "claimed")
  // an unknown baseline is no reward at all: the field is left out rather
  // than stated as 0, which would say the claim gained nothing
  assert.equal(r.credit, undefined, "an unknown baseline states no credit")
})

test("--check says which models the vendor added and which it dropped", async () => {
  // --check's whole job is noticing a vendor that added or removed a model,
  // and only the `changed:` line was ever exercised. With `added:` or
  // `removed:` dropped the run printed nothing and exited 0 over a file that
  // no longer matched the vendor.
  const one = { id: "kept", display_name: "K", context_window: 1 }
  const two = { id: "brand-new", display_name: "N", context_window: 1 }
  const rows = await recordsOf({ code: 200, data: [one] })
  const added = await genRun({ body: { code: 200, data: [one, two] }, seeded: render(sortRows(rows)), argv: ["--check"] })
  assert.equal(added.exit, 1, "a model the vendor added is out of date")
  assert.ok(added.logs.some((l) => l.includes("added:   brand-new")), `the added record is named: ${JSON.stringify(added.logs)}`)
  const gone = { id: "gone", display_name: "G", context_window: 1 }
  const removed = await genRun({ body: { code: 200, data: [one] }, seeded: render(sortRows(await recordsOf({ code: 200, data: [one, gone] }))), argv: ["--check"] })
  assert.equal(removed.exit, 1, "a model the vendor dropped is out of date")
  assert.ok(removed.logs.some((l) => l.includes("removed: gone")), `the dropped record is named: ${JSON.stringify(removed.logs)}`)
})

test("a vendor refusing with HTTP 500 is a read failure, not an empty catalog", async () => {
  // The generator checked res.ok; nothing pinned it. Without that line a 500
  // whose body still carried a `data` array would be written out as the
  // vendor's catalog — committing a failed read as the fallback everyone gets.
  const body = { code: 500, data: [{ id: "ghost", display_name: "Ghost", context_window: 1 }] }
  const { mkdtempSync, readFileSync } = await import("node:fs")
  const root = mkdtempSync(join(tmpdir(), "codar-gen-"))
  writeFileSync(join(root, "config.json"), JSON.stringify({ provider: { speedai: { token: mkToken({ username: "u", exp: Math.floor(Date.now() / 1000) + 3600 }) } } }))
  const logs = []
  try {
    const exit = await main({
      argv: ["node", "scripts/catalog.mjs"],
      env: { CODAR_HOME: root },
      out: join(root, "catalog.mjs"),
      fetchImpl: async () => new Response(JSON.stringify(body), { status: 500, headers: { "Content-Type": "application/json" } }),
      log: { log: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) },
    })
    assert.equal(exit, 2, "an HTTP refusal is a read failure")
    assert.ok(logs.some((l) => l.includes("HTTP 500")), `and it says so: ${JSON.stringify(logs)}`)
    assert.throws(() => readFileSync(join(root, "catalog.mjs")), "nothing was written")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a message cut to fit ends on a character, not on half of one", async () => {
  // A string shown on a card — a model's name, a message — is cut by the
  // character, not by the UTF-16 unit. Only names went through the code-point
  // cut; a message was clipped with .slice(0, 400), so a vendor sentence full
  // of emoji ended in a lone surrogate the host reads as U+FFFD.
  const p = await CodarPlugin()
  const long = "a" + "😀".repeat(300)
  const r = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign": { body: { code: 200, message: long } },
    },
    async () => p.auth.checkin(auth),
  )
  assert.ok([...r.message].length <= 400, "no longer than the card reads, counted in characters")
  assert.doesNotMatch(r.message, /[\uD800-\uDBFF]$/, "and never ends on a lone high surrogate")
  assert.doesNotMatch(r.message, /^[\uDC00-\uDFFF]/, "nor starts on a lone low one")
})

test("a name that is all emoji is cut on a character too", () => {
  // cleanText's cut is the same rule, measured on the character count rather
  // than the UTF-16 length: 120 code points of emoji are 240 UTF-16 units.
  const name = cleanText("😀".repeat(200))
  assert.equal([...name].length, 120)
  assert.doesNotMatch(name, /[\uD800-\uDBFF]$/)
})

test("a name that is many code points is cut on a code point", () => {
  // cleanText's cut is the same rule scrub got: measured in code points, not
  // UTF-16 units. A name of astral characters is where the two differ — 130
  // code points are 260 UTF-16 units, and the old slice(0, 120) would have
  // kept 60 characters and clipped the 60th in half.
  const name = cleanText("😀".repeat(130))
  assert.equal([...name].length, 120, "120 characters, not 60")
  assert.doesNotMatch(name, /[\uD800-\uDBFF]$/, "and not half of one")
})

test("the first balance read's agent figure wins over the second one", async () => {
  // The vendor's own client merges them as `gettoken's agentPoints ?? the
  // second read` (app.asar's S0). Reading the second one over the top would
  // report a figure the vendor's first answer already contradicted.
  const p = await CodarPlugin()
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 4000 } },
      "/v1/agent/balance": { body: { code: 200, data: { username: "user_1", agent_balance: 9999 } } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true, retry_after: 60 } } },
      "/api/codar/activities/mine": { body: { code: 200, data: [] } },
    },
    async () => p.auth.usage(auth),
  )
  assert.equal(u.balance, "500 点 · Agent 4000 点 可用", "the first read's figure, as the vendor's client merges them")
})

test("cut reads only the first 2n units of a vendor's string", () => {
  // A vendor sentence is cut to 120/400 characters, but the walk used to
  // flatten the whole string into an array first: 32 MB of text cost ~1 s
  // and ~350 MB of heap, in a host every plugin shares. n code points take
  // at most 2n UTF-16 units, so nothing the answer keeps is past 2n.
  const big = Buffer.alloc(16 * 1024 * 1024, 0x61).toString("latin1")
  const t = process.hrtime.bigint()
  const out = cut(big, 400)
  const ms = Number(process.hrtime.bigint() - t) / 1e6
  assert.equal(out.length, 400, "still 400 characters")
  assert.ok(ms < 200, `16 MB took ${ms.toFixed(1)} ms; the walk should not touch the tail of the string`)
})

test("a character straddling the 2n boundary is not cut in half", () => {
  // The early slice can end inside a surrogate pair; that lone surrogate is
  // always the code point after the n taken, so it never reaches the answer.
  for (const s of ["a" + "😀".repeat(6), "😀".repeat(6) + "b", "ab😀cd", "x😀y😀z"]) {
    const byChar = [...s]
    for (let k = 0; k <= byChar.length + 1; k++) {
      const out = cut(s, k)
      assert.equal(out, byChar.slice(0, k).join(""), `${JSON.stringify(s)} cut to ${k} is the same as the code-point cut`)
      assert.doesNotMatch(out, /[\uD800-\uDBFF]$/, `${k}: no lone high surrogate`)
      assert.doesNotMatch(out, /^[\uDC00-\uDFFF]/, `${k}: no lone low surrogate`)
    }
  }
})

test("catalogOf stops looking after MAX_MODELS records, kept or not", () => {
  // The cap was on records kept; a list whose every record is unusable — a
  // shape the vendor could send by accident — was walked to the end, entry
  // by entry. The counter reads each element through a getter to show where
  // the walk stopped.
  const junk = []
  let reads = 0
  for (let i = 0; i < MAX_MODELS * 3; i++) {
    Object.defineProperty(junk, i, { get() { reads++; return null }, enumerable: true, configurable: true })
  }
  assert.equal(junk.length, MAX_MODELS * 3)
  assert.equal(catalogOf({ data: junk }), null, "nothing usable is still a fallback, not an empty catalog")
  assert.ok(reads <= MAX_MODELS + 1, `examined ${reads} of ${MAX_MODELS * 3} records; the scan stops at MAX_MODELS`)
})

test("a vendor code that is an object does not throw out of the hooks", () => {
  // Number({toString: 1}) calls the field and throws (it is not a function),
  // so {"code":{"toString":1}} — plain JSON a server can send — took the
  // usage hook, the check-in and the activity filter down with it. numOf
  // answers NaN, which every caller already reads as "no code stated".
  const odd = { toString: 1 }
  return (async () => {
    const p = await CodarPlugin()
    const u = await withFetch(
      {
        "/v1/gettoken": { body: { code: odd, token: 500, agent_token: null } },
        "/v1/agent/balance": { body: { code: odd, data: { agent_balance: 3 } } },
        "/v1/daily-sign/status": { body: { code: odd, data: { isSigned: true } } },
        "/api/codar/activities/mine": {
          body: {
            code: odd,
            data: [{ status: "active", name: "免费", model_ids: ["a"], free_until: Math.floor(Date.now() / 1000) + 3600, remaining_quota: null }],
          },
        },
      },
      async () => p.auth.usage(auth),
    )
    assert.equal(u.error, undefined, "the card still builds")
    assert.match(u.balance, /^500 点/, "the balance is read, not lost to the object")
    assert.match(u.balance, /Agent 3 点/, "and so is the second endpoint's, which speaks only through an object code")
    assert.ok(u.windows.some((w) => w.name.startsWith("免费模型")), "the activity is drawn, not dropped")
    assert.match(u.windows.find((w) => w.name === "每日签到").display, /今天已领/, "and the sign state is read past its object code")
    const r = await withFetch({ "/v1/daily-sign": { body: { code: odd } } }, async () => p.auth.checkin(auth))
    assert.equal(r.outcome, "failed", "an unreadable code is neither a throw nor a claim: nothing said the day was taken")
    assert.match(r.message, /签到失败/, "and the card names it as a failure")
  })()
})

test("a business code is read the way the vendor's client reads one", async () => {
  // app.asar's ft reads a business code as Number(e.code), so null and the
  // empty string are 0, true is 1, [] is 0 and [400] is 400 — every one of
  // them a finite code that is not 200, and so a refusal. numOf reads a
  // boolean, an array, null and "" as "no code", and {code: [], token: 500}
  // came out as a balance of 500: the card drew a figure the vendor refused
  // to state.
  assert.equal(codeOf([]), 0, "an empty array is the 0 Number() reads")
  assert.equal(codeOf([400]), 400, "a one-element array is its element")
  assert.equal(codeOf(""), 0, "an empty string is 0")
  assert.equal(codeOf(null), 0, "null is 0")
  assert.equal(codeOf(true), 1, "true is 1")
  assert.ok(Number.isNaN(codeOf({})), "an object is still no code: nothing is called on it")
  const p = await CodarPlugin()
  for (const bad of [[], [400], true, "", null]) {
    const u = await withFetch(
      {
        "/v1/gettoken": { body: { code: bad, token: 500 } },
        "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true } } },
        "/api/codar/activities/mine": { body: { code: 200, data: [] } },
      },
      async () => p.auth.usage(auth),
    )
    assert.ok(u.error, `${JSON.stringify(bad)} is a refusal, not a balance of 500`)
    assert.equal(u.windows, undefined, "and no card is drawn from it")
  }
  assert.equal(catalogOf({ code: [], data: [{ id: "x" }] }), null, "a catalog read refuses the same way")
  assert.equal(catalogOf({ code: [400], data: [{ id: "x" }] }), null, "and so does a one-element code")
  const r = await withFetch(
    { "/v1/daily-sign": { body: { code: [], message: "24小时内仅可领取一次", data: { retry_after: 60 } } } },
    async () => p.auth.checkin(auth),
  )
  assert.equal(r.outcome, "failed", "a code the client reads as 0 is not the day's 400, whatever the words")
})

test("a catalog that says nothing about concurrency does not undo the last number", async () => {
  const p = await CodarPlugin()
  const route = (extra) => ({
    "/v1/codar/models": { body: { data: [{ id: "x", protocol: { type: "openai_chat_completions" }, ...extra }] } },
  })
  await withFetch(route({ max_concurrency: 7 }), async () => p.provider.models({ models: {} }, { auth: await auth() }))
  assert.equal(p.auth.maxConcurrency, 7)
  await withFetch(route({}), async () => p.provider.models({ models: {} }, { auth: await auth() }))
  assert.equal(p.auth.maxConcurrency, 7, "a catalog with no number is not a statement to go back to 3")
})

test("a credential echoed without its eyJ head, or as its signature alone, is cut", () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
  const header = b64({ alg: "HS256", typ: "JWT" })
  const payload = b64({ username: "user_1", exp: 1900000000 })
  const sig = "Kq3zX9bLmN2pR7tY4vW1cD8fG5hJ0kQ6sA9eU2iO7pZ"
  const jwt = `${header}.${payload}.${sig}`
  for (const echo of [jwt, jwt.slice(1), jwt.slice(4), sig, `${header}.${payload}`]) {
    // The headless echo cuts as two spans (the headless JWT shape, then the
    // lone signature), which removes more than one — assert the credential is
    // gone, not that the surrounding prose was cut in exactly one place.
    const out = scrubLine(`bad key ${echo}`, "")
    assert.ok(out.startsWith("bad key ") && /…/.test(out), `${echo.slice(0, 12)}… is cut`)
    assert.ok(!out.includes("eyJhbGci") && !out.includes(sig), `${echo.slice(0, 12)}… leaves no credential behind: ${out}`)
  }
  // shapes that only look like one are left alone
  for (const text of [
    "model deepseek-v4.1-flash is not available",
    "see https://api.speedai.com/v1/codar/models for details",
    "contact support@speedai.example.com please",
    "cannot read ~/.codar/config.json",
    "sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "the quota_exceeded_for_this_account_and_model_please_upgrade_plan error",
  ]) {
    assert.equal(scrubLine(text, ""), text, "not a credential")
  }
})

test("the sign-in's failure text says ~ instead of this machine's home", () => {
  // The dialog can end up in a screenshot or an issue; the home directory
  // carries the account name.
  const absent = join(homedir(), ".codar", "codar-plugin-test-absent.json")
  const r = appToken(absent)
  assert.match(r.error, /没找到/)
  assert.ok(!r.error.includes(homedir()), `no home directory in the message: ${r.error}`)
  assert.ok(r.error.includes("~"), "but the file is still pointed at")
  // shownPath keeps the platform's own separator, as the path it shortens
  // does — the expected value is built the same way instead of being written
  // with "/", which is only this suite's platform's (Windows says ~\.codar\…).
  assert.equal(shownPath(absent), `~${sep}${join(".codar", "codar-plugin-test-absent.json")}`)
  // a path the user chose (CODAR_HOME, a temp dir) is said as it is
  assert.equal(shownPath("/tmp/codar-x/config.json"), "/tmp/codar-x/config.json")
})

test("CODAR_HOME is used as the app uses it, whitespace and all", () => {
  // `codar config path` with CODAR_HOME="  /tmp/x  " answers
  // "  /tmp/x  /config.json" (measured against the installed app): the
  // sidecar does not trim, so a plugin that trimmed would read a file the
  // app never wrote.
  const had = process.env.CODAR_HOME
  process.env.CODAR_HOME = "  /tmp/codar-home-probe  "
  try {
    assert.equal(configPath(), join("  /tmp/codar-home-probe  ", "config.json"))
  } finally {
    if (had === undefined) delete process.env.CODAR_HOME
    else process.env.CODAR_HOME = had
  }
})

test("a vendor answer past the cap is refused while it is read", async () => {
  const big = new Response("x".repeat(MAX_ANSWER_BYTES + 1))
  await assert.rejects(() => readAnswer(big), /超过 8 MB/)
})

test("an answer split into chunks is decoded whole, even inside a character", async () => {
  // chunk boundaries fall anywhere; decoding each chunk on its own would
  // turn a character split across two into U+FFFD
  const bytes = new TextEncoder().encode("点数 ok")
  const split = new ReadableStream({
    start(c) {
      c.enqueue(bytes.slice(0, 1))
      c.enqueue(bytes.slice(1, 2))
      c.enqueue(bytes.slice(2))
      c.close()
    },
  })
  const { text } = await readAnswer(new Response(split))
  assert.equal(text, "点数 ok")
})

test("a multi-megabyte vendor sentence does not throw or stall the cleaners", () => {
  // scrubLine and cleanText run global regexes, and V8's engine recurses
  // while matching them: a 8 MB run of "eyJ"+"a " (or one long word, or a
  // bare signature) threw RangeError "Maximum call stack size exceeded" out
  // of the usage hook, and an 8 MB name of newlines took 2.5 s to fold — in
  // a host every plugin shares. Both clean only their first MAX_SCRUB_CHARS
  // characters now; nothing past them could reach a card or a log line.
  const shapes = {
    "one long word": "a".repeat(MAX_ANSWER_BYTES),
    "eyJ and spaces": "eyJ" + "a ".repeat(MAX_ANSWER_BYTES / 2),
    "a bare signature": "Kq3zX9bLmN2pR7tY4vW1cD8fG5hJ0kQ6sA9eU2iO7pZ" + "a".repeat(MAX_ANSWER_BYTES),
    "newlines": "a\n".repeat(MAX_ANSWER_BYTES / 2),
    "control characters": "​".repeat(MAX_ANSWER_BYTES / 2),
  }
  for (const [label, text] of Object.entries(shapes)) {
    const t = process.hrtime.bigint()
    const line = scrubLine(text, "")
    const clean = cleanText(text)
    const ms = Number(process.hrtime.bigint() - t) / 1e6
    assert.equal(typeof line, "string", `${label}: scrubLine answers`)
    assert.ok(clean.length <= 120, `${label}: cleanText is still a card line`)
    assert.ok(ms < 500, `${label}: ${MAX_ANSWER_BYTES} bytes took ${ms.toFixed(0)} ms`)
  }
})

test("the generator refuses a vendor answer past the plugin's own cap", async () => {
  // The plugin reads a body through a stream and gives up past
  // MAX_ANSWER_BYTES (index.mjs's readAnswer). The generator read it with
  // res.json(), which holds the whole answer first, whatever its size — the
  // same shape the plugin had before. It goes through the plugin's reader now.
  const body = '{"data":[{"id":"x","display_name":"' + "a".repeat(MAX_ANSWER_BYTES) + '"}]}'
  const { exit, logs, after } = await genRun({ body })
  assert.equal(exit, 2, "a read that could not finish is exit 2, not 'out of date'")
  // the terminal is English like the project's other prose (the card keeps the
  // Chinese wording; the generator restates the one message it inherits)
  assert.ok(logs.some((l) => l.includes("larger than the plugin's 8 MB cap")), `and it says why: ${JSON.stringify(logs)}`)
  assert.equal(after, null, "nothing was written")
})

test("the generator reads the app's file where the plugin does, whitespace and all", () => {
  // Both readers take CODAR_HOME as the app's sidecar does: verbatim, with an
  // empty value meaning "not set". A trim on one side would point the two at
  // different files — the generator would say "sign in again" about a config
  // the plugin had just read fine, or the other way round.
  const had = process.env.CODAR_HOME
  try {
    for (const v of ["  /tmp/codar-gen-probe  ", "/tmp/codar-gen-plain", ""]) {
      process.env.CODAR_HOME = v
      assert.equal(configPathOf(process.env), configPath(), `${JSON.stringify(v)}: one path for both readers`)
    }
  } finally {
    if (had === undefined) delete process.env.CODAR_HOME
    else process.env.CODAR_HOME = had
  }
  assert.equal(configPathOf({ CODAR_HOME: "  /tmp/x  " }), join("  /tmp/x  ", "config.json"), "verbatim, as the sidecar answers it")
  assert.equal(configPathOf({ CODAR_HOME: "   " }), join("   ", "config.json"), "whitespace is a value, as it is to the app")
  assert.equal(configPathOf({}), join(homedir(), ".codar", "config.json"), "an empty value is 'not set'")
})

// ---- the readers the balances sit on, pinned directly ---------------------

test("balanceOf reads a balance the way the vendor client does, and nothing it would not", () => {
  // Three readers used to carry the whole balance path with no test of their
  // own: every suite that reached them went through a vendor answer already
  // shaped to fit, so the edges below were only reachable by writing the
  // answer that would expose them. A balance is what numOf read — a number or
  // a string that says one — and non-negative and finite. Each refusal here
  // is a value routing would otherwise read as the account's money.
  assert.equal(balanceOf(5), 5)
  assert.equal(balanceOf(0), 0, "a real 0 is a balance, not 'not stated'")
  assert.equal(balanceOf("12"), 12, "the vendor writes some numbers as strings (see numOf)")
  assert.equal(balanceOf(" 12 "), 12, "and its strings come padded")
  assert.equal(balanceOf(-5), null, "a negative is not a balance: the host clamps a wallet to 0")
  assert.equal(balanceOf(-0), -0, "negative zero is still zero")
  assert.equal(balanceOf("NaN"), null, "Number('NaN') is NaN")
  assert.equal(balanceOf(""), null)
  assert.equal(balanceOf("   "), null, "a blank string says nothing")
  assert.equal(balanceOf("no points"), null)
  assert.equal(balanceOf(NaN), null)
  assert.equal(balanceOf(Infinity), null)
  assert.equal(balanceOf(-Infinity), null)
  for (const notANumber of [true, false, null, undefined, [], [5], {}, { valueOf: () => 5 }]) {
    // numOf reads numbers and non-blank strings only, so a JSON body's other
    // types never reach Number(): Number([]) is 0 and an object's valueOf is
    // its own answer. Each of these read as a balance would be a made-up one.
    assert.equal(balanceOf(notANumber), null, `${JSON.stringify(notANumber) ?? String(notANumber)} is not a balance`)
  }
})

test("pickOf walks the names in order and stops at the first that says a balance", () => {
  // The vendor client tries its names in turn (app.asar's Dn). Order is the
  // contract: a name that reads as nothing must not shadow a later one, and a
  // name that reads as 0 is an answer — the walk stops there, it does not look
  // for a bigger number behind it. Reading `token` first and falling through
  // on 0 would report an empty account as funded.
  assert.equal(pickOf({ points: 5, token: 3 }, ["token", "points"]), 3, "the first name that reads, not the largest")
  assert.equal(pickOf({ token: -1, points: 5 }, ["token", "points"]), 5, "a name that is not a balance falls through")
  assert.equal(pickOf({ token: "no points", balance: 7 }, ["token", "balance"]), 7, "as does one that is not a number")
  assert.equal(pickOf({ token: 0, points: 5 }, ["token", "points"]), 0, "but a real 0 is an answer, and the walk stops")
  assert.equal(pickOf({}, ["token", "points"]), null, "no name present is no balance")
  assert.equal(pickOf({ token: 3 }, []), null, "and no name asked for is none either")
  assert.equal(pickOf(null, ["token"]), null, "a body of null is no balance, not a throw")
  assert.equal(pickOf(undefined, ["token"]), null)
})

test("unwrapped takes data only when it is an object, and the body itself otherwise", () => {
  // app.asar's Gt: the live points body is flat, and a wrapped one is what
  // that client prefers if the vendor starts sending it. `data` that is a
  // string, a number or null is not a wrapper — unwrapping it would hand the
  // readers a scalar to look names up in, and the balance read would answer
  // "no balance" over a body that plainly has one.
  const wrapped = { code: 200, data: { token: 7, agent_token: 3 } }
  assert.equal(unwrapped(wrapped), wrapped.data, "an object data is unwrapped")
  const flat = { code: 200, token: 7 }
  assert.equal(unwrapped(flat), flat, "a flat body is its own answer")
  const nulled = { code: 200, data: null }
  assert.equal(unwrapped(nulled), nulled, "a null data is not a wrapper")
  const texty = { code: 200, data: "ok" }
  assert.equal(unwrapped(texty), texty, "nor is a string")
  const numbered = { code: 200, data: 0 }
  assert.equal(unwrapped(numbered), numbered, "nor a number")
  assert.equal(unwrapped(null), null, "and no body at all has nothing to unwrap")
})

test("the magic keys are exactly the names a model map is not allowed to carry", () => {
  // noMagicKeys and scripts/catalog.mjs both import this set, so the ids the
  // runtime drops and the ids a regeneration drops stay one list: a record
  // named `__proto__` never reaches magpie as a model (the host's
  // `out.models[key] = …` would set a prototype), and one written into the
  // fallback would be an id the live path would never serve. The set is small
  // and named for a reason — pin it, so it cannot quietly grow a name a real
  // model would have.
  assert.deepEqual([...magicKeys].sort(), ["__proto__", "constructor", "prototype"])
  assert.equal(magicKeys.has("name"), false, "a name a model could carry is not one of them")
})

test("the auth hook carries a loader, and it hands the request the account's key", async () => {
  // The repo's rule for a provider served through config: an auth hook of
  // { provider, loader, methods }. magpie falls back to the stored key
  // without one, but OpenCode's own entry points read the loader; an account
  // with no usable key answers {} rather than a made-up one.
  const p = await CodarPlugin()
  // The loader answers the base a request goes under beside the key: the
  // provider's address as it is written down, "/v1" included. An OpenAI
  // client joins "/chat/completions" onto it and an Anthropic one takes "/v1"
  // off the request path and joins "/messages", so the bare gateway is what
  // both arrive at ".../v1/..." from; with the bare base here the OpenAI
  // client asked the gateway at "/chat/completions", which nginx answers with
  // a 405 page (issue #3, measured 2026-11-16). It also answers a fetch: the
  // host runs a loader's fetch in place of its own (host.js's
  // `typeof o.fetch === "function" ? o.fetch : fetch`), which is what puts a
  // chat request on the plugin's own transport instead of Bun's.
  const first = await p.auth.loader(async () => auth())
  assert.equal(first.apiKey, TOKEN)
  assert.equal(first.baseURL, "https://api.claw.speedai.com/v1", "the address a request's /v1 is joined under")
  assert.equal(typeof first.fetch, "function", "the loader answers a fetch the host can use")
  const withProxy = await CodarPlugin()
  await withProxy.config({ provider: { codar: { api: "https://proxy.example/v1" } } })
  const second = await withProxy.auth.loader(async () => auth())
  assert.equal(second.apiKey, TOKEN)
  assert.equal(second.baseURL, "https://proxy.example/v1", "the user's own base, as it was written")
  assert.equal(typeof second.fetch, "function", "a user's own base keeps the same transport")
  assert.deepEqual(await p.auth.loader(async () => ({ type: "api", key: "  " })), {}, "no key, no credential")
  assert.deepEqual(await p.auth.loader(async () => undefined), {}, "and no auth at all is the same")

  // The fetch the loader answers is handed to the host and used in place of
  // its own: with the native chat transport off (the null at the top of this
  // file), it has to reach the host's fetch — a loader fetch that failed
  // without the proxy would take every conversation down with it.
  const answered = await withFetch({ "/v1/chat/completions": { body: { via: "fetch" } } }, async (calls) => {
    const res = await first.fetch("https://api.claw.speedai.com/v1/chat/completions", { method: "POST", body: "{}" })
    assert.equal(calls.length, 1, "the host's fetch did not carry it")
    assert.equal(calls[0].url, "https://api.claw.speedai.com/v1/chat/completions")
    return res.json()
  })
  assert.deepEqual(answered, { via: "fetch" })
})

// ---- round 25: the holes the five-way review left, each pinned by a test ----

test("a refusal that words itself in an object detail is still read", () => {
  // The gateway answers a refused request with
  // {"detail":{"code":"account_restricted","message":"API access is restricted…"}}.
  // saidBy read `detail` only as a string, so the vendor's own words were
  // dropped and the card showed a bare "HTTP 403" over a refusal that had
  // said exactly what was wrong.
  const body = { detail: { code: "account_restricted", message: "API access is restricted. Please contact support." } }
  assert.equal(saidBy(body), "API access is restricted. Please contact support.")
  assert.equal(errorCodeOf(body), "account_restricted", "and the business code is read out of the same object")
  assert.equal(saidBy({ data: { detail: { msg: "系统繁忙" } } }), "系统繁忙", "under data too")
  assert.equal(saidBy({ detail: "Not authenticated" }), "Not authenticated", "a string detail is unchanged")
  assert.equal(errorCodeOf({ code: "quota_exceeded" }), "quota_exceeded", "a word code is kept as it is")
  assert.equal(errorCodeOf({ code: 500 }), "", "a numeric code is not a business word")
})

test("account_restricted is not read as a sign-in that lapsed", async () => {
  // A 403 whose body says account_restricted is a refusal about the account,
  // not its token: telling the user to sign in again sends them to a fix that
  // cannot work. The check-in and the card both say what the vendor said.
  const refusal = () => new Response(JSON.stringify({ detail: { code: "account_restricted", message: "API access is restricted." } }), { status: 403, headers: { "Content-Type": "application/json" } })
  const p = await CodarPlugin()
  const r = await withFetch({ "/v1/daily-sign": refusal, "/v1/gettoken": refusal }, async () => p.auth.checkin(auth))
  assert.equal(r.outcome, "failed")
  assert.match(r.message, /account_restricted/, "the card names the restriction, not a lapsed sign-in")
  assert.doesNotMatch(r.message, /重新登录/)

  const u = await withFetch({ "/v1/gettoken": refusal, "/v1/agent/balance": refusal, "/v1/daily-sign/status": refusal, "/api/codar/activities/mine": refusal }, async () => p.auth.usage(auth))
  assert.match(u.error, /account_restricted/)
  assert.notEqual(u.signIn, "expired", "the account is not marked as signed out over a restriction")
})

test("a 401 with success:false still asks for a sign-in, not the vendor's words", async () => {
  // The order the flags are read in matters: {code:401, success:false} is an
  // expired sign-in carrying the refusal flag the activity API uses, and
// reading success:false first put the vendor's the vendor's words sentence on the
  // card instead of "sign in again".
  const p = await CodarPlugin()
  const r = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign": { body: { code: 401, success: false, message: "24小时内仅可领取一次" } },
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(r.outcome, "failed")
  assert.match(r.message, /重新登录/)
})

test("the \"already claimed\" wording needs the whole claim, not just the window", () => {
  // `24h` alone is not the phrase: a maintenance notice ("scheduled to resume in 24 hours")
  // says 24 hours about something else, and reading it as "already claimed"
  // settled the day off an outage. A leading digit is not a day either.
  assert.equal(ALREADY_CLAIMED.test("24小时内仅可领取一次"), true, "the vendor's own wording is read")
  assert.equal(ALREADY_CLAIMED.test("系统维护，预计24小时后恢复"), false, "a maintenance note about 24 hours is not a claim")
  assert.equal(ALREADY_CLAIMED.test("系统维护，预计124小时后恢复"), false, "nor is a number that merely ends in 24")
  assert.equal(ALREADY_CLAIMED.test("Already claimed"), true)
  assert.equal(ALREADY_CLAIMED.test("once every 24 hours"), true)
  // A sign-in is not the check-in: "signed" alone reads as logging in
  // somewhere, and one device's login note settled the whole day. The
  // check-in's own English words are "checked in" or a "today" beside it.
  assert.equal(ALREADY_CLAIMED.test("Already signed in on another device"), false, "a login elsewhere is not the day")
  assert.equal(ALREADY_CLAIMED.test("Already signed in"), false, "nor is a bare sign-in")
  assert.equal(ALREADY_CLAIMED.test("Already checked in"), true, "checking in is the check-in")
  assert.equal(ALREADY_CLAIMED.test("Already signed today"), true, "and the day itself still counts")
})

test("Retry-After reaches the card, as seconds or as a date", () => {
  assert.equal(retryAfterOf("30"), 30)
  assert.equal(retryAfterOf(String(90)), 90, "a big number is still a number of seconds")
  const sameDay = retryAfterOf(new Date(Date.now() + 90_000).toUTCString())
  assert.ok(sameDay >= 85 && sameDay <= 90, `an HTTP date becomes the seconds it names: ${sameDay}`)
  assert.equal(retryAfterOf(""), 0, "no header, no wait")
  assert.equal(retryAfterOf("soon"), 0, "words are not a wait")
  assert.equal(retryAfterOf("-5"), 0, "a negative wait is no wait")
  assert.ok(retryAfterOf(String(10 ** 9)) <= 7 * 24 * 3600, "a wait past a week is capped like the check-in's own")

  return (async () => {
    const p = await CodarPlugin()
    const r = await withFetch(
      { "/v1/daily-sign": () => new Response(JSON.stringify({ message: "too many" }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "45" } }) },
      async () => p.auth.checkin(auth),
    )
    assert.equal(r.outcome, "failed")
    assert.match(r.message, /45 秒/, "the wait the vendor named is on the card")
  })()
})

test("a key that is not a string is no key", () => {
  // A damaged plugin-auth.json can hold a number or a list where the key
  // belongs. String() would hand the host "123" to send; tokenOf reads only
  // strings, and a key that is there but unusable says so rather than
  // pretending the account never signed in.
  assert.equal(tokenOf({ type: "api", key: 123 }), "")
  assert.equal(tokenOf({ type: "api", key: ["eyJabc.def.ghi"] }), "")
  assert.equal(tokenOf({ type: "api", key: TOKEN }), TOKEN)
})

test("an address the plugin will send a key to is an http(s) URL or the gateway", () => {
  // magpie joins a request path onto this base and sends the account's key
  // with it, so a value that is not an absolute http(s) URL is refused rather
  // than used.
  assert.equal(baseURL("https://proxy.example/v1/"), "https://proxy.example/v1")
  assert.equal(baseURL("http://127.0.0.1:8080/v1"), "http://127.0.0.1:8080/v1", "a local proxy is the user's own choice")
  assert.equal(baseURL("//evil.example/v1"), "https://api.claw.speedai.com/v1", "a protocol-relative address is no address")
  assert.equal(baseURL("file:///etc/passwd"), "https://api.claw.speedai.com/v1")
  assert.equal(baseURL("javascript:alert(1)"), "https://api.claw.speedai.com/v1")
  // WHATWG reads "https:///v1" as host "v1" with no path: written with an
  // empty authority, the address would send the key to a host named after the
  // first path segment. The writer meant the path, so it is not used.
  assert.equal(baseURL("https:///v1"), "https://api.claw.speedai.com/v1", "an address written with an empty authority is no address")
  assert.equal(baseURL("https:/v1"), "https://api.claw.speedai.com/v1", "nor is one written with a single slash")
  assert.equal(baseURL("https://user:pw@proxy.example/v1"), "https://user:pw@proxy.example/v1", "credentials in the authority are the user's business")
  assert.equal(baseURL(""), "https://api.claw.speedai.com/v1", "and nothing said is the vendor's gateway")
})

test("an address without a path gets the vendor's /v1, as the gateway does", () => {
  // The vendor's gateway is written without /v1 and the plugin answers
  // ".../v1" beside it, because an OpenAI client joins "/chat/completions" on
  // and an Anthropic one keeps its own "/v1" (the loader's comment, issue #3).
  // A user's own address without a path was handed back as written, so the
  // same clients asked "host/chat/completions": /v1 was there only when the
  // user happened to write it. The default address and a user's bare one now
  // follow one rule.
  assert.equal(baseURL("https://proxy.example"), "https://proxy.example/v1", "a bare host is given the vendor's /v1")
  assert.equal(baseURL("https://proxy.example/"), "https://proxy.example/v1", "a trailing slash is no path either")
  assert.equal(baseURL("https://proxy.example/gateway"), "https://proxy.example/gateway/v1", "an address with a path keeps the vendor's rule under it")
  assert.equal(baseURL("https://proxy.example/gateway/v1"), "https://proxy.example/gateway/v1", "and one that already ends in /v1 is left as it is")
  assert.equal(baseURL("http://127.0.0.1:8080"), "http://127.0.0.1:8080/v1", "a local proxy is the same rule")
})

test("a credential that is not a JWT is cut by its shape", () => {
  // The sign-in accepts any visible-ASCII token, so one that is not a JWT has
  // no eyJ to cut by. A server that quotes it back must not put it on a card.
  assert.doesNotMatch(scrubLine("bad key sk-abcdefghijklmnopqrstuvwx", ""), /sk-abcdefghijklmnopqrstuvwx/)
  assert.doesNotMatch(scrubLine("Authorization: Bearer abcdefghijklmnopqrst", ""), /abcdefghijklmnopqrst/)
  assert.match(scrubLine("the reply was fine", ""), /fine/, "prose is left alone")
  // a key folded with a control character is still cut by the key it is
  const folded = "bad token ab​cd.ef.gh here"
  assert.doesNotMatch(scrubLine(folded, "ab​cd.ef.gh"), /ab​cd\.ef\.gh/)
})

test("a body with no stream is still refused past the size cap", async () => {
  // readAnswer counts through the body stream where there is one; a Response
  // that offers only text() (or states its size) must be bounded too, or a
  // vendor answer can be held whole whatever its size.
  const big = "x".repeat(MAX_ANSWER_BYTES + 1)
  await assert.rejects(() => readAnswer({ text: async () => big, headers: new Map() }), /MB/, "an oversized body with no stream is refused")
  const stated = { text: async () => "", headers: { get: (k) => (k === "content-length" ? String(MAX_ANSWER_BYTES + 1) : null) } }
  await assert.rejects(() => readAnswer(stated), /MB/, "and one that states its size is refused before it is read")
  const ok = await readAnswer({ text: async () => "small", headers: new Map() })
  assert.equal(ok.text, "small", "a small body reads through")
})

test("a catalog whose business code refuses is no list, whatever it carries", () => {
  // The vendor's own client checks the body code before reading data
  // (app.asar's ft). A gateway that answers {code:500, data:[…]} must not
  // replace every model with whatever that refusal carried.
  assert.equal(catalogOf({ code: 500, data: [{ id: "x" }] }), null, "a refusing code is no list")
  assert.equal(catalogOf({ code: 401, data: [{ id: "x" }] }), null)
  assert.equal(catalogOf({ code: 200, data: [{ id: "x", protocol: { type: "openai_chat_completions" } }] }).length, 1, "a 200 is read normally")
  assert.equal(catalogOf({ data: [{ id: "x", protocol: { type: "openai_chat_completions" } }] }).length, 1, "and so is a body that names no code")
})

// ---- round 26: the second five-way review ----

test("a 200 that names no claim is not settled by a wait alone", async () => {
  // The "400 beside a readable retry_after" pair says the day is claimed; a
  // 200 with no code and no wording says nothing, and the wait it carries
  // does not say it either — a gateway envelope or another endpoint's notice
  // can carry one. Read as done, the day was settled on a body that never
  // mentioned the claim.
  const p = await CodarPlugin()
  const read = (body) =>
    withFetch(
      {
        "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
        "/v1/daily-sign": { body },
      },
      async () => p.auth.checkin(auth),
    )
  const bare = await read({ data: { retry_after: 3600 } })
  assert.equal(bare.outcome, "failed", "no code and no words is not a claim, whatever the wait")
  const paired = await read({ code: 400, data: { retry_after: 3600 } })
  assert.equal(paired.outcome, "done", "a 400 beside the wait still is the day's")
  assert.match(paired.message, /今天已领过/)
})

test("account_restricted is read from the body before the status says anything", async () => {
  // The gateway today answers 403, but the business code is the statement:
  // a 200 carrying it is the same refusal, and read as a plain 200 it fell
  // through to the claim gate or to "sign in again".
  const p = await CodarPlugin()
  const r = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign": { body: { code: "account_restricted", message: "API access is restricted." } },
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(r.outcome, "failed")
  assert.match(r.message, /account_restricted/)
  assert.doesNotMatch(r.message, /重新登录/)
  // the shapes the catch reads are unchanged…
  assert.equal(restricted({ code: "account_restricted" }), true)
  assert.equal(restricted({ message: "account_restricted" }), true)
  // …and so is the vendor's measured sentence when a gateway drops the code:
  // it names the API's access, not some other door.
  assert.equal(restricted({ message: "API access is restricted. Please contact support." }), true)
  // …but a bare "access is restricted" from some other endpoint is not it:
  // the card would send the user past the sign-in step to support.
  assert.equal(restricted({ message: "Access is restricted to administrators" }), false)
})

test("the already-claimed wording needs the claim said with the window", () => {
  // The window and a claim verb are not enough together: a maintenance note
  // ("claiming can resume in 24 hours") and a pause ("sign-in paused within 24 hours") both mention the
  // window near a verb without saying the day is claimed. What the vendor
  // says is the qualifier (only/must/must be) or the "once".
  assert.equal(ALREADY_CLAIMED.test("claiming can resume in 24 hours"), false, "a window followed by an unrelated 领取 is not a claim")
  assert.equal(ALREADY_CLAIMED.test("sign-in paused within 24 hours"), false, "nor is a pause said with the window")
  assert.equal(ALREADY_CLAIMED.test("24小时内可领取一次"), true, "the once-in-the-window wording still is")
  assert.equal(ALREADY_CLAIMED.test("24小时内只能领取一次"), true)
})

test("a body-code refusal names the wait it carries", async () => {
  // HTTP 200 with a business 429/503 in the body: the Retry-After header path
  // already put the wait on the card, but the body's own retry_after was only
  // read for the "already claimed" pair. A rate-limited check-in now says how
  // long to wait instead of looking like a broken account.
  const p = await CodarPlugin()
  const read = (body) =>
    withFetch(
      {
        "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
        "/v1/daily-sign": { body },
      },
      async () => p.auth.checkin(auth),
    )
  const limited = await read({ code: 429, message: "请求过于频繁", data: { retry_after: 45 } })
  assert.equal(limited.outcome, "failed")
  assert.match(limited.message, /请求过于频繁/)
  assert.match(limited.message, /45 秒后可重试/)
  const busy = await read({ code: 503, data: { retry_after: 600 } })
  assert.match(busy.message, /10 分钟后可重试/)
})

test("a success word has to be a success word", async () => {
  // "unsuccessful" and "not successful" carry the letters/characters of success without
  // saying it. Read as a claim they settled the day at zero points.
  const p = await CodarPlugin()
  const read = (body) =>
    withFetch(
      {
        "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
        "/v1/daily-sign": { body },
      },
      async () => p.auth.checkin(auth),
    )
  for (const message of ["签到不成功，请稍后重试", "签到未能成功", "签到没能成功", "领取无法成功", "操作不能成功", "not successful", "The check-in was not successful", "not success", "did not succeed", "unsuccessful", "claim failed"]) {
    const r = await read({ message })
    assert.equal(r.outcome, "failed", `${message} is not a claim`)
  }
  const ok = await read({ message: "领取成功" })
  assert.equal(ok.outcome, "claimed", "the vendor's own wording still is")
  const english = await read({ message: "Sign-in successful" })
  assert.equal(english.outcome, "claimed", "and so is the English word, with its suffix")
})

test("the shape rules cut credentials and leave prose alone", () => {
  // A key that is not a JWT (an sk- key, a `key=value` assignment, a
  // `codar_access_…` string) is cut by its shape; ordinary words that merely
  // share letters are not.
  for (const [text, credential] of [
    ["bad key sk-abcdefghijklmnopqrstuvwx", /sk-abcdefghijklmnopqrstuvwx/],
    ["api_key=abcdef1234567890", /abcdef1234567890/],
    ["token codar_access_abcdefghijklmnop12345", /codar_access_abcdefghijklmnop12345/],
    ["token 0123456789abcdef0123456789abcdef", /0123456789abcdef0123456789abcdef/],
    ["token 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", /9f86d081/],
  ]) {
    assert.doesNotMatch(scrubLine(text, ""), credential, `${text} is cut`)
  }
  for (const text of [
    "skateboardingcompetition is fun",
    "secretariatplanningcommittee met",
    "secretary-general-of-the-united-nations spoke",
    "Bearer authentication failed",
    "sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "md5 0123456789abcdef0123456789abcdef",
    "sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "SHA-256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  ]) {
    assert.equal(scrubLine(text, ""), text, `${text} is not a credential`)
  }
  // a known key folded with a control character is cut by the key it is
  assert.equal(scrubLine("bad co​dar_access_abcdef here", "codar_access_abcdef"), "bad … here")
})

test("the models hook survives a provider it cannot read", async () => {
  // `{ auth } = {}` throws on an explicit null, and a models table that came
  // back as an array (the shape a host once persisted) has no entries to hand
  // back: both are "nothing given", not a throw that takes the whole provider
  // list down.
  const p = await CodarPlugin()
  const bare = await p.provider.models(null, null)
  assert.deepEqual(bare, {}, "an explicit null on both sides is an empty answer, not a throw")
  const list = { "/v1/codar/models": { body: { data: [{ id: "x", protocol: { type: "openai_chat_completions" } }] } } }
  const viaArray = await withFetch(list, async () => p.provider.models({ models: [{ id: "y" }] }, { auth: await auth() }))
  assert.ok(viaArray.x, "an array is not a models table, and the vendor's list is still read")
  assert.equal(viaArray.y, undefined, "and the array's entries are not handed back as models")
  const nullProvider = await withFetch(list, async () => p.provider.models(null, { auth: await auth() }))
  assert.ok(nullProvider.x, "a provider with no models table still gets the vendor's list")
})

test("the generator reads the config the way the sign-in does, and refuses what it refuses", async () => {
  // The gates before the request (BOM, an account name, an expiry) were
  // added where the sign-in already had them; without a test, deleting any of
  // them leaves the suite green while the generator fetches with a token the
  // sign-in would have refused.
  const { mkdtempSync } = await import("node:fs")
  const root = mkdtempSync(join(tmpdir(), "codar-gen-"))
  const okBody = { code: 200, data: [{ id: "m", protocol: { type: "openai_chat_completions" }, context_window: 1 }] }
  const run = async (config, fetchImpl) => {
    writeFileSync(join(root, "config.json"), config)
    const logs = []
    const exit = await main({
      argv: ["node", "scripts/catalog.mjs"],
      env: { CODAR_HOME: root },
      out: join(root, "catalog.mjs"),
      fetchImpl: fetchImpl ?? (async () => new Response(JSON.stringify(okBody), { status: 200 })),
      log: { log: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) },
    })
    return { exit, logs }
  }
  try {
    const now = Math.floor(Date.now() / 1000)
    const good = JSON.stringify({ provider: { speedai: { token: mkToken({ username: "user_1", exp: now + 86400 }) } } })
    // a config written on Windows may carry a BOM; the sign-in reads it, so
    // must this script, or the two disagree about the same file
    const bom = await run("﻿" + good)
    assert.equal(bom.exit, 0, `a BOM config is read, not called corrupt: ${JSON.stringify(bom.logs)}`)
    // a token that names no account cannot fetch a list either
    const noName = await run(JSON.stringify({ provider: { speedai: { token: mkToken({ exp: now + 86400 }) } } }))
    assert.equal(noName.exit, 2)
    assert.ok(noName.logs.some((l) => l.includes("account name")), "and says why")
    // nor can one that has run out
    const lapsed = await run(JSON.stringify({ provider: { speedai: { token: mkToken({ username: "user_1", exp: now - 60 }) } } }))
    assert.equal(lapsed.exit, 2)
    assert.ok(lapsed.logs.some((l) => l.includes("expired")), "and says to open the app")
    // the request carries an abort signal: a vendor that accepts the
    // connection and never answers must not hang the script
    let signal
    const timed = await run(good, async (_u, init) => {
      signal = init.signal
      return new Response(JSON.stringify(okBody), { status: 200 })
    })
    assert.equal(timed.exit, 0)
    assert.ok(signal instanceof AbortSignal, "the fetch was given an AbortSignal")
    assert.equal(signal.aborted, false, "which has not fired")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the embedded catalog still carries the shapes the suite builds on", () => {
  // The suite derives its fixture ids from the catalog; when a regeneration
  // drops the last model of a kind, the failure should be this sentence
  // rather than `undefined.id` at import time.
  assert.ok(CATALOG.some((m) => m.protocol === "anthropic_messages"), "an Anthropic-wire model is in catalog.mjs")
  assert.ok(
    CATALOG.some((m) => m.protocol === "openai_chat_completions" && m.input?.includes("image")),
    "a chat model that takes images is in catalog.mjs",
  )
})

test("a key folded into a message is cut however it is held together", () => {
  // A server that quotes a credential back may wrap it at a space or fold an
  // invisible character into it. The fold used to be recognised only when a
  // control character was present, so a token wrapped at a plain space stayed
  // on the card; and the tolerant pattern built from a long key could grow
  // past what V8 will compile, with the key in the error text.
  // a key the shape rules cannot see: no JWT head, no digit, both halves
  // short — only the folded walk can find this one
  const key = "Zx9AccessTokenABCDEFGHIJKLMNOPQRSTUV"
  const cases = [
    key.slice(0, 12) + "\u0020" + key.slice(12),
    key.slice(0, 12) + "​" + key.slice(12),
    key.slice(0, 12) + "\n" + key.slice(12),
    key.slice(0, 12) + "　" + key.slice(12),
    key.slice(0, 12) + "\u00a0" + key.slice(12),
    key.slice(0, 12) + "\u0001" + key.slice(12),
    key.slice(0, 12) + "\u009f" + key.slice(12),
    // invisible separators outside the old hand-written list: a token folded
    // at any of them used to pass the message and the committed catalog whole
    key.slice(0, 12) + "\u180e" + key.slice(12),
    key.slice(0, 12) + "\u206f" + key.slice(12),
    key.slice(0, 12) + "\ufe0f" + key.slice(12),
    key.slice(0, 12) + "\u3164" + key.slice(12),
    key.slice(0, 12) + "\u034f" + key.slice(12),
    key.slice(0, 12) + "\u115f" + key.slice(12),
    key.slice(0, 12) + "\u2800" + key.slice(12),
  ]
  for (const folded of cases) {
    const out = scrubLine(`bad ${folded} here`, key)
    assert.doesNotMatch(out, /Zx9AccessTok/, `folded key is cut: ${JSON.stringify(out)}`)
  }
  // a very long key is not compiled into a pattern at all: the answer is a
  // string, and no long stretch of the key is on it
  const big = "eyJ" + "Ab9_".repeat(1800)
  const line = scrubLine(`bad ${big.slice(0, 10)}\u000b${big.slice(10)}`, big)
  assert.equal(typeof line, "string")
  assert.ok(!line.includes(big.slice(0, 40)), `no key stretch survives: ${line.slice(0, 40)}`)
})

test("a sign-in that is already claimed may arrive as HTTP 400", async () => {
  // request() throws on a non-2xx before the check-in reads the body, so a
  // vendor answering 400 "Already signed today" was read as a failure with no
  // until — and magpie re-asked every 30 minutes while the card said failed.
  const p = await CodarPlugin()
  const read = (answer) =>
    withFetch({ "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } }, "/v1/daily-sign": answer }, async () => p.auth.checkin(auth))
  const english = await read({ status: 400, body: { code: 400, message: "Already signed today" } })
  assert.equal(english.outcome, "done")
  assert.ok(english.until > Date.now(), "and it carries until, so the host does not re-ask")
  const withWait = await read({ status: 400, body: { code: 400, data: { retry_after: 3600 } } })
  assert.equal(withWait.outcome, "done")
  assert.match(withWait.message, /1 小时后可再领/)
  const refusal = await read({ status: 400, body: { code: 400, message: "请求有误" } })
  assert.equal(refusal.outcome, "failed", "a plain 400 is still a failure")
  assert.match(refusal.message, /请求有误/)
})

test("account_restricted is named on the card whatever code shape carries it", async () => {
  // pointsOf checked the word code only inside its numeric-code branch, so a
  // 200 body carrying account_restricted fell through to "no balance in the
  // answer" — or, with the agent balance readable, to a card that said
  // nothing at all about the restriction.
  const p = await CodarPlugin()
  const refused = () => new Response(JSON.stringify({ code: "account_restricted", message: "API access is restricted." }), { status: 200, headers: { "Content-Type": "application/json" } })
  const u = await withFetch(
    { "/v1/gettoken": refused, "/v1/agent/balance": refused, "/v1/daily-sign/status": refused, "/api/codar/activities/mine": refused },
    async () => p.auth.usage(auth),
  )
  assert.match(u.error, /account_restricted/)
  assert.doesNotMatch(u.error, /没有返回余额/)
  assert.notEqual(u.signIn, "expired")
  // the agent endpoint alone may carry the word code: the general read works
  // (so the card is drawn at all), and only /v1/agent/balance refuses. With
  // the same refusal on both, the general branch answered first and the
  // agent-only return was never reached; and an `!u2.error ||` spelling let
  // an undefined error pass.
  const u2 = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500 } },
      "/v1/agent/balance": { body: { code: "account_restricted" } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: false } } },
      "/api/codar/activities/mine": { body: { code: 200, data: [] } },
    },
    async () => p.auth.usage(auth),
  )
  assert.ok(u2.error, "the agent-only restriction is the card's answer, not an empty card")
  assert.match(u2.error, /account_restricted/, `the restriction is named: ${JSON.stringify(u2.error)}`)
  assert.equal(u2.signIn, "", "a restriction is not a lapsed sign-in")
})

test("the generator refuses an unknown argument and names no home directory", async () => {
  // `--chek` was ignored, so a read-only check the user meant ran the default
  // write over catalog.mjs; and a file-system error quotes the absolute path
  // it failed on, which put the home directory into the message next to its
  // shortened form.
  const { mkdtempSync, existsSync } = await import("node:fs")
  const root = mkdtempSync(join(tmpdir(), "codar-gen-"))
  const out = join(root, "catalog.mjs")
  const now = Math.floor(Date.now() / 1000)
  writeFileSync(join(root, "config.json"), JSON.stringify({ provider: { speedai: { token: mkToken({ username: "user_1", exp: now + 86400 }) } } }))
  const okBody = { code: 200, data: [{ id: "m", protocol: { type: "openai_chat_completions" }, context_window: 1 }] }
  const run = (argv, where = out) => {
    const logs = []
    return main({
      argv,
      env: { CODAR_HOME: root },
      out: where,
      fetchImpl: async () => new Response(JSON.stringify(okBody), { status: 200 }),
      log: { log: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) },
    }).then((exit) => ({ exit, logs }))
  }
  try {
    const typo = await run(["node", "scripts/catalog.mjs", "--chek"])
    assert.equal(typo.exit, 2)
    assert.match(typo.logs.join(" "), /unrecognized argument/)
    assert.equal(existsSync(out), false, "a typo does not write the file")
    // a write into a directory that does not exist: the error is shortened
    const home = homedir()
    const bad = join(home, "codar-gen-absent-dir-probe", "catalog.mjs")
    const failed = await run(["node", "scripts/catalog.mjs"], bad)
    assert.equal(failed.exit, 2)
    assert.ok(failed.logs.join(" ").includes("~"), "the path is shortened")
    assert.ok(!failed.logs.join(" ").includes(home), `no home directory in the message: ${failed.logs.join(" ")}`)
    // the budget passed in is what aborts a vendor that never answers
    const started = Date.now()
    const slow = await main({
      argv: ["node", "scripts/catalog.mjs"],
      env: { CODAR_HOME: root },
      out: join(root, "never.mjs"),
      timeoutMs: 60,
      fetchImpl: (_u, init) =>
        new Promise((_res, rej) => {
          const keep = setTimeout(() => {}, 5000)
          init.signal.addEventListener("abort", () => {
            clearTimeout(keep)
            rej(new DOMException("aborted", "TimeoutError"))
          })
        }),
      log: { log: () => {}, error: () => {} },
    })
    assert.equal(slow, 2)
    assert.ok(Date.now() - started < 5000, "the run ends on its own budget, not the vendor's")
    // a credential echoed in a catalog field is not written to the file
    const token = mkToken({ username: "user_1", exp: now + 86400 })
    const echoed = { code: 200, data: [{ id: "m", display_name: `x${token}`, context_window: 1 }] }
    const file = join(root, "echoed.mjs")
    const exit = await main({
      argv: ["node", "scripts/catalog.mjs"],
      env: { CODAR_HOME: root },
      out: file,
      fetchImpl: async () => new Response(JSON.stringify(echoed), { status: 200 }),
      log: { log: () => {}, error: () => {} },
    })
    assert.equal(exit, 0)
    const written = (await import("node:fs")).readFileSync(file, "utf8")
    assert.ok(!written.includes(token), "the token is not in the committed file")
    assert.ok(!written.includes(token.split(".")[1]), "nor its payload segment")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a folded key that straddles the card's cut is still cut", () => {
  // The folding walk and its stripped-copy check used to stop exactly at
  // MAX_SCRUB_CHARS: a key starting a few characters before the cut and folded
  // one separator per character was invisible to both, and the half that
  // survived the slice that follows reached the message — the generator's log
  // included. The scope now reaches past the cut by the key's doubled length.
  const key = "Zx9AccessTokenABCDEFGHIJKLMNOPQRSTUV"
  const folded = [...key].join("\u180e")
  // The leak is the folded form, so the check reads the output with the
  // separators taken out: a contiguous prefix is not what survives \u2014 a run of
  // the key's own characters with an invisible character between each is.
  const bare = (s) => s.replace(/[\s\p{Cf}\p{Mn}\u115f\u1160\u3164\uffa0\u2800]/gu, "")
  for (const start of [MAX_SCRUB_CHARS - 5, MAX_SCRUB_CHARS - 60, MAX_SCRUB_CHARS - 2 * key.length]) {
    const out = bare(scrubLine("x".repeat(start) + folded + "tail", key))
    for (let n = 12; n <= key.length; n++) {
      assert.equal(out.includes(key.slice(0, n)), false, `no ${n}-character prefix of the key survives (start ${start})`)
    }
  }
})

test("the gate quotes every character cmd.exe acts on", async () => {
  // A temp path is allowed to contain an ampersand: cmd.exe splits the line
  // there, so the path was quoted only when it carried a space and a `&` went
  // through unquoted. Space is one of several characters the shell acts on.
  assert.equal(quoteArg("/tmp/a b", true), '"/tmp/a b"', "a space")
  assert.equal(quoteArg("C:\\Temp&x\\codar-tarball-1", true), '"C:\\Temp&x\\codar-tarball-1"', "an ampersand")
  assert.equal(quoteArg("a|b", true), '"a|b"', "a pipe")
  assert.equal(quoteArg("a<b>c^d(e)", true), '"a<b>c^d(e)"', "redirection, caret and parentheses")
  assert.equal(quoteArg('a"b', true), '"a""b"', "an embedded quote is doubled")
  assert.equal(quoteArg("C:\\Temp&x", false), "C:\\Temp&x", "POSIX passes arguments untouched")
})

test("a missing Bun is a skip, and --require-bun makes it exit 2", { skip: process.platform === "win32" || Boolean(process.env.CODAR_TARBALL_GATE), timeout: 120000 }, async () => {
  // Two different answers: a machine without Bun simply skips that half, and a
  // release run that requires Bun has not run the check at all — 2 ("could not
  // run here"), not 1 ("the packed suite failed"). The old code answered 1 for
  // both because a shell 127 never carried ENOENT.
  const { existsSync, mkdtempSync, rmSync } = await import("node:fs")
  const { spawnSync } = await import("node:child_process")
  const { fileURLToPath } = await import("node:url")
  const dirs = (process.env.PATH || "").split(":").filter((d) => d && !existsSync(join(d, "bun")))
  const env = { ...process.env, PATH: dirs.join(":") }
  const here = fileURLToPath(new URL("..", import.meta.url))
  const optional = spawnSync(process.execPath, [join(here, "scripts", "tarball.mjs")], { env, encoding: "utf8", timeout: 110000 })
  assert.equal(optional.status, 0, `a missing Bun is a skip: ${optional.stdout}${optional.stderr}`)
  assert.match(optional.stdout + optional.stderr, /skipped/)
  const required = spawnSync(process.execPath, [join(here, "scripts", "tarball.mjs"), "--require-bun"], { env, encoding: "utf8", timeout: 110000 })
  assert.equal(required.status, 2, `a required Bun that is missing is "could not run": ${required.stdout}${required.stderr}`)
})

test("the tarball gate refuses an argument it does not know", async () => {
  // A misspelt --require-bun used to be ignored, and the Bun half of the gate
  // was silently skipped on a release run. The gate now answers unknown
  // arguments the way the catalog generator does, so a release script that
  // meant to force Bun cannot mistake the skip for a pass.
  const { spawnSync } = await import("node:child_process")
  const { fileURLToPath } = await import("node:url")
  const here = fileURLToPath(new URL("..", import.meta.url))
  const run = spawnSync(process.execPath, [join(here, "scripts", "tarball.mjs"), "--require-bunn"], { encoding: "utf8" })
  assert.equal(run.status, 2, "an unknown argument to the gate is exit 2, not 0")
  assert.match(run.stderr + run.stdout, /unrecognized argument/)
})

test("a failed write leaves the catalog file as it was", async (t) => {
  // The write used to open catalog.mjs with 'w' — a write that failed partway
  // (ENOSPC, an interrupted run) left a truncated file the plugin imports and
  // the suite parses, and the next run anywhere failed over our own write. It
  // now writes a sibling temporary path and renames into place, so a failure
  // touches nothing the plugin reads. The sibling's name is random and
  // created exclusively: the failure is injected by making the directory
  // refuse a new file, which is what a read-only checkout looks like.
  const seeded = 'export const CATALOG = [\n  { "id": "kept", "name": "Kept", "context": 1, "maxOutput": 0, "input": ["text"], "output": ["text"], "protocol": "openai_chat_completions", "reasoning": false }\n]\n'
  const body = { code: 200, data: [{ id: "new", display_name: "New", context_window: 1000 }] }
  const { chmodSync } = await import("node:fs")
  const { dirname } = await import("node:path")
  // A directory that refuses a create is the whole mechanism; root ignores
  // the mode bits, and Windows does not have them, so the case is skipped
  // where it cannot be set up rather than passing without exercising it.
  const probe = await genRun({ body, seeded, onReady: (p) => chmodSync(dirname(p), 0o555), onDone: (p) => chmodSync(dirname(p), 0o755) })
  if (probe.exit === 0) {
    t.skip("this user can create files in a directory marked read-only")
    return
  }
  assert.equal(probe.exit, 2, "a write that cannot complete is exit 2")
  assert.equal(probe.after, seeded, "and the catalog file is exactly what it was")
  assert.match(probe.logs.join("\n"), /cannot write/)
  assert.deepEqual(probe.siblings.filter((n) => n.endsWith(".tmp")), [], "no temporary file is left behind")
})

test("a temporary file another process pre-created is not written through", async (t) => {
  // The temporary name used to be `<out>.<pid>.tmp`: another process in the
  // same directory could create that path as a symlink to a file it wanted
  // overwritten, the write followed it, and the rename then put the symlink
  // at catalog.mjs's own name. The name now carries random bytes and is
  // created exclusively, so the old predictable path is never touched.
  const { symlinkSync, lstatSync } = await import("node:fs")
  const { dirname } = await import("node:path")
  const seeded = 'export const CATALOG = []\n'
  const body = { code: 200, data: [{ id: "new", display_name: "New", context_window: 1000 }] }
  let victim = ""
  let victimText
  let outWasLink
  const run = await genRun({
    body,
    seeded,
    onReady: (p) => {
      victim = join(dirname(p), "victim.txt")
      writeFileSync(victim, "sentinel")
      symlinkSync(victim, `${p}.${process.pid}.tmp`)
    },
    onDone: (p) => {
      victimText = readFileSync(victim, "utf8")
      outWasLink = lstatSync(p).isSymbolicLink()
    },
  })
  if (run.exit === 2 && /cannot write/.test(run.logs.join("\n"))) {
    t.skip("this platform would not create the symlink the case needs")
    return
  }
  assert.equal(run.exit, 0, `the generator ran: ${run.logs.join("\n")}`)
  assert.equal(victimText, "sentinel", "the pre-created link's target received nothing")
  assert.equal(outWasLink, false, "and the catalog is a real file, not the link")
})

test("the tarball gate fails on a Bun that runs and fails", { skip: process.platform === "win32" || Boolean(process.env.CODAR_TARBALL_GATE), timeout: 120000 }, async () => {
  // The gate skipped every Bun failure, not just a missing Bun: a suite that
  // failed inside the tarball was reported as "skipped" and the gate exited
  // 0. It now tells the two apart.
  const { mkdtempSync, chmodSync } = await import("node:fs")
  const { spawnSync } = await import("node:child_process")
  const { fileURLToPath } = await import("node:url")
  const bin = mkdtempSync(join(tmpdir(), "codar-fakebin-"))
  try {
    writeFileSync(join(bin, "bun"), "#!/bin/sh\necho fake bun: a test failed\nexit 1\n")
    chmodSync(join(bin, "bun"), 0o755)
    const here = fileURLToPath(new URL("..", import.meta.url))
    // The install check needs a build and a minute; this test is about the
    // Bun half, and the gate already ran when the suite is inside the tarball.
    const run = spawnSync(process.execPath, [join(here, "scripts", "tarball.mjs")], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODAR_TARBALL_GATE: "1" },
      encoding: "utf8",
      timeout: 110000,
    })
    assert.equal(run.status, 1, `a failing Bun is an error: ${run.stdout}${run.stderr}`)
    assert.match(run.stdout + run.stderr, /bun test failed inside the packed tarball/)
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
})

test("a vendor that sends headers and then goes quiet cannot hang the generator", { timeout: 15000 }, async () => {
  // AbortSignal.timeout only stops the response headers from hanging. A body
  // that never ends would hold readAnswer for ever, so the read is raced
  // against the same budget.
  const { mkdtempSync } = await import("node:fs")
  const root = mkdtempSync(join(tmpdir(), "codar-gen-"))
  const now = Math.floor(Date.now() / 1000)
  writeFileSync(join(root, "config.json"), JSON.stringify({ provider: { speedai: { token: mkToken({ username: "user_1", exp: now + 86400 }) } } }))
  try {
    const started = Date.now()
    const exit = await main({
      argv: ["node", "scripts/catalog.mjs"],
      env: { CODAR_HOME: root },
      out: join(root, "never.mjs"),
      timeoutMs: 80,
      fetchImpl: async () => new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "Content-Type": "application/json" } }),
      log: { log: () => {}, error: () => {} },
    })
    assert.equal(exit, 2)
    assert.ok(Date.now() - started < 5000, `the run ends on its own budget: ${Date.now() - started} ms`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a refusal that says it failed is not re-read as already claimed by its wait", async () => {
  // A 400 beside a readable retry_after is the "already claimed" pair, but the
  // vendor also answers 400 with a rate limit or a risk-control notice, and
  // those name a wait too. Words that say failed win over the pair: reported
  // as done, the day was settled and the next question pushed past the wait,
  // with the failure never on the card.
  const p = await CodarPlugin()
  const read = (answer) => withFetch({ "/v1/gettoken": { body: { code: 200, token: 1, agent_token: 0 } }, "/v1/daily-sign": answer }, async () => p.auth.checkin(auth))
  for (const [label, answer] of [
    ["a 200 body", { body: { code: 400, message: "签到失败，请稍后重试", data: { retry_after: 3600 } } }],
    ["an HTTP 400", { status: 400, body: { code: 400, message: "触发风控，请稍后再试", data: { retry_after: 600 } } }],
  ]) {
    const r = await read(answer)
    assert.equal(r.outcome, "failed", `${label} names a failure, not a claim`)
    assert.match(r.message, /失败|风控/)
    assert.match(r.message, /可重试/, `${label} still says when to try again: ${r.message}`)
  }
  // a 400 whose English words negate success is not the pair either, and its
  // wait still reaches the card
  const negated = await read({ status: 400, body: { code: 400, message: "Check-in didn't succeed", data: { retry_after: 600 } } })
  assert.equal(negated.outcome, "failed", "a negated success word is not a claim")
  assert.match(negated.message, /10 分钟后可重试/, `its wait is still said: ${negated.message}`)
  // and a 400 with a wait but no words is no claim either
  const bare = await read({ status: 400, body: { message: "slow down", data: { retry_after: 60 } } })
  assert.equal(bare.outcome, "failed")
  assert.match(bare.message, /1 分钟后可重试/)
})

// ---- wording and reader rules a full-dimension review found unread ----------

test("the day's statement wins over the attempt's when it comes first", async () => {
  // "Already signed successfully today" names the window and the outcome of
  // some earlier claim; reading the success word first made it this attempt's
  // claim, so the card reported a credit of 0 over a day that was settled.
// the vendor's words is the other order: this attempt's claim
  // with the rule appended, and the credit is real.
  const p = await CodarPlugin()
  const read = (body, points) =>
    withFetch(
      {
        "/v1/gettoken": { body: points ?? { code: 200, token: 100, agent_token: 0 } },
        "/v1/daily-sign": { body },
      },
      async () => p.auth.checkin(auth),
    )
  const day = await read({ code: 200, message: "Already signed successfully today" })
  assert.equal(day.outcome, "done", "the window's statement, not this attempt's claim")
  // the same word about a sign-in somewhere else is not the day's statement:
  // 200 is this call's own success, not a day settled on another device
  const elsewhere = await read({ code: 200, message: "Already signed in on another device" })
  assert.equal(elsewhere.outcome, "claimed", "a login elsewhere did not settle the day")
  const claim = await read({ code: 200, message: "领取成功，24小时内仅可领取一次" }, { code: 200, token: 500, agent_token: 0 })
  assert.equal(claim.outcome, "claimed", "this attempt did land")
})

test("a said-claimed day that is then negated is not read as claimed", async () => {
  // A sentence
  // that negates it — "not already claimed", or a question answered "No, not
  // yet" — says the opposite, and reading it as done settled a day that was
  // never claimed.
  const p = await CodarPlugin()
  const read = (message) =>
    withFetch(
      { "/v1/gettoken": { body: { code: 200, token: 100, agent_token: 0 } }, "/v1/daily-sign": { body: { code: 200, message } } },
      async () => p.auth.checkin(auth),
    )
  for (const message of ["You have not already claimed today", "Already signed today? No, not yet"]) {
    const r = await read(message)
    // failed, not merely "not done": the sentence denies the day and carries
    // no positive signal of its own.
    assert.equal(r.outcome, "failed", `${message} does not say the day is claimed`)
  }
})

test("a comma does not carry a negation onto the success word", async () => {
  // "No errors, check-in successful" is a success with an aside; the veto's
  // pre-negation window crossed a comma, so the "No" reached "successful" and
  // the day was reported as failed.
  const p = await CodarPlugin()
  const r = await withFetch(
    { "/v1/gettoken": { body: { code: 200, token: 100, agent_token: 0 } }, "/v1/daily-sign": { body: { message: "No errors, check-in successful" } } },
    async () => p.auth.checkin(auth),
  )
  assert.equal(r.outcome, "claimed", "a comma ends the veto window")
})

test("a negation in one language vetoes a success word in the other", async () => {
// the vendor's words is a negation the veto did not know: it read the
  // Chinese success word, saw no Chinese negator, and settled the day.
  const p = await CodarPlugin()
  const r = await withFetch(
    { "/v1/gettoken": { body: { code: 200, token: 100, agent_token: 0 } }, "/v1/daily-sign": { body: { message: "check-in not 成功" } } },
    async () => p.auth.checkin(auth),
  )
  assert.equal(r.outcome, "failed", "an English negation vetoes 成功")
})

test("成功率 is not a success word, and the failure words the veto was missing are read", async () => {

  // landed; beside a failure word the answer is a failure. And the veto knew

  // built from those settled the day as claimed.
  const p = await CodarPlugin()
  const read = (answer) =>
    withFetch({ "/v1/gettoken": { body: { code: 200, token: 100, agent_token: 0 } }, "/v1/daily-sign": answer }, async () => p.auth.checkin(auth))
  for (const [label, answer] of [
    ["成功率 beside 失败", { body: { code: 200, message: "签到失败，成功率 0%" } }],
    ["不可用 with a wait", { body: { code: 400, message: "签到暂不可用", data: { retry_after: 60 } } }],
    ["系统错误", { body: { code: 200, message: "系统错误，请稍后重试" } }],
    ["rate limited", { body: { code: 200, message: "rate limited, please try later" } }],
    ["service not available", { body: { code: 200, message: "service not available now" } }],
  ]) {
    const r = await read(answer)
    assert.equal(r.outcome, "failed", `${label} is not a claim`)
  }

// the vendor's words says nothing about this attempt, and reading the

  const rate = await read({ body: { message: "今日签到成功率 100%" } })
  assert.equal(rate.outcome, "failed", "成功率 is not the success word")

  // not fire on the denial that contains them.
  const clean = await read({ body: { message: "签到成功，无错误" } })
  assert.equal(clean.outcome, "claimed", "no errors is not an error")
})

test("a success flag spelled as the string \"false\" is a refusal", async () => {
  // A JSON API may spell the flag "false"/0/"no"; read as the boolean false
  // only, {success:"false", code:200} was a claim.
  const p = await CodarPlugin()
  const r = await withFetch(
    { "/v1/gettoken": { body: { code: 200, token: 100, agent_token: 0 } }, "/v1/daily-sign": { body: { code: 200, success: "false", message: "boom" } } },
    async () => p.auth.checkin(auth),
  )
  assert.equal(r.outcome, "failed", "the string \"false\" is a refusal flag too")
})

test("a wait the gateway stated on a 2xx answer still reaches the card", async () => {
  // request() surfaced Retry-After only on a non-2xx answer; a 200 whose
  // *business* code refuses (429/503 in the body) lost the header's wait and
  // the card said nothing about when to try again.
  const p = await CodarPlugin()
  const r = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 100, agent_token: 0 } },
      "/v1/daily-sign": () => new Response(JSON.stringify({ code: 429, message: "too many requests" }), { status: 200, headers: { "retry-after": "120" } }),
    },
    async () => p.auth.checkin(auth),
  )
  assert.equal(r.outcome, "failed")
  assert.match(r.message, /2 分钟后可重试/, `the header's wait is said: ${r.message}`)
})

test("a Retry-After is read only when it is a number or an HTTP date, and never clamped", () => {
  const { headerWaitOf } = testables
  assert.equal(retryAfterOf("3600"), 3600)
  assert.equal(retryAfterOf("604800"), 604800, "exactly a week is still a wait the day can name")
  assert.equal(retryAfterOf("604801"), 0, "past a week is not a wait this day can produce, not a clamped week")
  assert.equal(retryAfterOf("3600.5"), 0, "a fractional value is not a number of seconds and is not a date")
  assert.equal(retryAfterOf("tomorrow"), 0, "a word is neither")
  assert.equal(retryAfterOf("0"), 0)
  const minute = retryAfterOf(new Date(Date.now() + 60_000).toUTCString())
  assert.ok(minute >= 55 && minute <= 60, `an HTTP date is the wait it names: ${minute}`)
  assert.equal(retryAfterOf(String(Date.now() + 60_000)), 0, "a bare epoch number is seconds, and far past a week")
  assert.equal(typeof headerWaitOf, "function")
})

test("saidNo reads the refusal flag in the spellings a JSON API uses", () => {
  const { saidNo } = testables
  for (const v of [false, 0, "false", "False", "0", "no", " no "]) assert.equal(saidNo(v), true, `${JSON.stringify(v)} is a refusal`)
  for (const v of [true, 1, "true", "", null, undefined, {}, [], "ok", "no way"]) assert.equal(saidNo(v), false, `${JSON.stringify(v)} is not`)
})

test("a business code is a word, wherever the vendor put it, and a number is not one", () => {
  assert.equal(errorCodeOf({ error: { code: "account_restricted" } }), "account_restricted", "error.code is read")
  assert.equal(errorCodeOf({ code: "401" }), "", "a numeric code is not a business code word")
  assert.equal(errorCodeOf({ detail: { code: "account_restricted" } }), "account_restricted")
  assert.equal(errorCodeOf({ data: { error: { code: "account_restricted" } } }), "account_restricted", "data.error.code is read")
  assert.equal(errorCodeOf({ data: { code: "rate_limited" } }), "rate_limited")
  assert.equal(restricted({ error: { code: "account_restricted" } }), true, "restricted reads error.code too")
})

test("a balance read that says success:false is a refusal, not a balance of 0", async () => {
  const p = await CodarPlugin()
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, success: false, token: 100 } },
      "/v1/agent/balance": { body: { code: 200, success: false, balance: 5 } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true } } },
      "/api/codar/activities/mine": { body: { code: 200, data: [] } },
    },
    async () => p.auth.usage(auth),
  )
  assert.ok(u.error, "an explicit refusal is an error card, not a balance")
  assert.equal(u.windows, undefined, "and nothing is drawn from it")
})

test("the agent balance is not read out of a refusal that echoes one", async () => {
  // gettoken answers general points; /v1/agent/balance is a second read and
  // may refuse with success:false while still echoing a stale balance. Read

  const p = await CodarPlugin()
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 300, agent_token: null } },
      "/v1/agent/balance": { body: { code: 200, success: false, balance: 5 } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true } } },
      "/api/codar/activities/mine": { body: { code: 200, data: [] } },
    },
    async () => p.auth.usage(auth),
  )
  assert.equal(u.error, undefined)
  assert.ok(u.windows.some((w) => w.name === "点数余额"), "the general balance is still drawn")
  assert.ok(!String(u.balance ?? "").includes("Agent 5"), `the refused agent balance is not on the card: ${u.balance}`)
  assert.ok(!u.windows.some((w) => w.balance === 5), "nor in a window")
})

test("a catalog refusal stated in the nested code, or as success:false, is no list", () => {
  const rows = [{ id: "m", display_name: "M", context_window: 1000, protocol: { type: "openai_chat_completions" } }]
  assert.equal(catalogOf({ catalog: { code: 500, data: rows } }), null, "a nested refusal is a refusal")
  assert.equal(catalogOf({ success: false, data: rows }), null, "an explicit refusal is a refusal")
  assert.equal(catalogOf({ code: 200, data: [] })?.length, 0, "an empty list the vendor answered is still an answer")
})

test("an activity read that says success:false is no activity", () => {
  const now = Math.floor(Date.now() / 1000)
  assert.deepEqual(runningActivities({ success: false, data: [{ free_until: now + 3600, remaining_quota: null, model_ids: ["a"] }] }), [])
})

test("a protocol the vendor states as a bare string is read", () => {
  assert.equal(protocolOf({ protocol: "openai_responses" }), "openai_responses", "a string protocol is read, not defaulted to chat")
  assert.equal(protocolOf({ protocol: { type: "anthropic_messages" } }), "anthropic_messages")
  assert.equal(protocolOf({}), "openai_chat_completions")
  assert.equal(protocolOf({ protocol: "something_else" }), "", "a protocol this host cannot serve is not chat")
})

test("a token count past what a context window can be is not a size to plan for", () => {
  assert.equal(modelOf({ id: "m", context: 1e15 }).limit.context, 0, "1e15 is not a window")
  assert.equal(modelOf({ id: "m", context: 2_000_000 }).limit.context, 2_000_000, "a real window survives")
})

test("a credential folded with a mark the fold walk did not know is still cut", () => {
  // U+20DD (combining enclosing circle) is neither \s nor a control; the shape
  // pass allowed \s between segments only, so a token folded with it passed
  // through whole. With no key to cut by (a getAuth that threw), the shape
  // rules are the only defence.
  const mark = String.fromCharCode(0x20dd)
  const folded = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0" + mark + ".c2lnbmF0dXJlLWhlcmU"
  const out = scrubLine(`the server said ${folded} back`, "")
  assert.ok(!out.includes("eyJzdWIi"), `the folded token is cut: ${out}`)
  assert.ok(!out.includes("c2lnbmF0dXJl"), `and so is the half after the mark: ${out}`)
})

test("a key folded many separators per character near the cut is still cut", () => {
  // The walk's scope reached only two separators per key character past the
  // card's cut; a server that folds three leaves the tail of the key outside
  // that window. The stripped-copy fallback now looks at the whole text.
  const key = "abcdefghijklmnopqrstuvwxyz0123456789"
  const folded = key.split("").join("   ")
  const text = "x".repeat(MAX_SCRUB_CHARS - 4) + folded
  // cutKey, not scrubLine: scrubLine cuts to the card's length first, which
  // hides the tail of the key from the assertion as well as from the card.
  const out = cutKey(text, key)
  assert.ok(!out.includes(folded) && !out.includes(key), "the folded key does not survive")
})

test("--check never prints the token, even out of the old catalog file", async () => {
  // The old file's values are printed as they were written. A catalog
  // regenerated before the token cut existed would put the credential in the
  // terminal and in CI logs; the diff line is cut by the key.
  const key = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
  const seeded = render([
    { id: "m", name: `old ${key}`, context: 1000, maxOutput: 0, input: ["text"], output: ["text"], protocol: "openai_chat_completions", reasoning: false },
  ])
  const { exit, logs } = await genRun({
    body: { code: 200, data: [{ id: "m", display_name: "new", context_window: 2000 }] },
    seeded,
    argv: ["--check"],
    token: key,
  })
  assert.equal(exit, 1, "the record moved")
  assert.ok(logs.some((l) => l.startsWith("changed:")), "the moved record is named")
  assert.ok(!logs.join("\n").includes(key), "the token is cut out of the old value")
})

test("a token split across two fields stops the generator instead of reaching the file", async () => {
  // The cut is by the key, so neither half matches it; only the last gate —
  // every 32-character window of the token, looked for in each string the
  // file is built from — sees the two pieces for what they are.
  const key = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
  const half = Math.floor(key.length / 2)
  const { exit, after, logs } = await genRun({
    body: {
      code: 200,
      data: [
        { id: "a", display_name: key.slice(0, half), context_window: 1000 },
        { id: "b", display_name: key.slice(half), context_window: 1000 },
      ],
    },
    token: key,
  })
  assert.equal(exit, 2, "a leak we cannot cut is a failed run, not a written file")
  assert.equal(after, null, "nothing is written")
  assert.match(logs.join("\n"), /part of the account token/)
})

test("a config that is not a regular file fails the sign-in and the generator alike", async () => {
  // A directory where the config belongs: readFileSync would answer EISDIR,
  // but a FIFO would block it for ever. statSync refuses a non-regular file
  // before it is opened, and both readers say the same thing.
  const { mkdirSync, mkdtempSync } = await import("node:fs")
  const root = mkdtempSync(join(tmpdir(), "codar-cfg-"))
  mkdirSync(join(root, "config.json"))
  try {
    const asDir = appToken(join(root, "config.json"))
    assert.match(asDir.error, /读不了/, "the sign-in says it could not read it")
    assert.doesNotMatch(asDir.error, /先在这台机器上登录/, "and does not send them to sign in again")
    const outPath = join(root, "catalog.mjs")
    const logs = []
    const exit = await main({ argv: ["node", "scripts/catalog.mjs"], env: { CODAR_HOME: root }, out: outPath, log: { log: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) } })
    assert.equal(exit, 2, "the generator cannot read a directory as a config")
    assert.ok(!existsSync(outPath), "and writes nothing")
    assert.match(logs.join("\n"), /not a regular file/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the contract fields magpie reads are all there", async () => {
  // host.js reads auth.provider, provider.id, each method's type, and the
  // package's main/exports. None of them was pinned: a rename of any one
  // would leave the suite green and the plugin unloadable (or its models
  // filed under the wrong provider).
  const p = await CodarPlugin()
  assert.equal(p.auth.provider, "codar", "auth is filed under the provider id")
  assert.equal(p.provider.id, "codar", "the provider names itself")
  assert.equal(typeof p.auth.loader, "function", "the loader is the one place the key is read")
  assert.ok(p.auth.methods.length >= 1)
  // api methods carry the key; the phone-and-SMS one is an oauth method whose
  // page the host opens (host.js's authorize), so both types are expected.
  for (const m of p.auth.methods) assert.ok(["api", "oauth"].includes(m.type), `sign-in method ${m.label} has a type the host reads`)
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  assert.equal(pkg.main, "./index.mjs", "the host loads the package by main")
  assert.equal(pkg.exports, "./index.mjs", "and by exports")
  assert.ok(pkg.files.includes("index.mjs") && pkg.files.includes("lib/internal.mjs") && pkg.files.includes("lib/catalog.mjs"), "the entry and the modules it loads ship")
  assert.match(pkg.engines.node, />=\s*20/, "the runtime the plugin claims is stated")
})

test("a model record that echoes the account's own token is not served", async () => {
  // The vendor's answer is data, and a hostile or compromised gateway can put
  // the account's token in an id or a name. The id is dropped when it changes
  // under the cut; a name is cut and kept.
  const p = await CodarPlugin()
  const body = {
    code: 200,
    data: [
      { id: `model-${TOKEN}`, display_name: "Leak", context_window: 1000 },
      { id: "clean", display_name: `name ${TOKEN}`, context_window: 1000 },
    ],
  }
  const models = await withFetch({ "/v1/codar/models": { body } }, async () => p.provider.models({ models: {} }, { auth: { type: "api", key: TOKEN } }))
  assert.ok(!Object.hasOwn(models, `model-${TOKEN}`), "an id carrying the token is not served")
  assert.ok(!Object.hasOwn(models, "model-…"), "and the record is dropped, not renamed to an id no request can ask for")
  assert.deepEqual(Object.keys(models), ["clean"], "only the clean record is served")
  assert.ok(!JSON.stringify(models).includes(TOKEN), "and the token is cut out of its name")
})

test("a restriction or expiry on the second balance read is the account's answer", async () => {
  // The agent balance is the other half of the same account. When the first
  // read failed, a restriction or expiry there used to be swallowed and the
  // card reported the first read's error while the account was actually
  // restricted or signed out; a restriction is the answer even when the first
  // read worked.
  const p = await CodarPlugin()
  const routes = (agent, points = { code: 200, token: 300, agent_token: null }) => ({
    "/v1/gettoken": () => new Response(JSON.stringify(points), { status: 200 }),
    "/v1/agent/balance": agent,
    "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true } } },
    "/api/codar/activities/mine": { body: { code: 200, data: [] } },
  })
  const restricted = () => new Response(JSON.stringify({ detail: { code: "account_restricted", message: "API access is restricted" } }), { status: 403 })
  const failedFirst = await withFetch(routes(restricted, { detail: "boom" }), async () => p.auth.usage(auth))
  assert.match(failedFirst.error ?? "", /account_restricted/, "the restriction is said, not the first read's error")
  const expired = () => new Response(JSON.stringify({ code: 401, message: "Invalid token" }), { status: 200 })
  const signedOutRead = await withFetch(routes(expired, { detail: "boom" }), async () => p.auth.usage(auth))
  assert.equal(signedOutRead.signIn, "expired", "an expiry on the second read asks for a sign-in")
  const stillRestricted = await withFetch(routes(restricted), async () => p.auth.usage(auth))
  assert.match(stillRestricted.error ?? "", /account_restricted/, "and a restriction is said even when the first read worked")
})

test("a status read that says success:false draws no row, whatever it echoes", async () => {
  const p = await CodarPlugin()
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 300, agent_token: 0 } },
      "/v1/agent/balance": { body: { data: { agent_balance: 0 } } },
      "/v1/daily-sign/status": { body: { success: false, data: { isSigned: true, retry_after: 60 } } },
      "/api/codar/activities/mine": { body: { code: 200, data: [] } },
    },
    async () => p.auth.usage(auth),
  )
  assert.ok(!u.windows.some((w) => w.name === "每日签到"), "a refused status is no state")
})

test("the gate's missing npm and tar are exit 2, and a % is quoted", async () => {
  // % is not a quoting case: cmd.exe expands %NAME% even inside quotes, and
  // the gate refuses such an argument instead (see shellSafe).
  // a PATH with no npm: the gate cannot pack, which is "could not run here"
  const { mkdtempSync, rmSync } = await import("node:fs")
  const { spawnSync } = await import("node:child_process")
  const { fileURLToPath } = await import("node:url")
  const empty = mkdtempSync(join(tmpdir(), "codar-nonpm-"))
  try {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/tarball.mjs", import.meta.url))], {
      env: { PATH: empty, HOME: empty, TMPDIR: empty, SystemRoot: process.env.SystemRoot ?? "" },
      encoding: "utf8",
    })
    assert.equal(r.status, 2, `a missing npm is "could not run here": ${r.stdout}${r.stderr}`)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test("a card line stays within the 400 code points the card reads, wait included", async () => {
  // scrub() caps the vendor's part at 400, and the wait was appended after
  // that — a long refusal beside a wait came out past the cap, on both the
  // 2xx-business-refusal path and the HTTP-error path.
  const p = await CodarPlugin()
  const long = "x".repeat(500)
  const read = (answer) =>
    withFetch({ "/v1/gettoken": { body: { code: 200, token: 100, agent_token: 0 } }, "/v1/daily-sign": answer }, async () => p.auth.checkin(auth))
  const body = await read({ body: { code: 429, message: long, data: { retry_after: 60 } } })
  assert.equal(body.outcome, "failed")
  assert.ok(body.message.length <= 400, `the wait fits inside the cap: ${body.message.length}`)
  assert.match(body.message, /1 分钟后可重试/, "and the wait is still said")
  // a failure word keeps the 400-beside-a-wait pair from settling the day
  const http = await read({ status: 400, body: { code: 400, message: long + "失败", data: { retry_after: 60 } } })
  assert.ok(http.message.length <= 400, `the HTTP path is capped too: ${http.message.length}`)
  assert.match(http.message, /1 分钟后可重试/)
})

test("a token split into short pieces still stops the generator", async () => {
  // The gate looked for 32-character windows of the token, so a gateway that
  // split it into four 25-character fields carried every piece into the
  // committed file while the gate stayed quiet. The windows are 12 characters
  // now, checked at every position.
  const key = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
  const pieces = key.match(/.{1,25}/g)
  assert.ok(pieces.length >= 4, "the fixture splits into at least four pieces")
  const { exit, after, logs } = await genRun({
    body: { code: 200, data: pieces.map((p, i) => ({ id: `m${i}`, display_name: p, context_window: 1000 })) },
    token: key,
  })
  assert.equal(exit, 2, "a leak we cannot cut is a failed run")
  assert.equal(after, null, "nothing is written")
  assert.match(logs.join("\n"), /part of the account token/)
})

test("a token after a long name is cut before the name is truncated", async () => {
  // cleanText truncates a name to 120 characters; the token used to be cut
  // after that, so 80 characters of prose plus a token left the token's
  // 40-character prefix in the model list.
  const p = await CodarPlugin()
  const body = { code: 200, data: [{ id: "m", display_name: "x".repeat(80) + TOKEN, context_window: 1000 }] }
  const models = await withFetch({ "/v1/codar/models": { body } }, async () => p.provider.models({ models: {} }, { auth: { type: "api", key: TOKEN } }))
  assert.ok(models.m, "the record is still served")
  assert.ok(!JSON.stringify(models).includes(TOKEN.slice(0, 40)), "no fragment of the token survives")
  // A name carrying any part of the token is not served at all: it falls back
  // to its id, so nothing of the vendor's prose is left beside a cut.
  assert.equal(models.m.name, "m", "the name falls back to the id")
})

test("a config past the size cap is refused by both readers", async () => {
  const { mkdtempSync, writeFileSync: write } = await import("node:fs")
  const root = mkdtempSync(join(tmpdir(), "codar-big-"))
  try {
    const file = join(root, "config.json")
    write(file, JSON.stringify({ provider: { speedai: { token: TOKEN } }, pad: "x".repeat(1_100_000) }))
    const got = appToken(file)
    assert.match(got.error, /读不了|太大/, "the sign-in says it cannot read it")
    const outPath = join(root, "catalog.mjs")
    const logs = []
    const exit = await main({ argv: ["node", "scripts/catalog.mjs"], env: { CODAR_HOME: root }, out: outPath, log: { log: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) } })
    assert.equal(exit, 2, "and the generator refuses it the same way")
    assert.match(logs.join("\n"), /larger than 1 MiB/)
    assert.ok(!existsSync(outPath), "nothing is written")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a % in an argument is refused through the Windows shell", async () => {
  const { shellSafe } = await import("../scripts/tarball.mjs")
  assert.throws(() => shellSafe(["C:\\Temp%TEMP%\\x"], true), (e) => e.exitCode === 2, "cmd.exe would expand it; exit 2")
  assert.doesNotThrow(() => shellSafe(["C:\\Temp%TEMP%\\x"], false), "POSIX passes it untouched")
})

test("an expired second read is not the account's answer when the first read worked", async () => {
  // The first balance read proves the token; a 401 from the second endpoint
  // is that endpoint's refusal, not an expired sign-in. The card still draws
  // the general balance and leaves the agent figure unspecified.
  const p = await CodarPlugin()
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 300, agent_token: null } },
      "/v1/agent/balance": () => new Response(JSON.stringify({ code: 401, message: "Invalid token" }), { status: 200 }),
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true } } },
      "/api/codar/activities/mine": { body: { code: 200, data: [] } },
    },
    async () => p.auth.usage(auth),
  )
  assert.equal(u.error, undefined, "the card is still drawn")
  assert.equal(u.signIn, undefined, "and does not claim the sign-in expired")
  assert.ok(u.windows.some((w) => w.name === "点数余额"), "the general balance is drawn")
})

test("the shell guard is on the run path, not only on its helper", async () => {
  // shellSafe alone being correct does not stop run() from calling cmd.exe
  // with a %-carrying path; the guard has to sit on the path every command
  // takes.
  const { run } = await import("../scripts/tarball.mjs")
  // a program that exists: with the guard removed, `anything` failed anyway
  // (ENOENT is also exit 2), so the test could not tell the guard from a
  // missing binary. A real program would be spawned and the call would not
  // throw.
  assert.throws(() => run(process.execPath, ["a%b"], { throughShell: true }), (e) => e.exitCode === 2, "the guard runs before the spawn")
})

test("a denied claim is not settled by a wait, a success flag, or a bare 200", async () => {
  // The negation rule has to gate every road to a settled day: the wording,
  // the 400-beside-a-wait pair on both paths, and a bare code:200.
  const p = await CodarPlugin()
  const read = (answer) =>
    withFetch({ "/v1/gettoken": { body: { code: 200, token: 100, agent_token: 0 } }, "/v1/daily-sign": answer }, async () => p.auth.checkin(auth))
  const deny = "Already signed today? No, not yet"
  for (const [label, answer] of [
    ["a 2xx body beside a wait", { body: { code: 400, message: deny, data: { retry_after: 3600 } } }],
    ["an HTTP 400 beside a wait", { status: 400, body: { code: 400, message: deny, data: { retry_after: 3600 } } }],
    ["a bare code 200", { body: { code: 200, message: deny } }],
    ["a success flag", { body: { code: 200, success: true, message: deny, data: { retry_after: 3600 } } }],
  ]) {
    const r = await read(answer)
    assert.equal(r.outcome, "failed", `${label} is not a claim`)
  }
  // an explicit success:false still beats the 400-beside-a-wait pair after the
  // request threw
  const refused = await read({ status: 400, body: { code: 400, success: false, message: "请稍后再试", data: { retry_after: 60 } } })
  assert.equal(refused.outcome, "failed", "success:false wins over the pair")
})

test("a dash ends the aside after a success word, and a next-sentence No must deny", async () => {
  const p = await CodarPlugin()
  const read = (answer) =>
    withFetch({ "/v1/gettoken": { body: { code: 200, token: 100, agent_token: 0 } }, "/v1/daily-sign": answer }, async () => p.auth.checkin(auth))
  for (const message of ["Check-in successful - no points were added", "Check-in successful — no points were added"]) {
    const r = await read({ body: { code: 200, message } })
    assert.equal(r.outcome, "claimed", `${message} is a claim with an aside`)
  }
  const done = await read({ body: { code: 400, message: "Already signed today. No further action needed." } })
  assert.equal(done.outcome, "done", "a following sentence that does not deny the state is not a negation")
})

test("a token split into pieces shorter than the window still stops the generator", async () => {
  // cutKey sees no folded separators and each field is shorter than one
  // window; only reassembling the pieces — each record's own strings, and
  // each property's strings across the answer — finds the token in order.
  const key = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
  const pieces = key.match(/.{1,11}/g)
  assert.ok(pieces.length >= 8, "the fixture splits into many short pieces")
  const { exit, after, logs } = await genRun({
    body: { code: 200, data: pieces.map((p, i) => ({ id: `m${i}`, display_name: p, context_window: 1000 })) },
    token: key,
  })
  assert.equal(exit, 2, "the reassembled token is a leak we cannot cut")
  assert.equal(after, null, "nothing is written")
  assert.match(logs.join("\n"), /part of the account token/)
})

test("a refused answer is reported by its status, not as a failed fetch", async () => {
  // The body used to be read before res.ok, so on a runtime whose stream
  // throws for a non-2xx status the run said "could not be read ... this is a
  // failed fetch" over a vendor that simply refused.
  const { mkdtempSync, writeFileSync: write } = await import("node:fs")
  const root = mkdtempSync(join(tmpdir(), "codar-refused-"))
  write(join(root, "config.json"), JSON.stringify({ provider: { speedai: { token: mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 }) } } }))
  const bodies = []
  const exit = await main({
    argv: ["node", "scripts/catalog.mjs"],
    env: { CODAR_HOME: root },
    out: join(root, "catalog.mjs"),
    log: { log: (m) => bodies.push(String(m)), error: (m) => bodies.push(String(m)) },
    fetchImpl: async () => new Response(new ReadableStream({ start(c) { c.error(new Error("stream refused")) } }), { status: 500 }),
  })
  rmSync(root, { recursive: true, force: true })
  assert.equal(exit, 2)
  assert.match(bodies.join("\n"), /HTTP 500/, `the status is said: ${bodies.join(" | ")}`)
  assert.doesNotMatch(bodies.join("\n"), /could not be read/, "not a failed fetch")
})

test("a catalog refusal stated on the nested catalog, or wrapped in data, is no list", () => {
  const rows = [{ id: "m", display_name: "M", context_window: 1000, protocol: { type: "openai_chat_completions" } }]
  assert.equal(catalogOf({ catalog: { success: false, data: rows } }), null, "catalog.success:false is a refusal")
  // a wrapped refusal names its code inside `data`, which is then not a list
  // at all: the array check refuses it before any gate on the code.
  assert.equal(catalogOf({ code: 200, data: { code: "503", message: "maintenance", data: rows } }), null, "a wrapped refusal is not a list")
  assert.equal(catalogOf({ data: { code: 503, data: rows } }), null, "same, without a top-level code")
  assert.equal(catalogOf({ data: rows })?.length, 1, "a plain list is still read")
})

test("a protocol named with a non-string type is not read as chat", () => {
  assert.equal(protocolOf({ protocol: { type: 1 } }), "", "a named but unreadable type is not chat")
  assert.equal(protocolOf({ protocol: { type: {} } }), "")
  assert.equal(protocolOf({ protocol: 1 }), "")
  assert.equal(protocolOf({ protocol: {} }), "openai_chat_completions", "an empty object states none")
  assert.equal(protocolOf({}), "openai_chat_completions")
})

test("an activity id longer than the card's clean cannot leak the token's head", async () => {
  // cleanText truncates a vendor string to 120 characters, and the token used
  // to be cut after that: a 134-character token left 120 of its characters on
  // the card. The raw id is cut first now, and only the two ids a window names
  // are cleaned at all.
  const token = mkToken({ username: "user_1", sub: "x".repeat(120), exp: Math.floor(Date.now() / 1000) + 86400 })
  assert.ok(token.length > 120, "the fixture token is past the clean's cut")
  const p = await CodarPlugin()
  const until = Math.floor(Date.now() / 1000) + 3600
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 300, agent_token: 0 } },
      "/v1/agent/balance": { body: { data: { agent_balance: 0 } } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true } } },
      "/api/codar/activities/mine": {
        body: { code: 200, data: [{ free_until: until, remaining_quota: null, model_ids: [LISTED_ID, token, "third", "fourth"] }] },
      },
    },
    async () => p.auth.usage(async () => ({ type: "api", key: token })),
  )
  for (const n of [12, 40, 120, token.length]) assert.ok(!u.windows.some((w) => (w.name ?? "").includes(token.slice(0, n))), `no ${n}-character prefix of the token reaches the card`)
  const name = u.windows.find((w) => w.name?.startsWith("免费模型"))?.name ?? ""
  assert.ok(name.includes(`免费模型 · ${LISTED_ID}`), "the real ids are named")
  assert.match(name, /等 4 个/, "and the count is of the vendor's own list")
  assert.doesNotMatch(name, /third/, "only the two a window can show are spelled out")
})

test("a restriction spelled only in the words beside a 403 is not an expiry", async () => {
  // The 401/403 branch used to discard the vendor's words, so a restriction
  // written in `message` said "sign in again" and marked the account expired.
  const p = await CodarPlugin()
  const u = await withFetch(
    {
      "/v1/gettoken": () => new Response(JSON.stringify({ code: 403, message: "api access is restricted for this account" }), { status: 200 }),
      "/v1/agent/balance": { body: { data: { agent_balance: 0 } } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true } } },
      "/api/codar/activities/mine": { body: { code: 200, data: [] } },
    },
    async () => p.auth.usage(auth),
  )
  assert.match(u.error ?? "", /受限/, "the restriction is said")
  assert.equal(u.signIn, "", "and magpie does not mark it expired")
})

test("the separator normalization spares ordinary prose with combining marks", () => {
  const text = "खाता नहीं मिला: कृपया पुनः प्रयास करें"
  assert.equal(scrubLine(text, ""), text, "a message in Devanagari survives unchanged")
  const thai = "ไม่พบบัญชี กรุณาลองใหม่"
  assert.equal(scrubLine(thai, ""), thai, "and Thai")
  assert.equal(scrubLine("café closed", ""), "café closed", "a decomposed accent is kept")
  // ... while a credential folded at a mark is still reassembled for the cut
  const folded = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0" + String.fromCharCode(0x20dd) + ".c2lnbmF0dXJlLWhlcmU"
  const out = scrubLine(`the server said ${folded} back`, "")
  assert.ok(!out.includes("c2lnbmF0dXJl"), `the folded token is still cut: ${out}`)
})

test("a claim that states the next window carries until, like the day's answer", async () => {
  // The README promises the check-in answer carries until so magpie re-asks
  // exactly when the next claim opens; the claimed branch used to drop the
  // seconds the vendor stated beside the success.
  const p = await CodarPlugin()
  const before = Date.now()
  const r = await withFetch(
    { "/v1/gettoken": { body: { code: 200, token: 100, agent_token: 0 } }, "/v1/daily-sign": { body: { code: 200, message: "领取成功", data: { retry_after: 86400 } } } },
    async () => p.auth.checkin(auth),
  )
  assert.equal(r.outcome, "claimed")
  assert.ok(r.until >= before + 86_400_000 - 5_000 && r.until <= Date.now() + 86_400_000, `until is the stated window: ${r.until}`)
  // and a claim that states no window carries none rather than a made-up one
  const bare = await withFetch(
    { "/v1/gettoken": { body: { code: 200, token: 100, agent_token: 0 } }, "/v1/daily-sign": { body: { code: 200, message: "领取成功" } } },
    async () => p.auth.checkin(auth),
  )
  assert.equal(bare.until, undefined, "no window stated, none invented")
})

test("the check-in answer's keys are the ones the host reads", async () => {
  // host.js's checkinOf keeps outcome, credit, streak, message and until; a
  // rename of any one of them would leave the suite green.
  const p = await CodarPlugin()
  const r = await withFetch(
    { "/v1/gettoken": { body: { code: 200, token: 100, agent_token: 0 } }, "/v1/daily-sign": { body: { code: 200, message: "领取成功", data: { retry_after: 3600 } } } },
    async () => p.auth.checkin(auth),
  )
  for (const key of Object.keys(r)) assert.ok(["outcome", "credit", "streak", "message", "until"].includes(key), `unknown key ${key}`)
  assert.ok(["claimed", "done", "failed"].includes(r.outcome))
  assert.equal(typeof r.message, "string")
})

test("the body's wait wins over the header's, on both the 2xx and the error path", async () => {
  // Both waits are read; when both are present the business layer's own
  // number is the one stated. Nothing pinned the precedence, so a swap went
  // unnoticed.
  const p = await CodarPlugin()
  const read = (answer) =>
    withFetch({ "/v1/gettoken": { body: { code: 200, token: 100, agent_token: 0 } }, "/v1/daily-sign": answer }, async () => p.auth.checkin(auth))
  // withFetch serves an answer object through the JSON path (which drops
  // custom headers), so the header form is a Response-returning function.
  const withHeader = (status, payload) => () =>
    new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json", "retry-after": "3600" } })
  const body = await read(withHeader(200, { code: 429, message: "too many requests", data: { retry_after: 60 } }))
  assert.equal(body.outcome, "failed")
  assert.match(body.message, /1 分钟后可重试/, `the body's wait is stated: ${body.message}`)
  assert.doesNotMatch(body.message, /1 小时/, "not the header's")
  const http = await read(withHeader(429, { code: 429, message: "触发风控", data: { retry_after: 120 } }))
  assert.match(http.message, /2 分钟后可重试/, `and on the error path too: ${http.message}`)
})

test("an already-claimed statement is read whatever code the error carried", async () => {
  // claimStated counts 400, 200 and "no code"; every test used 400.
  const p = await CodarPlugin()
  const read = (answer) =>
    withFetch({ "/v1/gettoken": { body: { code: 200, token: 100, agent_token: 0 } }, "/v1/daily-sign": answer }, async () => p.auth.checkin(auth))
  for (const [label, answer] of [
    ["a 200 business code", { status: 500, body: { code: 200, message: "24小时内仅可领取一次", data: { retry_after: 3600 } } }],
    ["no code at all", { status: 503, body: { message: "24小时内仅可领取一次", data: { retry_after: 3600 } } }],
  ]) {
    const r = await read(answer)
    assert.equal(r.outcome, "done", `${label} still names the day's claim`)
    assert.ok(r.until > Date.now(), "with the wait it stated")
  }
  const failed = await read({ status: 500, body: { code: 500, message: "24小时内仅可领取一次", data: { retry_after: 3600 } } })
  assert.equal(failed.outcome, "failed", "a 500 quoting the words is a server failure, not the day's claim")
})

test("the card's cap counts code points, not UTF-16 units", async () => {
  // A message of CJK beside a wait: cutting by .length would keep half again
  // as many characters as the card reads.
  const p = await CodarPlugin()
  const long = "签到失败，请稍后重试。".repeat(60)
  const r = await withFetch(
    { "/v1/gettoken": { body: { code: 200, token: 100, agent_token: 0 } }, "/v1/daily-sign": { body: { code: 429, message: long, data: { retry_after: 60 } } } },
    async () => p.auth.checkin(auth),
  )
  assert.ok([...r.message].length <= 400, `the card reads at most 400 code points: ${[...r.message].length}`)
  assert.match(r.message, /1 分钟后可重试/)
})

test("an activity with a huge model_ids list costs the card no more than it shows", async () => {
  // Only the two ids a window names are cleaned; the rest is counted. Without
  // the bound the whole array was cleaned and cut, linearly in a vendor-huge
  // answer.
  const p = await CodarPlugin()
  const ids = Array.from({ length: 200_000 }, (_, i) => `model-${i}`)
  const until = Math.floor(Date.now() / 1000) + 3600
  const started = Date.now()
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 300, agent_token: 0 } },
      "/v1/agent/balance": { body: { data: { agent_balance: 0 } } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true } } },
      "/api/codar/activities/mine": { body: { code: 200, data: [{ free_until: until, remaining_quota: null, model_ids: ids }] } },
    },
    async () => p.auth.usage(auth),
  )
  const name = u.windows.find((w) => w.name?.startsWith("免费模型"))?.name ?? ""
  assert.match(name, /免费模型 · model-0、model-1 等 200000 个/, `only what a window shows: ${name}`)
  assert.ok(Date.now() - started < 5000, "and the hook stays well inside its budget")
})

test("scrubbing an 8 MB answer stays linear", async () => {
  // The whole-text key cut is what bounds the leak; a bound on its cost keeps
  // a future change from making it quadratic.
  const big = "lorem ipsum dolor sit amet ".repeat(300_000)
  const started = Date.now()
  scrubLine(big, TOKEN)
  assert.ok(Date.now() - started < 5000, `8 MB stays linear: ${Date.now() - started} ms`)
})

test("a vendor model named __proto__ never becomes the model map's prototype", async () => {
  // The live hook's noMagicKeys is the sibling of the config hook's, covered
  // only by reading until now.
  const p = await CodarPlugin()
  const body = { code: 200, data: [{ id: "__proto__", display_name: "Proto", context_window: 1000 }, { id: "ok", display_name: "OK", context_window: 1000 }] }
  const models = await withFetch({ "/v1/codar/models": { body } }, async () => p.provider.models({ models: {} }, { auth: { type: "api", key: TOKEN } }))
  assert.equal({}.polluted, undefined, "the prototype is untouched")
  assert.ok(Object.hasOwn(models, "ok"), "the real record is there")
  assert.ok(!Object.hasOwn(models, "__proto__"), "and the magic key is not an own key the host would assign through")
  assert.equal(Object.getPrototypeOf(models), Object.prototype, "the map is a plain object")
})

test("a pack that writes no tarball is exit 2, not a failed suite", async () => {
  const { tarballOf } = await import("../scripts/tarball.mjs")
  const { mkdtempSync } = await import("node:fs")
  const dir = mkdtempSync(join(tmpdir(), "codar-notgz-"))
  try {
    assert.throws(() => tarballOf(dir), (e) => e.exitCode === 2, "nothing to run is ask-again")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("English success rate is not a success word either", async () => {

  // matched "success rate", and a code-less answer saying only that was read
  // as a claim.
  const p = await CodarPlugin()
  for (const message of ["Check-in success rate 95%", "Your success rate is low"]) {
    const r = await withFetch({ "/v1/gettoken": { body: { code: 200, token: 100, agent_token: 0 } }, "/v1/daily-sign": { body: { message } } }, async () => p.auth.checkin(auth))
    assert.equal(r.outcome, "failed", `${message} says nothing about this attempt`)
  }
})

test("the Chinese 'today already signed' wordings are the day claimed", async () => {

  // (it is a claim) nor none of the window wordings, so the day was reported
  // as a fresh claim and the credit was read off a settled day.
  const p = await CodarPlugin()
  for (const message of ["今日已签到", "已经签到过了", "今日已领取", "已签到，请勿重复签到", "每天限领一次"]) {
    const r = await withFetch({ "/v1/gettoken": { body: { code: 200, token: 100, agent_token: 0 } }, "/v1/daily-sign": { body: { message } } }, async () => p.auth.checkin(auth))
    assert.equal(r.outcome, "done", `${message} is the day already claimed`)
  }
  // a past day's statement is not today's: only a day qualifier or the
// the vendor's words form settles the day
  const yesterday = await withFetch({ "/v1/gettoken": { body: { code: 200, token: 100, agent_token: 0 } }, "/v1/daily-sign": { body: { code: 200, message: "昨日已签到" } } }, async () => p.auth.checkin(auth))
  assert.equal(yesterday.outcome, "claimed", "yesterday's claim is not today's")
})

test("the next-sentence denial must deny the state, not merely open with 'not yet'", async () => {

  // there is no other problem: both are notes after a statement of the day,
  // and reading them as denials made a settled day a failure.
  const p = await CodarPlugin()
  const read = (message) =>
    withFetch({ "/v1/gettoken": { body: { code: 200, token: 100, agent_token: 0 } }, "/v1/daily-sign": { body: { code: 400, message, data: { retry_after: 3600 } } } }, async () => p.auth.checkin(auth))
  for (const message of ["Already signed today. Not yet credited.", "24小时内仅可领取一次。没有其他问题"]) {
    const r = await read(message)
    assert.equal(r.outcome, "done", `${message} is the day claimed with a note, not a denial`)
  }
})

test("'no errors' is a denial in the English spellings the veto reads", async () => {
  // The failure word after a success word ("successful without errors") was
  // read as a veto: the denial list knew the Chinese forms and "No errors" at
  // the front only.
  const p = await CodarPlugin()
  for (const message of ["Check-in succeeded with no errors", "Check-in successful without errors", "签到成功，未发现异常", "签到成功，无任何异常"]) {
    const r = await withFetch({ "/v1/gettoken": { body: { code: 200, token: 100, agent_token: 0 } }, "/v1/daily-sign": { body: { code: 200, message } } }, async () => p.auth.checkin(auth))
    assert.equal(r.outcome, "claimed", `${message} is a success with a denial aside`)
  }
})

test("a top-level retry_after is the wait on the 2xx path too", async () => {
  // The HTTP-error path's message read the body's top-level retry_after;
  // the 2xx path decided `done` from data.retry_after and the header only,
  // so a claimed day with its wait at the top level fell to the 30-minute
  // shelf.
  const p = await CodarPlugin()
  const r = await withFetch({ "/v1/gettoken": { body: { code: 200, token: 100, agent_token: 0 } }, "/v1/daily-sign": { body: { code: 400, message: "24小时内仅可领取一次", retry_after: 82800 } } }, async () => p.auth.checkin(auth))
  assert.equal(r.outcome, "done")
  assert.ok(r.until - Date.now() > 20 * 3600 * 1000, `the 23 hours it stated reach the card: ${(r.until - Date.now()) / 1000}`)
  // the same statement on an HTTP refusal: the catch re-reads the body's wait
  // to decide the day and to report when it opens again.
  const failed = await withFetch({ "/v1/gettoken": { body: { code: 200, token: 100, agent_token: 0 } }, "/v1/daily-sign": () => new Response(JSON.stringify({ code: 400, message: "24小时内仅可领取一次", retry_after: 82800 }), { status: 500 }) }, async () => p.auth.checkin(auth))
  assert.equal(failed.outcome, "done")
  assert.ok(failed.until - Date.now() > 20 * 3600 * 1000, "the HTTP refusal's stated wait is the until too")
})

test("a 400 beside a wait whose words say failure is not the day claimed", async () => {
  // The 400-beside-a-wait pair was documented to need "no failure words"; the
  // words for a gateway or server failure were not among them, so "Internal
  // Server Error" next to a wait settled the day.
  const p = await CodarPlugin()
  for (const message of ["请稍后再试", "Internal Server Error", "<html>502 Bad Gateway</html>", "请求超时", "Bad Gateway"]) {
    const r = await withFetch({ "/v1/gettoken": { body: { code: 200, token: 100, agent_token: 0 } }, "/v1/daily-sign": { body: { code: 400, message, data: { retry_after: 300 } } } }, async () => p.auth.checkin(auth))
    assert.equal(r.outcome, "failed", `${message} is a failure with a wait`)
  }
})

test("this attempt's success beside a 400 is this attempt's claim", async () => {
// the vendor's words is a claim with the rule appended; the
  // numeric refusal gate ran before the success word and reported a failure
  // that cost the credit.
  const p = await CodarPlugin()
  const r = await withFetch({ "/v1/gettoken": { body: { code: 200, token: 100, agent_token: 0 } }, "/v1/daily-sign": { body: { code: 400, message: "领取成功，24小时内仅可领取一次" } } }, async () => p.auth.checkin(auth))
  assert.equal(r.outcome, "claimed", "the success word decides")
})

test("a refusal wrapped in data is a refusal on every reader", async () => {
  // {data:{code:401,…}} and {data:{success:false,…}} are the same statements
  // one level in; the gates ran on the envelope only and the balances were
// read out of the wrapper, so a refusal became the vendor's words.
  const p = await CodarPlugin()
  const read = (gettoken, agent = { code: 200, balance: 0 }) =>
    withFetch(
      { "/v1/gettoken": { body: gettoken }, "/v1/agent/balance": { body: agent }, "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: false } } }, "/api/codar/activities/mine": { body: { code: 200, data: [] } } },
      async () => p.auth.usage(auth),
    )
  const expired = await read({ data: { code: 401, message: "Invalid token", token: 0, agent_token: 0 } })
  assert.match(expired.error ?? "", /登录已过期/)
  const refused = await read({ data: { success: false, token: 0, agent_token: 0 } })
  assert.ok(!refused.windows.some((w) => w.name === "点数余额"), `success:false in the wrapper is not a 0 balance: ${JSON.stringify(refused)}`)
  assert.ok(!String(refused.balance ?? "").includes("0 点 ·"), "and no wallet row is drawn from it")
  const busy = await read({ data: { code: 500, message: "busy", token: 0 } }, { code: 200, balance: 7 })
  assert.equal(busy.balance, "Agent 7 点 可用", "the refused general read leaves the agent figure, not a 0")
  const agentRefused = await read({ code: 200, token: 300, agent_token: null }, { data: { code: 401, agent_balance: 0 } })
  assert.equal(agentRefused.balance, "300 点 可用", "a refused agent read is unspecified, not 0")
  const restricted = await read({ data: { error: { code: "account_restricted" }, token: 0, agent_token: 0 } })
  assert.match(restricted.error ?? "", /account_restricted/)
})

test("a status read wrapped in a refusal draws no check-in row, and neither does a wrapped refusal's activity list", async () => {
  const p = await CodarPlugin()
  const until = Math.floor(Date.now() / 1000) + 3600
  for (const status of [{ data: { code: 500, message: "busy", isSigned: false, retry_after: 3600 } }, { data: { success: false, isSigned: true } }]) {
    const u = await withFetch(
      {
        "/v1/gettoken": { body: { code: 200, token: 300, agent_token: 0 } },
        "/v1/agent/balance": { body: { code: 200, balance: 0 } },
        "/v1/daily-sign/status": { body: status },
        "/api/codar/activities/mine": { body: { code: 200, data: {} } },
      },
      async () => p.auth.usage(auth),
    )
    assert.ok(!u.windows.some((w) => w.name === "每日签到"), `a refused status draws no row: ${JSON.stringify(status)}`)
  }
  const u = await withFetch(
    { "/v1/gettoken": { body: { code: 200, token: 300, agent_token: 0 } }, "/api/codar/activities/mine": { body: { code: 200, data: { code: 503, message: "maintenance", data: [{ free_until: until, remaining_quota: null, model_ids: ["m"] }] } } } },
    async () => p.auth.usage(auth),
  )
  assert.ok(!u.windows.some((w) => w.name.startsWith("免费模型")), "a refusal's stale list is not running activities")
  // the reader itself, on a wrapped refusal that carries the stale list
  assert.deepEqual(runningActivities({ data: { code: 503, data: [{ free_until: until, remaining_quota: null, model_ids: ["m"] }] } }), [], "a wrapped refusal is no list")
  assert.deepEqual(runningActivities({ data: { success: false, data: [{ free_until: until, remaining_quota: null, model_ids: ["m"] }] } }), [], "and neither is its success:false")
})

test("--check folds a token wrapped with literal escapes in the old file", async () => {
  // wrapped every 12 characters: every run is under the shape rules' floors,
  // so only the literal-escape fold brings the pieces back together for them.
  const wrapped = TOKEN.replace(/(.{12})/g, "$1\\n")
  const seeded = render(sortRows([{ id: "x", name: wrapped, context: 1000, maxOutput: 0, input: ["text"], output: ["text"], protocol: "openai_chat_completions", reasoning: false }]))
  const { exit, logs } = await genRun({ body: { code: 200, data: [{ id: "x", display_name: "fresh", context_window: 1000 }] }, seeded, argv: ["--check"] })
  assert.equal(exit, 1)
  // The line is read as it reaches a terminal: literal escapes come off, and
  // then no 8-character window of the token may survive anywhere in it. With
  // the fold the whole credential is one shape match; without it, every piece
  // between the escapes stays.
  const unfolded = logs.join("\n").replace(/\\+[nrt]/g, " ")
  const flat = unfolded.replace(/\s+/g, "")
  let leaked = false
  for (let i = 0; i + 8 <= TOKEN.length; i++) if (flat.includes(TOKEN.slice(i, i + 8))) leaked = true
  assert.equal(leaked, false, `no window of the token survives: ${unfolded}`)
})

test("a string business code on the catalog is a refusal, live and in the generator", async () => {
  const rows = [{ id: "stale", display_name: "S", context_window: 1000 }]
  assert.equal(catalogOf({ code: "account_restricted", data: rows }), null, "a code in words is no list")
  assert.equal(catalogOf({ catalog: { code: "account_restricted", data: rows } }), null, "nor on the nested catalog")
  const p = await CodarPlugin()
  const models = await withFetch({ "/v1/codar/models": { body: { code: "account_restricted", data: rows } } }, async () => p.provider.models({ models: {} }, { auth: { type: "api", key: TOKEN } }))
  assert.equal(models[Symbol.for("magpie.fellBack")], true, "the live list falls back")
  assert.ok(!Object.hasOwn(models, "stale"))
  const write = await genRun({ body: { code: "account_restricted", data: rows } })
  assert.equal(write.exit, 2, "the generator refuses it as a read failure")
  assert.equal(write.after, null, "and writes nothing")
})

test("a name that is a piece of the token is not served, and an id is judged on its raw text", async () => {
  // A single field holding 20 characters of the token is shorter than any
  // reassembly and not the whole token: only the per-field fragment check
  // sees it. The id's check is on the raw id: cleaned != raw is the record's
  // own id needing repair, which drops it, not renames it.
  const piece = TOKEN.slice(5, 25)
  const p = await CodarPlugin()
  const models = await withFetch({ "/v1/codar/models": { body: { code: 200, data: [{ id: "m", display_name: piece, context_window: 1000 }] } } }, async () => p.provider.models({ models: {} }, { auth: { type: "api", key: TOKEN } }))
  assert.equal(models.m.name, "m", "a fragment is not a name, the id stands in")
  const dropped = catalogOf({ code: 200, data: [{ id: `model-${TOKEN}`, display_name: "L", context_window: 1000 }, { id: "ok", display_name: "OK", context_window: 1000 }] }, TOKEN)
  assert.deepEqual(dropped.map((r) => r.id), ["ok"], "an id the cut changes is dropped, the clean record stays")
  // the folded shape: no 8-character run of the token is contiguous, so only
  // the raw-id comparison sees that the cut renamed this id
  const folded = `m-${[...TOKEN].join(" ")}`
  const renamed = catalogOf({ code: 200, data: [{ id: folded, display_name: "F", context_window: 1000 }, { id: "ok", display_name: "OK", context_window: 1000 }] }, TOKEN)
  assert.deepEqual(renamed.map((r) => r.id), ["ok"], "an id the folded cut renames is dropped too")
})

test("a model name that reassembles this account's token is not served", async () => {
  // The whole-token cut sees nothing in a split; each field is still a long
  // run of the credential, and the fields next to each other are the token.
  const p = await CodarPlugin()
  const pieces = TOKEN.match(/.{1,20}/g)
  const body = { code: 200, data: pieces.map((piece, i) => ({ id: `safe-${i}`, display_name: piece, context_window: 1000 })) }
  const models = await withFetch({ "/v1/codar/models": { body } }, async () => p.provider.models({ models: {} }, { auth: { type: "api", key: TOKEN } }))
  assert.ok(!JSON.stringify(models).includes(TOKEN))
  const rebuilt = pieces.map((_, i) => models[`safe-${i}`]?.name).join(".")
  assert.notEqual(rebuilt, TOKEN, "the pieces do not reassemble the token")
  assert.equal(echoesKey(TOKEN.slice(10, 40), TOKEN), true, "and a run of the token is what echoesKey sees")
})

test("model ids split across the activity name do not carry the token onto the card", async () => {
  const p = await CodarPlugin()
  const half = Math.floor(TOKEN.length / 2)
  const until = Math.floor(Date.now() / 1000) + 3600
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 300, agent_token: 0 } },
      "/api/codar/activities/mine": { body: { code: 200, data: [{ free_until: until, remaining_quota: null, model_ids: [TOKEN.slice(0, half), TOKEN.slice(half)] }] } },
    },
    async () => p.auth.usage(auth),
  )
  const name = u.windows.find((w) => w.name.startsWith("免费模型"))?.name ?? ""
  assert.equal(name.replace(/^免费模型 · /, "").replace("、", ""), "……", `a fragment is not a model name: ${name}`)
})

test("the generator's leak gate catches eight-character pieces wherever they sit", async () => {
  // Pieces of exactly one eight-character window, alternating between id and
  // display_name with a numbered filler beside each: no two pieces are
  // adjacent in any order join, and each piece is one window.
  const key = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
  const chunks = key.match(/[\s\S]{1,8}/g).filter((c) => c.length === 8)
  const rows = chunks.map((piece, i) => (i % 2 === 0 ? { id: piece, display_name: `--part-${i}`, context_window: 1000 } : { id: `--part-${i}`, display_name: piece, context_window: 1000 }))
  const { exit, after } = await genRun({ body: { code: 200, data: rows }, token: key })
  assert.equal(exit, 2, "a piece of one window is still the token")
  assert.equal(after, null)
})

test("the generator's leak gate sees the order the committed file carries", async () => {
  // Pieces under one window, one per record, ids sorting in token order, the
  // vendor's array reversed: the vendor-order joins walk it backwards, and
  // only the file-order reassembly sees it.
  const key = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
  // pieces under one window: only two of them next to each other in the file
  // make a window, and the vendor's array runs backwards.
  const pieces = key.match(/[\s\S]{1,6}/g)
  const rows = pieces.map((p, i) => ({ id: `a${String(i).padStart(2, "0")}`, display_name: p, context_window: 1000 })).reverse()
  const { exit, after, logs } = await genRun({ body: { code: 200, data: rows }, token: key })
  assert.equal(exit, 2, "the token reassembled in file order is a leak")
  assert.equal(after, null, "nothing is written")
  assert.match(logs.join("\n"), /part of the account token/)
})

test("the leak gate runs before the diagnostic that names ids", async () => {
  // The windowless diagnostic printed the first three ids. With the token's
  // three segments as those ids, the whole credential reached stderr before
  // the leak gate had a chance to see the reassembly.
  const key = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
  const { exit, logs } = await genRun({ body: { code: 200, data: key.split(".").map((piece) => ({ id: piece, context_window: 0 })) }, token: key })
  assert.equal(exit, 2)
  assert.match(logs.join("\n"), /part of the account token/, "the gate answers, not the diagnostic")
  assert.equal(logs.join("\n").includes(key.split(".")[0]), false, "the segments are not echoed")
})

test("the windowless diagnostic hides a credential-shaped id", async () => {
  const key = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
  // a credential the shape rules know, which shares no window with this token
  const shaped = "Qz7vc4ndj2m8p1r6s9t3u5w0xe"
  const { exit, logs } = await genRun({ body: { code: 200, data: [{ id: shaped, display_name: "A", context_window: 0 }, { id: "plain", display_name: "B", context_window: 0 }] }, token: key })
  assert.equal(exit, 2, "no context window is a read we refuse")
  assert.equal(logs.join("\n").includes(shaped), false, "the credential-shaped id is hidden")
  assert.match(logs.join("\n"), /plain/, "an ordinary id is still named")
})

test("--check scrubs a stale credential out of the old file by its shape", async () => {
  // The line printed the old record cut only by the current token; a JWT from
  // an earlier sign-in is not this token and went to the terminal verbatim.
  const stale = mkToken({ username: "old_user", exp: 1 })
  const seeded = render(sortRows([{ id: "x", name: `key=${stale}`, context: 1000, maxOutput: 0, input: ["text"], output: ["text"], protocol: "openai_chat_completions", reasoning: false }]))
  const { exit, logs } = await genRun({ body: { code: 200, data: [{ id: "x", display_name: "fresh", context_window: 1000 }] }, seeded, argv: ["--check"] })
  assert.equal(exit, 1)
  assert.equal(logs.join("\n").includes(stale), false, `the old credential is not printed: ${logs.join("\n")}`)
  assert.match(logs.join("\n"), /changed: x/, "the change is still named")
})

test("a credential-shaped CODAR_HOME segment is not said in a sign-in error", async () => {
  const real = process.env.CODAR_HOME
  const p = await CodarPlugin()
  const read = p.auth.methods.find((m) => m.label === "科搭令牌（留空读本机）")
  try {
    process.env.CODAR_HOME = `/nonexistent/${TOKEN}`
    const got = await read.authorize()
    assert.equal(got.type, "failed")
    assert.equal(String(got.error).includes(TOKEN), false, got.error)
  } finally {
    if (real === undefined) delete process.env.CODAR_HOME
    else process.env.CODAR_HOME = real
  }
})

test("the models hook hands back model records only", async () => {
  // One null or string entry in the host's model maps is what the config hook
  // already drops; the models hook passed them through to the host.
  const p = await CodarPlugin()
  const table = { models: { good: { id: "good" }, bad: null, str: "x", num: 5 } }
  const models = await withFetch({ "/v1/codar/models": { body: { code: 500 } } }, async () => p.provider.models(table, { auth: { type: "api", key: TOKEN } }))
  // The fallback is the table the host handed in, unchanged (see the fallback
  // test above): the host keeps the list it had, so the entries it built are
  // its own, already records.
  // The null and string entries are not handed back: the fallback is the
  // host's table only when it carried nothing a model must not have.
  assert.notEqual(models, table.models, "a table with non-records is answered from a clean copy")
  assert.equal(models[Symbol.for("magpie.fellBack")], true, "marked as the fallback")
  assert.deepEqual(Object.keys(models), ["good"], "the record survives, the others do not")
  // A table of records alone is the host's own object, so the host reads the
  // unchanged list it gave back as the fallback it is.
  const clean = { models: { good: { id: "good" } } }
  const again = await withFetch({ "/v1/codar/models": { body: { code: 500 } } }, async () => p.provider.models(clean, { auth: { type: "api", key: TOKEN } }))
  const own = Object.getOwnPropertySymbols(again).filter((k) => k !== Symbol.for("magpie.fellBack"))
  assert.deepEqual(own, [], "no key beyond the marker")
  assert.equal(again[Symbol.for("magpie.fellBack")], true, "the host's table, marked in place")
  // and it *is* the host's table: the host reads a failed fetch by identity
  // (the list it gave back unchanged). Keys and marker alone passed even when
  // the read always handed back a copy.
  assert.equal(again, clean.models, "the fallback is the very object the host gave")
})

test("an activity's share is used over total, and chat.headers survives no bag", async () => {
  const p = await CodarPlugin()
  const until = Math.floor(Date.now() / 1000) + 3600
  const u = await withFetch(
    { "/v1/gettoken": { body: { code: 200, token: 300, agent_token: 0 } }, "/api/codar/activities/mine": { body: { code: 200, data: [{ free_until: until, remaining_quota: 5, user_quota_limit: 10 }] } } },
    async () => p.auth.usage(auth),
  )
  const w = u.windows.find((x) => x.name.startsWith("免费模型"))
  assert.equal(w.used, 50, "5 left of 10 is half used")
  assert.doesNotThrow(() => p["chat.headers"]({ model: { providerID: "codar" } }, null), "no bag is no work, not a throw")
})

test("the read-from-this-machine sign-in trims the token it finds", async () => {
  const { mkdtempSync, writeFileSync: write } = await import("node:fs")
  const root = mkdtempSync(join(tmpdir(), "codar-trim-"))
  const real = process.env.CODAR_HOME
  try {
    write(join(root, "config.json"), JSON.stringify({ provider: { speedai: { token: `  ${TOKEN}\n` } } }))
    process.env.CODAR_HOME = root
    const got = await appToken()
    assert.equal(got.token, TOKEN, "a config written with spaces around the token still signs in")
  } finally {
    if (real === undefined) delete process.env.CODAR_HOME
    else process.env.CODAR_HOME = real
    rmSync(root, { recursive: true, force: true })
  }
})

test("scrubShapes keeps a line's layout and still cuts a credential", () => {
  assert.equal(scrubShapes("added:   brand-new", ""), "added:   brand-new", "the alignment --check prints survives")
  assert.equal(scrubLine("added:   brand-new", ""), "added: brand-new", "scrubLine folds it, as a card wants")
  assert.doesNotMatch(scrubShapes("changed: x  eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlX2hlcmVfX19fX19fX19fXw", ""), /eyJhbGci/)
})

// --- second review round: credential fragments, wrapped check-in, wording ---

test("a token folded one separator per character is a run of the key at any width", () => {
  // The previous shape required a contiguous 8-character run, so a gateway
  // that inserted a zero-width mark between every character of a 20-character
  // piece left nothing `echoesKey` could see. The text is flattened before the
  // lookup now; the width is six, so a seven-character piece still holds a
  // run.
  const key = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
  const piece = key.slice(4, 24)
  const folded = piece.split("").join("​")
  assert.equal(echoesKey(folded, key), true, "the fold is removed before the window is looked for")
  assert.equal(echoesKey(piece.slice(0, 7), key), true, "seven characters hold a six-character run")
  assert.equal(echoesKey(piece.slice(0, 5), key), false, "five characters are below the window")
  assert.equal(echoesKey("an ordinary model name", key), false)
  assert.equal(WINDOWS_OF, 6)
})

test("a base64-encoded token is recognised as the token", () => {
  const key = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
  const enc = Buffer.from(key).toString("base64url")
  assert.equal(decodedCarriesKey(enc, key), true, "the encoded whole is the token")
  assert.equal(decodedCarriesKey(enc.slice(0, Math.ceil(enc.length / 2)), key), true, "half the encoding still carries runs")
  assert.equal(decodedCarriesKey("a-normal-model-name", key), false)
  assert.equal(decodedCarriesKey("claude-3-5-sonnet-20241022", key), false)
})

test("a model list whose fields reassemble the token serves no list", async () => {
  const key = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
  // folded per character, 20 characters per field
  const zw = "​"
  const folded = key.match(/[\s\S]{1,20}/g).map((p, i) => ({ id: `m${i}`, display_name: `P${i}=${p.split("").join(zw)}`, context_window: 1000 }))
  const out = catalogOf({ code: 200, data: folded }, key)
  const names = (out ?? []).map((r) => r.name).join("")
  assert.ok(!flatten(names).includes(key), "the folded pieces are not served back")
  // 7-character pieces with an affix: each holds a six-character run
  const affixed = key.match(/[\s\S]{1,7}/g).map((p, i) => ({ id: `x${i}`, display_name: `X${p}Y`, context_window: 1000 }))
  const out2 = catalogOf({ code: 200, data: affixed }, key) ?? []
  // Every piece but the last holds a six-character run, so each of those
  // records falls back to its id; only the one-character tail ("g") stays a
  // name, which is not a credential fragment at all.
  const served = out2.map((r) => String(r.name)).filter((n) => !/^x\d+$/.test(n))
  assert.deepEqual(served, ["XgY"], "only the one-character tail is left as a name")
  assert.ok(!flatten(out2.map((r) => r.name).join("")).includes(key.slice(0, 12)), "no run of the token is served")
  // base64 halves
  const enc = Buffer.from(key).toString("base64url")
  const half = Math.ceil(enc.length / 2)
  const out3 = catalogOf({ code: 200, data: [{ id: "a", display_name: enc.slice(0, half), context_window: 1000 }, { id: "b", display_name: enc.slice(half), context_window: 1000 }] }, key)
  // The first half decodes to the token's head and is blanked; the second is
  // bytes in the middle of the token and carries no window on its own, so it
  // stays as a name (it is not a fragment a reader can place).
  assert.equal(out3?.[0]?.name, "a", "the head half is not a name")
  assert.ok(!(out3 ?? []).some((r) => r.name === enc.slice(0, half)), "the head half is not served")
  assert.equal(catalogOf({ code: 200, data: [{ id: `m${key.slice(5, 25)}`, display_name: "n", context_window: 1000 }] }, key), null, "an id carrying a run is dropped")
  // an id that is the base64 of the token is the token encoded
  const encId = Buffer.from(key).toString("base64url")
  assert.equal(catalogOf({ code: 200, data: [{ id: encId, display_name: "n", context_window: 1000 }] }, key), null, "an encoded id is dropped")
})

test("a message that splits the token with punctuation is cut whole", () => {
  const key = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
  const pieces = key.match(/[\s\S]{1,16}/g)
  const said = scrubLine(`签名校验失败：${pieces.join(", ")}`, key)
  for (const p of pieces) assert.ok(!said.includes(p), "no piece of the token survives")
  assert.match(said, /签名校验失败/, "the prose around it survives")
  // no known key (the sign-in threw): the projection still finds the token
  const noKey = scrubLine(`登录失败：${key.split("").join(" ")}`, "")
  assert.match(noKey, /登录失败/, "the prose survives")
  assert.ok(!flatten(noKey).includes(key.slice(0, 20)), "the folded token is gone")
})

test("a second folded copy past the walk's reach does not survive the cut", () => {
  const key = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
  const first = key.split("").join(" ")
  const second = key.split("").join(" ".repeat(66))
  const said = scrubShapes(`失败 ${first} 再说一次 ${second}`, key)
  assert.ok(!flatten(said).includes(key), "the second copy is gone")
  assert.match(said, /失败/, "the prose survives")
})

test("the generator refuses an answer that echoes the token as fragments", async () => {
  const key = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
  const shapes = {
    "base64 halves": (() => { const enc = Buffer.from(key).toString("base64url"); const half = Math.ceil(enc.length / 2); return [{ id: "a", display_name: enc.slice(0, half), context_window: 1000 }, { id: "b", display_name: enc.slice(half), context_window: 1000 }] })(),
    "seven-character pieces with a label": key.match(/[\s\S]{1,7}/g).map((p, i) => ({ id: `s${String(i).padStart(2, "0")}`, display_name: `part${i}=${p}`, context_window: 1000 })),
    "seven-character pieces with an affix": key.match(/[\s\S]{1,7}/g).map((p, i) => ({ id: `m${String(i).padStart(2, "0")}`, display_name: `X${p}Y`, context_window: 1000 })),
    "six-character pieces joined in file order": key.match(/[\s\S]{1,6}/g).map((p, i) => ({ id: `s${String(i).padStart(2, "0")}`, display_name: p, context_window: 1000 })),
  }
  for (const [label, rows] of Object.entries(shapes)) {
    const { exit, after, logs } = await genRun({ body: { code: 200, data: rows }, token: key })
    assert.equal(exit, 2, `${label}: refused`)
    assert.equal(after, null, `${label}: nothing written`)
    assert.match(logs.join("\n"), /part of the account token/, label)
  }
  // and a clean list still writes
  const clean = await genRun({ body: { code: 200, data: [{ id: "m", display_name: "Good Model", context_window: 1000 }] } })
  assert.equal(clean.exit, 0, "a clean answer still writes")
})

test("the generator drops an id the cut had to change", async () => {
  // The live list drops an id that the token cut renamed; the generator used
  // to write "model-…" because catalogOf ran without the key there.
  const key = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
  const body = { code: 200, data: [{ id: `model-${key}`, display_name: "leaky", context_window: 1000 }, { id: "safe", display_name: "Safe", context_window: 1000 }] }
  const { exit, after } = await genRun({ body, token: key })
  assert.equal(exit, 0, "the answer is otherwise fine")
  assert.ok(after && after.includes('"safe"'), "the clean record is written")
  // The cut turns the id with the token into an ellipsis, so it is dropped by
  // the same rule the live list uses.
  assert.ok(!/model-…/.test(after ?? ""), "the renamed id is not written")
})

test("--check does not print a token folded with a JSON escape other than n/r/t", async () => {
  const key = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
  for (const sep of ["\u0000", "\b", "\f", "\u0007"]) {
    const folded = key.split("").join(sep)
    const seeded = `export const CATALOG = ${JSON.stringify([{ id: "new", name: folded, context: 1000, maxOutput: 0, input: [], output: [], protocol: "openai_chat_completions", reasoning: false }], null, 2)}\n`
    const { exit, logs, after } = await genRun({ body: { code: 200, data: [{ id: "new", display_name: "N", context_window: 1000 }] }, argv: ["--check"], seeded })
    assert.equal(exit, 1, "a record moved")
    assert.equal(after, seeded, "the file is untouched")
    const out = logs.join("\n")
    const flat = out.replace(/\\+(?:u00[0-9a-f]{2}|[nrtbf])/gi, "\u0001").replace(/[^A-Za-z0-9._-]/g, "")
    let best = 0
    for (let n = key.length; n > 0; n--) if (flat.includes(key.slice(0, n))) { best = n; break }
    assert.ok(best < 6, `no run of the token is printed (got ${best})`)
  }
})

test("a check-in claim whose words come first keeps its credit beside the wait", async () => {

  // claim with the rule appended; the 400-beside-a-wait pair used to settle it
  // as `done` with no credit.
  for (const [label, answer] of [
    ["2xx, data.retry_after", { body: { code: 400, message: "领取成功，24小时内仅可领取一次", data: { retry_after: 86000 } }, status: 200 }],
    ["2xx, Retry-After header", () => new Response(JSON.stringify({ code: 400, message: "领取成功，24小时内仅可领取一次" }), { status: 200, headers: { "Content-Type": "application/json", "Retry-After": "3600" } })],
    ["HTTP 400 with the same words", { body: { code: 400, message: "领取成功，24小时内仅可领取一次", data: { retry_after: 3600 } }, status: 400 }],
    ["English success with the 24-hour rule", { body: { code: 400, message: "Success. You can only claim once every 24 hours", data: { retry_after: 3600 } }, status: 200 }],
  ]) {
    const p = await CodarPlugin()
    let points = 500
    const r = await withFetch({
      "/v1/gettoken": () => { const now = points; points += 50; return new Response(JSON.stringify({ code: 200, token: now, agent_token: 0 }), { status: 200, headers: { "Content-Type": "application/json" } }) },
      "/v1/daily-sign": answer,
    }, async () => p.auth.checkin(auth))
    assert.equal(r.outcome, "claimed", `${label}: this attempt landed`)
    // The early claim on the HTTP-error branch reports the vendor's answer
    // as it came; neither branch claims a figure it did not read. The 2xx
    // branches read the balance, and the next window is stated.
    if (label.startsWith("HTTP 400")) assert.equal(r.credit, undefined, `${label}: no balance read on the error path`)
    else assert.equal(r.credit, 50, `${label}: the credit is read`)
    assert.match(r.message, /领取成功|Success/, `${label}: the vendor's words survive`)
    assert.ok(r.until, `${label}: and the next window is recorded`)
  }
})

test("a check-in refusal wrapped in data is a refusal", async () => {
  const p = await CodarPlugin()
  const read = (body) => withFetch({ "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } }, "/v1/daily-sign": { body } }, async () => p.auth.checkin(auth))
  for (const [label, body] of [
    ["success:false", { code: 200, data: { success: false } }],
    ["code 500", { code: 200, data: { code: 500 } }],
    ["code 401", { code: 200, data: { code: 401, message: "Invalid token" } }],
    ["code 403", { code: 200, data: { code: 403, message: "forbidden" } }],
  ]) {
    const r = await read(body)
    assert.equal(r.outcome, "failed", `${label}: not a claim`)
    assert.equal(r.credit, undefined, `${label}: no credit is invented`)
  }
  const expired = await read({ code: 200, data: { code: 401 } })
  assert.match(expired.message, /重新登录/, "an inner 401 says to sign in again")
  // the normal shape is not affected: data.retry_after beside an already-claimed day
  const done = await read({ code: 400, message: "24小时内仅可领取一次", data: { retry_after: 3600 } })
  assert.equal(done.outcome, "done", "the wrapper the vendor does send is read normally")
})

test("a numeric string business code is a number, not a business word", () => {
  for (const c of [" 200 ", "200.0", "2e2", "401 "]) assert.equal(errorCodeOf({ code: c }), "", `${JSON.stringify(c)} is numeric`)
  assert.equal(errorCodeOf({ code: "account_restricted" }), "account_restricted")
  assert.equal(errorCodeOf({ code: "200abc" }), "200abc", "a code with letters is a word")
  // a healthy catalog whose code is spelled with spaces is a list
  assert.ok(catalogOf({ code: " 200 ", data: [{ id: "m", display_name: "M", context_window: 1000 }] }, ""))
})

test("a check-in status row reads retry_after from the envelope as well as data", async () => {
  const p = await CodarPlugin()
  const card = await withFetch({
    "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
    "/api/codar/activities/mine": { body: { code: 200, data: [] } },
    "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true }, retry_after: 7200 } },
  }, async () => p.auth.usage(auth))
  const row = (card.windows ?? []).find((w) => w.name === "每日签到")
  assert.ok(row, "the check-in row is drawn")
  assert.match(row.display, /2 小时后可再领/, "the envelope's wait is stated")
  assert.ok(row.resetsAt, "and it has a moment")
})

test("a credit whose two halves overflow the double range is omitted, not null", async () => {
  const p = await CodarPlugin()
  let read = 0
  const r = await withFetch({
    "/v1/gettoken": () => { read += 1; const v = read === 1 ? 0 : 1e308; return new Response(JSON.stringify({ code: 200, token: v, agent_token: v }), { status: 200, headers: { "Content-Type": "application/json" } }) },
    "/v1/daily-sign": { body: { code: 200, message: "Success" } },
  }, async () => p.auth.checkin(auth))
  assert.equal(r.outcome, "claimed")
  assert.equal(r.credit, undefined, "an unstatable sum is left out")
  assert.equal(JSON.stringify(r.credit), undefined, "and never travels as null")
})

test("a refusal that writes its own wait is not told it twice, and a vague one still says when", async () => {
  const p = await CodarPlugin()
  const read = (body) => withFetch({ "/v1/gettoken": { body: { code: 200, token: 1, agent_token: 0 } }, "/v1/daily-sign": { body } }, async () => p.auth.checkin(auth))
  const own = await read({ code: 429, message: "请求过于频繁，请10分钟后再重试", data: { retry_after: 600 } })
  assert.ok(!own.message.includes("（约"), `the wait is not appended twice: ${own.message}`)
  assert.match(own.message, /10分钟后再重试/, "the vendor's own wait survives")
  const vague = await read({ code: 429, message: "请求过于频繁", data: { retry_after: 600 } })
  assert.match(vague.message, /10 分钟后可重试/, "a vague refusal still gets the moment")
  const failed = await read({ code: 400, message: "签到失败，请稍后重试", data: { retry_after: 600 } })
  assert.equal(failed.outcome, "failed")
  assert.match(failed.message, /10 分钟后可重试/, "a failure's wait still reaches the card")
})

test("the failure words that mean try later are read as failures", async () => {
  const p = await CodarPlugin()
  const read = (message) => withFetch({ "/v1/gettoken": { body: { code: 200, token: 1, agent_token: 0 } }, "/v1/daily-sign": { body: { code: 400, message, data: { retry_after: 3600 } } } }, async () => p.auth.checkin(auth))
  for (const message of ["Please retry later", "Please wait", "Request throttled", "daily limit reached", "服务故障，请稍候", "网络超时", "系统开小差了", "稍后再来"]) {
    const r = await read(message)
    assert.equal(r.outcome, "failed", `${message} is not "already claimed"`)
  }
  const success = await read("Check-in successful. Please try again tomorrow.")
  assert.equal(success.outcome, "claimed", "a success that says to come back tomorrow is still a claim")
})

test("English denials and a Chinese not-yet-credited note do not veto a claim", async () => {
  const p = await CodarPlugin()
  const read = (body) => withFetch({ "/v1/gettoken": { body: { code: 200, token: 1, agent_token: 0 } }, "/v1/daily-sign": { body } }, async () => p.auth.checkin(auth))
  for (const message of ["No issues, check-in successful", "No error, 签到成功", "without error, check-in successful"]) {
    const r = await read({ message })
    assert.equal(r.outcome, "claimed", `${message}`)
  }
  for (const message of ["今日已签到。尚未到账，请稍候", "今日已签到。还没有发放"]) {
    const r = await read({ code: 200, message })
    assert.equal(r.outcome, "done", `${message} is signed, points pending`)
  }
})

test("a refusal wrapped twice in data still refuses", async () => {
  // {data:{data:{error:{code:"account_restricted"}}}}: the outer errorCodeOf
  // cannot see data.data, so the reader's own wrapped gate is what catches it.
  const p = await CodarPlugin()
  const card = await withFetch({
    "/v1/gettoken": { body: { code: 200, data: { data: { error: { code: "account_restricted" } } }, token: 5, agent_token: 5 } },
    "/api/codar/activities/mine": { body: { code: 200, data: [] } },
    "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: false } } },
  }, async () => p.auth.usage(auth))
  assert.match(card.error ?? "", /account_restricted/, "the restriction is reported")
})

test("an activity id that the cut shortens is blanked before the card joins it", async () => {
  // The card cleans only the two ids the window names, and does so before
  // cleanText truncates: a folded id longer than the clean's cut used to be
  // cut only after truncation, leaving its head on the card.
  const key = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
  const zw = "​"
  const folded = key.split("").join(zw)
  const until = Math.floor(Date.now() / 1000) + 3600
  const p = await CodarPlugin()
  const card = await withFetch({
    "/v1/gettoken": { body: { code: 200, token: 1, agent_token: 0 } },
    "/api/codar/activities/mine": { body: { success: true, data: [{ free_until: until, remaining_quota: 10, model_ids: [folded, "clean-model"] }] } },
    "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: false } } },
  }, async () => p.auth.usage(auth))
  const names = (card.windows ?? []).map((w) => w.name).join(" ")
  assert.ok(!flatten(names).includes(key.slice(0, 40)), "no head of the token is on the card")
})

test("the models hook fills in an own model's id, as the config hook does", async () => {
  // The host builds a row from m.id; a hand-written model that saved without
  // one was served as-is by the models hook (the config hook filled it in),
  // so the row had no name.
  const p = await CodarPlugin()
  const own = { "my-model": { name: "My model" } }
  const out = await withFetch({ "/v1/codar/models": { body: { code: 200, data: [] } } }, async () => p.provider.models({ models: own }, { auth: { type: "api", key: TOKEN } }))
  assert.equal(out["my-model"]?.id, "my-model", "the key is the id")
  assert.equal(out["my-model"]?.name, "My model", "the user's fields survive")
})

test("a second folded copy cut by the projection is guarded by the linear pass", () => {
  // The projected cut shifts the tail left. A second copy folded with a
  // separator the walk does not enumerate lands within the card's slice
  // after that shift; cutKey's final stripped check is what removes it.
  const key = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
  const first = key.split("").join(" ")
  const odd = key.split("").join("~")  // a separator the fold walk does not know
  const raw = `失败 ${first} 再说一次 ${odd}`
  const out = scrubLine(raw, key)
  assert.ok(!flatten(out).includes(key), "no copy of the key survives")
  assert.match(out, /失败/, "and the prose is still readable")
})

test("a base64-encoded id is refused by catalogOf", () => {
  const key = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
  const enc = Buffer.from(key).toString("base64url")
  // The full encoded id exceeds cleanText's 120-character cut, so that cut
  // alone would drop it. A shorter prefix still decodes to the token's head;
  // only decodedCarriesKey can tell it is the token.
  for (const id of [enc.slice(0, 100), enc.slice(0, 120), enc]) {
    assert.equal(catalogOf({ code: 200, data: [{ id, display_name: "n", context_window: 1000 }] }, key), null, `the ${id.length}-character encoded id is dropped`)
  }
})

test("cutKey's final guard catches a second copy that only the projection saw", () => {
  // A copy folded with a separator the fold walk does not enumerate (~) is
  // cut by cutProjected. A second copy farther in the message whose whole
  // lands within the card's slice after the first cut is removed by the final
  // stripped copy pass, which the projection itself does not make: the output
  // of cutProjected + preceding cuts is checked in linear time.
  const key = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
  const copy1 = key.split("").join(" ")
  const copy2 = key.split("").join("~")
  const raw = `失败 ${copy1} 再说一次 ${copy2}`
  const out = scrubLine(raw, key)
  assert.ok(!flatten(out).includes(key), "no copy of the key survives")
  assert.match(out, /失败/, "the prose is still readable")
})

test("--check does not print a short fragment of a stale token", async () => {
  // A catalog regenerated before the token cut existed may hold a piece of
  // an older token. Cutting only the whole JWT left a 20-character run on the
  // terminal; the projection cut and the shape rules now remove it.
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
  const current = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
  const old = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ username: "older", exp: 1900000000 })}.Kq3zX9bLmN2pR7tY4vW1cD8fG5hJ0kQ6sA9eU2iO7pZ`
  const seeded = `export const CATALOG = ${JSON.stringify([{ id: "new", name: old.slice(20, 40), context: 1000, maxOutput: 0, input: [], output: [], protocol: "openai_chat_completions", reasoning: false }], null, 2)}\n`
  const { exit, logs } = await genRun({ body: { code: 200, data: [{ id: "new", display_name: "N", context_window: 1000 }] }, argv: ["--check"], seeded, token: current })
  assert.equal(exit, 1, "a record moved")
  assert.ok(!logs.join("\n").includes(old.slice(20, 40)), "the fragment is not printed")
})

test("a failed JSON parse does not echo a piece of the answer on the terminal", async () => {
  // V8's SyntaxError quotes the first characters of an unparseable body. The
  // generator prints that message; with a token piece at the front, the shape
  // rules have to cut it before it reaches CI logs.
  const key = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
  const frag = key.slice(0, 20)
  const { exit, logs, after } = await genRun({ body: `plain ${frag} tail`, token: key })
  assert.equal(exit, 2, "an unreadable answer is exit 2")
  assert.equal(after, null, "nothing is written")
  assert.ok(!logs.join("\n").includes(frag), "the fragment is not printed")
})

// ---- the last review round: every finding below has a probe behind it ----

// mkKey is a JWT with a random middle, so the token's characters vary run to
// run (mkToken's fixed claims give the same string every time, and a test that
// only ever folds that string can pass on luck).
const mkKey = () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
  const middle = crypto.randomBytes(48).toString("base64url")
  return `${b64({ alg: "HS256", typ: "JWT" })}.${middle}.${crypto.randomBytes(16).toString("base64url")}`
}
const getAuthFor = (key) => async () => ({ type: "api", key })

test("a token spelled in its own alphabet, in fullwidth, or in an escape is cut from a card", async () => {
  const p = await CodarPlugin()
  const key = mkKey()
  const full = (c) => (/[A-Za-z0-9]/.test(c) ? String.fromCharCode(c.charCodeAt(0) + 0xfee0) : c)
  const escapes = (s) => [...s].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")
  const shapes = {
    "a dot after every character": [...key].map((c) => `${c}.`).join(""),
    "fullwidth letters": [...key].map(full).join(""),
    "JSON-escaped text": escapes(key),
  }
  for (const [label, echo] of Object.entries(shapes)) {
    const r = await withFetch(
      {
        "/v1/gettoken": { body: { code: 200, token: 5, agent_token: 0 } },
        "/v1/daily-sign": { body: { code: 500, message: `gateway said: ${echo}` } },
      },
      async () => p.auth.checkin(getAuthFor(key)),
    )
    assert.equal(r.outcome, "failed", `${label}: a 500 is still a failure`)
    assert.ok(!r.message.includes(key.slice(0, 24)), `${label}: no run of the token on the card`)
    assert.doesNotMatch(r.message, /eyJ|ｅｙＪ|\\u0065/, `${label}: not even its shape`)
  }
})

test("an encoded echo is cut from a card and from a model list", async () => {
  const p = await CodarPlugin()
  const key = mkKey()
  const enc = Buffer.from(key).toString("base64url")
  const half = Math.ceil(enc.length / 2)
  const echoes = {
    "base64 folded every 20 characters": enc.replace(/(.{20})/g, "$1 "),
    "base64 with a label": `b64:${enc}`,
    "base64 with an affix": `x${enc}`,
    "base64 halves joined": `${enc.slice(0, half)}, ${enc.slice(half)}`,
    hex: Buffer.from(key).toString("hex"),
  }
  for (const [label, echo] of Object.entries(echoes)) {
    const r = await withFetch(
      { "/v1/gettoken": { body: { code: 200, token: 5, agent_token: 0 } }, "/v1/daily-sign": { body: { code: 500, message: `boom ${echo}` } } },
      async () => p.auth.checkin(getAuthFor(key)),
    )
    const recoverable = [r.message, ...(r.message.match(/[A-Za-z0-9+/_-]{16,}/g) ?? [])].some((s) => {
      const body = s.replace(/^x/, "").replace(/_/g, "/").replace(/-/g, "+").replace(/[^A-Za-z0-9+/=]/g, "")
      try {
        return Buffer.from(body, "base64").toString("latin1").includes(key.slice(0, 24)) || Buffer.from(body, "hex").toString("latin1").includes(key.slice(0, 24))
      } catch {
        return false
      }
    })
    assert.equal(recoverable, false, `${label}: not on the card`)
  }
  const list = await withFetch(
    { "/v1/codar/models": { body: { code: 200, data: [{ id: "m", display_name: `x${enc}`, context_window: 1000, protocol: "openai_chat_completions" }] } } },
    async () => p.provider.models({ models: {} }, { auth: { type: "api", key } }),
  )
  assert.equal(list.m.name, "m", "an encoded name falls back to its id")
})

test("the token split into 5-character pieces, each with a label, is not served", async () => {
  const p = await CodarPlugin()
  const key = mkKey()
  const pieces = key.match(/[\s\S]{1,5}/g)
  const data = pieces.map((piece, i) => ({ id: `m${String(i).padStart(2, "0")}`, display_name: `fence:${piece}:fence`, context_window: 1000, protocol: "openai_chat_completions" }))
  const list = await withFetch({ "/v1/codar/models": { body: { code: 200, data } } }, async () => p.provider.models({ models: {} }, { auth: { type: "api", key } }))
  const back = data.map((r) => (list[r.id]?.name ?? "").match(/fence:(.*):fence/)?.[1] ?? "").join("")
  assert.notEqual(back, key, "the pieces are not served in a shape that reassembles the token")
  const { exit } = await genRun({ body: { code: 200, data }, token: key })
  assert.equal(exit, 2, "and the generator refuses to write them")
})

test("a hex, fullwidth or labelled-base64 token does not reach the catalog file", async () => {
  const key = mkKey()
  const enc = Buffer.from(key).toString("base64url")
  const full = [...key].map((c) => (/[A-Za-z0-9]/.test(c) ? String.fromCharCode(c.charCodeAt(0) + 0xfee0) : c)).join("")
  const cases = { hex: Buffer.from(key).toString("hex"), fullwidth: full, "labelled base64": `b64:${enc}`, "affixed base64": `x${enc}` }
  for (const [label, name] of Object.entries(cases)) {
    const { exit, after } = await genRun({ body: { code: 200, data: [{ id: "m", display_name: name, context_window: 1000 }] }, token: key })
    assert.ok(exit === 2 || !String(after).includes(name.slice(0, 20)), `${label}: not written`)
    if (exit === 0) assert.ok(!String(after).includes(name.slice(0, 20)), `${label}: nor in another field`)
  }
})

test("a refusal is a refusal whatever the HTTP status says", async () => {
  const p = await CodarPlugin()
  // The HTTP-error branch keeps one road to a settled day for a 400 — the
  // 400-beside-a-wait pair (the vendor's "already claimed" in its usual
  // shape) — so that one is covered by its own test; a refusal that names
  // itself otherwise is a refusal whatever the status.
  // (A 500 beside a readable wait is the vendor's "already claimed" in the
  // error branch's usual shape; what this test holds is that no success word
  // on a failure code is one, without a wait to pair with.)
  const bodies = [
    { code: 500, message: "领取成功", data: { retry_after: 60 } },
    { code: 401, message: "领取成功" },
    { code: 403, message: "签到成功" },
    { success: false, message: "领取成功" },
    { success: "false", message: "Success" },
  ]
  for (const body of bodies) {
    for (const status of [200, 400, 409, 500]) {
      const r = await withFetch(
        { "/v1/gettoken": { body: { code: 200, token: 9, agent_token: 0 } }, "/v1/daily-sign": { body, status } },
        async () => p.auth.checkin(auth),
      )
      assert.equal(r.outcome, "failed", `${JSON.stringify(body)} over HTTP ${status}`)
    }
  }
})

test("a refusal one wrapper deeper, or spelled as a code word, is not a claim", async () => {
  const p = await CodarPlugin()
  const cases = [
    [{ code: 200, data: { data: { code: 500, success: false, message: "签到失败" } } }, "a refusal two levels in"],
    [{ code: "invalid_token", message: "Success" }, "a business code in words"],
    [{ code: 400, message: "Already signed successfully today? No, not yet", data: { retry_after: 3600 } }, "a success word denied by the next sentence"],
  ]
  for (const [body, label] of cases) {
    const r = await withFetch({ "/v1/gettoken": { body: { code: 200, token: 9, agent_token: 0 } }, "/v1/daily-sign": { body } }, async () => p.auth.checkin(auth))
    assert.equal(r.outcome, "failed", label)
  }
})

test("the status row reads the first wait that can be stated", async () => {
  const p = await CodarPlugin()
  const reads = [
    [{ code: 200, data: true, retry_after: 3600 }, "a boolean data with a top-level wait"],
    [{ code: 200, data: { isSigned: true, retry_after: "unreadable" }, retry_after: 3600 }, "an unreadable wrapped wait holding a good top-level one"],
  ]
  for (const [body, label] of reads) {
    const u = await withFetch(
      { "/v1/gettoken": { body: { code: 200, token: 5, agent_token: 0 } }, "/v1/daily-sign/status": { body }, "/api/codar/activities/mine": { body: { code: 200, data: [] } } },
      async () => p.auth.usage(auth),
    )
    const row = u.windows.find((w) => w.name === "每日签到")
    assert.ok(row?.resetsAt > Date.now() + 3000000, label)
  }
  const header = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 5, agent_token: 0 } },
      "/v1/agent/balance": { body: { data: { agent_balance: 0 } } },
      "/v1/daily-sign/status": () => new Response(JSON.stringify({ code: 200, data: { isSigned: true } }), { status: 200, headers: { "Content-Type": "application/json", "Retry-After": "3600" } }),
      "/api/codar/activities/mine": { body: { code: 200, data: [] } },
    },
    async () => p.auth.usage(auth),
  )
  assert.ok(header.windows.find((w) => w.name === "每日签到")?.resetsAt > Date.now() + 3000000, "a wait only the header states")
})

test("readers that gate on a business code refuse a refusal in words", async () => {
  const p = await CodarPlugin()
  const u = await withFetch(
    { "/v1/gettoken": { body: { code: "invalid_token", message: "Token is invalid", token: 0, agent_token: 0 } } },
    async () => p.auth.usage(auth),
  )
  assert.equal(u.signIn, "expired", "an invalid token is the sign-in's")
  const acts = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 5, agent_token: 0 } },
      "/v1/agent/balance": { body: { data: { agent_balance: 0 } } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: false } } },
      "/api/codar/activities/mine": { body: { code: "account_restricted", data: [{ free_until: Math.floor(Date.now() / 1000) + 3600, remaining_quota: null }] } },
    },
    async () => p.auth.usage(auth),
  )
  assert.equal(acts.windows.some((w) => w.name.startsWith("免费模型")), false, "a refusal's stale list is not drawn as free")
})

test("every road out of the models hook hands back only records without id-named keys", async () => {
  const p = await CodarPlugin()
  const table = { models: { ["__proto__"]: { id: "__proto__", name: "P" }, custom: { name: "Own" } } }
  const outs = [
    await p.provider.models(table, {}),
    await p.provider.models(table, { auth: { type: "api", key: mkToken({ username: "u", exp: Math.floor(Date.now() / 1000) - 60 }) } }),
    await withFetch({ "/v1/codar/models": { body: { code: 500 } } }, async () => p.provider.models(table, { auth: async () => auth() })),
  ]
  for (const out of outs) {
    assert.equal(Object.hasOwn(out, "__proto__"), false, "no id-named key")
    assert.equal(out.custom?.id, "custom", "and a user entry carries its id")
  }
})

test("a hook never throws out to the host on a reader that fails", async () => {
  const p = await CodarPlugin()
  assert.deepEqual(await p.auth.loader(async () => {
    throw new Error("damaged plugin-auth.json")
  }), {}, "a failing reader is no key")
  await assert.doesNotReject(() => p.config(null), "no config is no crash")
  await assert.doesNotReject(() => p["chat.headers"]({ model: { providerID: "codar" } }, { headers: Object.freeze({}) }), "a frozen bag is left alone")
})

test("an Anthropic model states its /v1 base, a chat model its own", async () => {
  const p = await CodarPlugin()
  const config = {}
  await p.config(config)
  const models = config.provider.codar.models
  assert.equal(models[ANTHROPIC_ID].api.url, "https://api.claw.speedai.com/v1")
  assert.equal(models[LISTED_ID].api.url, "https://api.claw.speedai.com", "the host adds the SDK's /v1 to a chat path itself")
})

test("a vendor answer that arrives gzip-encoded is read, not refused", async () => {
  // The vendor started compressing the QR endpoint. Every transport this
  // plugin uses hands back the decoded bytes (Bun's and Node's fetch decode,
  // and the Go proxy's client is given Accept-Encoding by net/http and
  // decodes what it asked for), so the header says nothing about the bytes in
  // hand: refusing on it failed every sign-in. The size cap still applies,
  // counted over the decoded body.
  const p = await CodarPlugin()
  const res = new Response('{"code":200}', { status: 200, headers: { "Content-Encoding": "gzip" } })
  const { text } = await readAnswer(res)
  assert.equal(text, '{"code":200}', "the decoded body is what is read")
})

test("a username claim that is itself a credential is not an account name", async () => {
  const inner = mkKey()
  const outer = mkToken({ username: inner, exp: Math.floor(Date.now() / 1000) + 3600 })
  assert.equal(usernameOf(outer), "", "a JWT is not a name")
  assert.equal(usernameOf(mkToken({ username: "user_1", exp: 0 })), "user_1", "a plain name still is")
})

test("a name with half a character in it, or another provider's key, is not served", async () => {
  const p = await CodarPlugin()
  const key = mkKey()
  const body = {
    code: 200,
    data: [
      { id: "half", display_name: "\ud83d", context_window: 1000, protocol: "openai_chat_completions" },
      { id: "other", display_name: "sk-live-0123456789abcdefghij", context_window: 1000, protocol: "openai_chat_completions" },
      { id: "fine", display_name: "Claude Sonnet", context_window: 1000, protocol: "openai_chat_completions" },
    ],
  }
  const list = await withFetch({ "/v1/codar/models": { body } }, async () => p.provider.models({ models: {} }, { auth: { type: "api", key } }))
  assert.equal(list.half.name, "half", "a lone surrogate is not a name to write down")
  assert.equal(list.other.name, "other", "another provider's key is not a name")
  assert.equal(list.fine.name, "Claude Sonnet", "an ordinary name is served as written")
})

test("a split into two-character pieces, or across a run of the key's own alphabet, is not served", async () => {
  const p = await CodarPlugin()
  const key = mkKey()
  const pieces = key.match(/[\s\S]{1,2}/g)
  for (const [label, name] of pieces.map((piece) => [piece, `fence:${piece}:fence`])) void label
  const data = pieces.map((piece, i) => ({ id: `m${String(i).padStart(3, "0")}`, display_name: `fence:${piece}:fence`, context_window: 1000, protocol: "openai_chat_completions" }))
  const list = await withFetch({ "/v1/codar/models": { body: { code: 200, data } } }, async () => p.provider.models({ models: {} }, { auth: { type: "api", key } }))
  const back = data.map((r) => (list[r.id]?.name ?? "").match(/fence:(.*):fence/)?.[1] ?? "").join("")
  assert.notEqual(back, key, "two-character pieces are not served in a shape that reassembles the token")
  const { exit } = await genRun({ body: { code: 200, data }, token: key })
  assert.equal(exit, 2, "nor written")
  // the key's characters joined by a run of the key's own alphabet ("|"
  // between two-character pieces) on a card
  const piped = pieces.join("|")
  const r = await withFetch(
    { "/v1/gettoken": { body: { code: 200, token: 5, agent_token: 0 } }, "/v1/daily-sign": { body: { code: 500, message: `boom ${piped}` } } },
    async () => p.auth.checkin(getAuthFor(key)),
  )
  assert.doesNotMatch(r.message, new RegExp(piped.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "not on the card")
})

test("a token split one character per field is the token, and is not served", async () => {
  // The field-by-field walk used to require a two-character block to move
  // forward, so a vendor that answered one token character per model id had
  // every piece of the key on the list in order — a full credential, on the
  // card and in the file, with no run of it anywhere for a window to find.
  const p = await CodarPlugin()
  const key = mkKey()
  const data = [...key].map((ch, i) => ({
    id: `model-${String(i).padStart(4, "0")}-${ch}`,
    display_name: `General language model ${i}`,
    context_window: 1000,
    protocol: "openai_chat_completions",
  }))
  const list = await withFetch({ "/v1/codar/models": { body: { code: 200, data } } }, async () => p.provider.models({ models: {} }, { auth: { type: "api", key } }))
  const back = Object.keys(list)
    .sort()
    .map((id) => id.slice(-1))
    .join("")
  assert.notEqual(back, key, "one-character pieces are not served in a shape that reassembles the token")
  const { exit } = await genRun({ body: { code: 200, data }, token: key })
  assert.equal(exit, 2, "nor written to the catalog")
  // and an honest catalog of long names still passes the same gate
  const honest = Array.from({ length: 40 }, (_, i) => ({ id: `anthropic/claude-sonnet-${i}`, display_name: `Claude Sonnet ${i} Preview`, context_window: 200000, protocol: "openai_chat_completions" }))
  const kept = await withFetch({ "/v1/codar/models": { body: { code: 200, data: honest } } }, async () => p.provider.models({ models: {} }, { auth: { type: "api", key } }))
  assert.equal(Object.keys(kept).length, honest.length, "an ordinary catalog is not refused")
})

test("the check-in keeps a real vendor answer's reading", async () => {
  // Shapes the vendor sends today (and the shapes the suite has always read):
  // a 200 claim with a credit, a 400 "already claimed" with its wait, letters
  // and punctuation in prose that must survive the start of the stricter cuts.
  const p = await CodarPlugin()
  const read = (answer, points) => {
    let n = 0
    return withFetch(
      {
        "/v1/gettoken": () => {
          const now = n === 0 ? 100 : points
          n++
          return new Response(JSON.stringify({ code: 200, token: now, agent_token: 0 }), { status: 200, headers: { "Content-Type": "application/json" } })
        },
        "/v1/daily-sign": answer,
      },
      async () => p.auth.checkin(auth),
    )
  }
  const claim = await read({ body: { code: 200, message: "签到成功！" } }, 110)
  assert.equal(claim.outcome, "claimed")
  assert.equal(claim.credit, 10)
  const done = await read({ body: { code: 400, message: "24小时内仅可领取一次", data: { retry_after: 86000 } } })
  assert.equal(done.outcome, "done")
  assert.match(done.message, /23 小时.*后可再领/)
  // Prose with dots, versions, hex-looking words and sentence punctuation
  // comes through the stricter cuts whole.
  const key = mkKey()
  const prose = "V1.2: check-in failed on 2026-11-09, see docs.example.com/v1/today; error 0xbadc0ffee (no errors)."
  assert.equal(scrubLine(prose, key), prose, "a sentence is not mistaken for a credential")
  const failed = await read({ body: { code: 200, message: prose } })
  assert.equal(failed.outcome, "failed", "and the words still read as a failure")
})

test("the same refusal is read the same way whatever HTTP status carries it", async () => {
  // The two branches (2xx and HTTP error) each kept their own copy of the
  // precedence, and three shapes read differently by status: a deep wrapped
  // refusal (checked on the 2xx path only), a success word the next sentence
  // denies (the bare code:200 settled it as claimed), and an explicit
  // success:false beside the vendor's own statement about the day (the error
  // branch's veto dropped the day and its wait). One answer, four statuses,
  // one reading.
  const p = await CodarPlugin()
  const read = (body, status) =>
    withFetch(
      {
        "/v1/gettoken": { body: { code: 200, token: 1, agent_token: 0 } },
        "/v1/daily-sign": { body, status },
      },
      async () => p.auth.checkin(auth),
    )
  for (const status of [200, 400, 409, 500]) {
    const deep = await read({ code: 200, message: "签到成功", data: { code: 200, data: { code: 500, success: false, message: "签到失败" } } }, status)
    assert.equal(deep.outcome, "failed", `a refusal two wrappers deep is a refusal (HTTP ${status})`)
    const negated = await read({ code: 200, message: "Check-in successful? No, not yet" }, status)
    assert.equal(negated.outcome, "failed", `a success word the next sentence denies is no claim (HTTP ${status})`)
  }
  for (const status of [400, 409, 500]) {
    const pair = await read({ code: 400, success: false, message: "24小时内仅可领取一次", data: { retry_after: 3600 } }, status)
    assert.equal(pair.outcome, "done", `the vendor's statement about the day wins over the flag (HTTP ${status})`)
    assert.ok(pair.until > Date.now() + 3000000, "with the wait it stated")
  }
})

test("an ordinary long account name and an ordinary long model id are not credentials", async () => {
  // The username rule refused any dot-separated segment of 16+ base64url
  // letters, and the model shape rule any 24+ mixed run: an account named
  // "AlexanderHamilton" could not check in, and the vendor's own ids
  // ("DeepSeekR1DistillQwen32BInstruct", "claude-sonnet-4-5-20250929") were
  // dropped from the list and renamed on the card.
  const name = mkToken({ username: "AlexanderHamilton", exp: Math.floor(Date.now() / 1000) + 600 })
  assert.equal(usernameOf(name), "AlexanderHamilton")
  assert.equal(usernameOf(mkToken({ username: "long_normal_user_name" })), "long_normal_user_name")
  assert.equal(usernameOf(mkToken({ username: mkToken({ username: "x", exp: 1 }) })), "", "a username that is itself a JWT is still refused")
  const list = catalogOf({
    code: 200,
    data: [
      { id: "claude-sonnet-4-5-20250929", context_window: 200000, protocol: { type: "openai_chat_completions" } },
      { id: "DeepSeekR1DistillQwen32BInstruct", context_window: 8000, protocol: { type: "openai_chat_completions" } },
    ],
  })
  assert.deepEqual(list.map((m) => m.id), ["claude-sonnet-4-5-20250929", "DeepSeekR1DistillQwen32BInstruct"])
  const card = scrub("签到成功，模型 claude-sonnet-4-5-20250929 可用。", mkToken({ username: "u", exp: 1 }))
  assert.equal(card, "签到成功，模型 claude-sonnet-4-5-20250929 可用。", "a model id in the card's words is not cut")
  assert.equal(scrub("token codar_access_9f3d8e2a1b7c4d5e6f70a1b2 rejected", mkToken({ username: "u", exp: 1 })), "token … rejected", "a mixed secret still is")
})

test("an encoded echo of the token is cut from the card, folded or not", async () => {
  const key = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 600 })
  const b64 = Buffer.from(key).toString("base64url")
  const b64s = Buffer.from(key).toString("base64")
  const hex = Buffer.from(key).toString("hex")
  const fold = (s, n) => s.match(new RegExp(`.{1,${n}}`, "g")).join(" ")
  for (const echo of [b64, b64s, hex, fold(b64, 8), fold(b64s, 20), fold(hex, 16), "b64: " + fold(b64, 10), "xxx" + b64]) {
    const card = signMessage({ code: 500, message: "签到失败 " + echo }, key)
    const left = card.replace(/[^A-Za-z0-9._-]/g, "")
    assert.ok(!left.includes(key.replace(/[^A-Za-z0-9._-]/g, "")) && !left.includes(b64) && !left.includes(hex), "no whole copy of the encoding survives")
  }
  assert.equal(signMessage({ code: 500, message: "签到失败 b64: " + fold(b64, 10) }, key), "签到失败 b64: …", "the encoding is cut whole, the label kept")
})

test("a two-character split with a label on every piece is not served", async () => {
  // Pieces narrower than every window: each record carried two characters,
  // fenced on both sides, and the list put the key back together in order.
  const key = mkToken({ username: "reviewer", exp: Math.floor(Date.now() / 1000) + 600 })
  const pieces = key.match(/[\s\S]{1,2}/g).map((x) => `fence:${x}:fence`)
  assert.ok(splitAcross(pieces, key), "the pieces in order are the key")
  const one = key.split("").map((c) => `[${c}]`)
  assert.ok(splitAcross(one.join(" "), key), "one character a piece too")
  assert.ok(!splitAcross(["The able translator", "Kiwi Lite", "General model atlas", "daily catalog harbor"].join(" "), key), "a list of ordinary names is not")
})

test("a folded base64 echo is found by the generator's encoded gate", async () => {
  const key = mkToken({ username: "reviewer", exp: Math.floor(Date.now() / 1000) + 600 })
  const b64 = Buffer.from(key).toString("base64url")
  const folded = b64.match(/.{1,8}/g).map((x) => `<${x}>`).join("") + "\n" + b64.match(/.{1,12}/g).slice(-5).map((x) => `"${x}"`).join(",")
  assert.ok(decodedCarriesKey(folded, key) || encodedRun(folded, key), "the pieces joined are the encoding")
  assert.ok(!encodedRun("abcdefghijklmnopqrstuvwxyz0123", key), "ordinary letters are not")
})

test("an encoded copy of a token is cut where no key is known", async () => {
  // The --check print and a card cut after getAuth threw have no key to cut
  // by: the shape pass decodes with the header every Codar token starts with,
  // so a base64 copy of a token is still the credential it is, folded or not.
  const enc = Buffer.from(TOKEN).toString("base64")
  const folded = enc.match(/.{1,20}/g).join(" ")
  for (const text of [enc, folded]) {
    const cut = scrubShapes(text, "")
    assert.ok(!cut.includes("ZXlK"), "no part of the encoding survives")
    assert.match(cut, /…/)
  }
  assert.equal(scrubShapes("a message about ZXlK systems", ""), "a message about ZXlK systems", "the word alone is not an encoding")
})

test("a base32 or percent-encoded copy of the token is cut from the card and the catalog", async () => {
  // Encodings a window scan cannot see and the base64/hex decoders do not
  // read: base32 (another alphabet), bytes written as %XX, folded or not.
  const key = TOKEN
  const A = "abcdefghijklmnopqrstuvwxyz234567"
  const b32 = (buf) => {
    let bits = 0
    let acc = 0
    let out = ""
    for (const c of buf) {
      acc = (acc << 8) | c
      bits += 8
      while (bits >= 5) {
        bits -= 5
        out += A[(acc >> bits) & 31]
      }
    }
    return bits ? out + A[(acc << (5 - bits)) & 31] : out
  }
  const B = b32(Buffer.from(key, "latin1"))
  const bytes = [...Buffer.from(key, "latin1")]
  const pct = bytes.map((n, i) => (i % 3 === 0 ? `%${n.toString(16).padStart(2, "0")}` : String.fromCharCode(n))).join("")
  for (const echo of [B, B.match(/.{1,8}/g).join(" "), B.match(/.{1,8}/g).join("\n"), pct]) {
    assert.equal(signMessage({ code: 500, message: "签到失败 " + echo }, key), "签到失败 …", "the card carries no spelling of the token")
    assert.equal(scrubShapes(echo, ""), "…", "nor does a keyless shape pass")
  }
  const records = [
    { id: "a", display_name: B.slice(0, 90), context_window: 1000, protocol: "openai_chat_completions" },
    { id: "b", display_name: pct.slice(0, 90), context_window: 1000, protocol: "openai_chat_completions" },
    { id: "c", display_name: pct.slice(90), context_window: 1000, protocol: "openai_chat_completions" },
  ]
  const list = catalogOf({ code: 200, data: records }, key)
  const names = flatten((list ?? []).map((r) => r.name).join("")).replace(/[^A-Za-z0-9%._-]/g, "")
  assert.ok(!names.includes(B.slice(0, 90)) && !names.includes(pct.slice(0, 90).replace(/[^A-Za-z0-9%._-]/g, "").slice(0, 60)), "no spelling piece is served")
  const { exit, logs } = await genRun({ body: { code: 200, data: [{ id: "x", display_name: pct, context_window: 1000 }] }, token: key })
  assert.equal(exit, 2, "the generator writes nothing")
  assert.match(logs.join("\n"), /part of the account token|could not be cut/)
})

test("a base32 or percent split across model fields is no catalog", async () => {
  // The pieces are shorter than any window, and each field is a plain piece
  // of the encoding (or a piece with prose beside it): the token is there
  // once the pieces are put back together and decoded. The percent splits are
  // cut at widths that also break `%XX` into `%6` and `5`.
  const key = TOKEN
  const A = "abcdefghijklmnopqrstuvwxyz234567"
  const b32 = (buf) => {
    let bits = 0
    let acc = 0
    let out = ""
    for (const c of buf) {
      acc = (acc << 8) | c
      bits += 8
      while (bits >= 5) {
        bits -= 5
        out += A[(acc >> bits) & 31]
      }
    }
    return bits ? out + A[(acc << (5 - bits)) & 31] : out
  }
  const B = b32(Buffer.from(key, "latin1"))
  const pct = [...Buffer.from(key, "latin1")].map((n) => `%${n.toString(16).padStart(2, "0")}`).join("")
  const rows = (encoded, width) =>
    encoded.match(new RegExp(`.{1,${width}}`, "g")).map((piece, i) => ({ id: `m${String(i).padStart(2, "0")}`, display_name: piece, context_window: 1000, protocol: "openai_chat_completions" }))
  const cases = [
    ["base32", rows(B, 8)],
    ["percent", rows(pct, 10)],
    ["percent (12)", rows(pct, 12)],
    ["base32 (labeled)", rows(B, 6).map((r) => ({ ...r, display_name: `fence:${r.display_name}:fence` }))],
    ["percent (ids only)", rows(pct, 12).map((r) => ({ ...r, display_name: `model ${r.id}`, id: r.display_name }))],
    ["base32 (ids, long names)", rows(B, 8).map((r, i) => ({ ...r, id: r.display_name, display_name: `General language model for translators ${i} of the catalog` }))],
    ["base32 (prose after each piece)", rows(B, 8).map((r, i) => ({ ...r, display_name: `${r.display_name} ordinary model description ${i}`.padEnd(150, "x") }))],
    ["percent (prose after each piece)", rows(pct, 10).map((r, i) => ({ ...r, display_name: `${r.display_name} a model with a long description ${i}`.padEnd(150, "x") }))],
  ]
  for (const [label, data] of cases) assert.equal(catalogOf({ code: 200, data }, key), null, `${label}: the pieces in order are the token`)
  // A piece that is itself a window of the token is refused on its own (its
  // name falls back to the record's id), and the pieces left do not reassemble
  // the token: the served text keeps no run of the encoding across the hole.
  const wide = rows(pct, 16)
  const served = catalogOf({ code: 200, data: wide }, key)
  const decoded = (served ?? []).map((r) => r.name).join("").replace(/(?:%[0-9a-fA-F]{2})+/g, (run) =>
    Buffer.from(run.slice(1).split("%").join(""), "hex").toString("latin1"),
  )
  assert.ok(!decoded.includes(key), "the pieces left after a refused window do not spell the token")
  // a split across ids leaves the names clean, so the ids are read too
  const idRows = rows(B, 8).map((r) => ({ id: r.display_name, display_name: `m${r.id}` }))
  assert.equal(catalogOf({ code: 200, data: idRows }, key), null, "the pieces in order are the token, wherever they sit")
  // a piece behind a label in the id ("model-000-ey", two characters): the
  // list's opening is nowhere, and only the field-by-field read sees it.
  for (const [label, spelling] of [["raw", key], ["base32", B], ["percent", pct]]) {
    const data = spelling.match(/.{1,2}/g).map((piece, i) => ({ id: `model-${String(i).padStart(3, "0")}-${piece}`, display_name: `General language model for translators ${i}`, context_window: 1000, protocol: "openai_chat_completions" }))
    assert.equal(catalogOf({ code: 200, data }, key), null, `${label}: labeled two-character ids are the token`)
    // and through the live hook's final gate: the ids a hook would serve
    const p = await CodarPlugin()
    const models = await withFetch({ "/v1/codar/models": { body: { code: 200, data } } }, async () => p.provider.models({ models: {} }, { auth: { type: "api", key } }))
    const suffix = Object.keys(models)
      .filter((id) => id.startsWith("model-"))
      .sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]))
      .map((id) => id.split("-").slice(2).join("-"))
      .join("")
    assert.ok(!suffix.includes(key.slice(0, 40)) && suffix.length < spelling.length, `${label}: no run of the token is served under the labels`)
  }
  // ordinary models are not a split
  const ordinary = Array.from({ length: 12 }, (_, i) => ({ id: `model-${i}`, display_name: `Model ${i}`, context_window: 1000, protocol: "openai_chat_completions" }))
  assert.equal(catalogOf({ code: 200, data: ordinary }, key).length, 12, "ordinary ids and names are served")
})

// Six generator runs over a token split three ways; each run is a full
// in-process catalog pass, so this sits near Bun's five-second default and
// crossed it under load. The timeout is the run's, not the machine's.
test("the generator writes, checks and prints no split of the token", { timeout: 60000 }, async () => {
  const key = TOKEN
  const A = "abcdefghijklmnopqrstuvwxyz234567"
  const b32 = (buf) => {
    let bits = 0
    let acc = 0
    let out = ""
    for (const c of buf) {
      acc = (acc << 8) | c
      bits += 8
      while (bits >= 5) {
        bits -= 5
        out += A[(acc >> bits) & 31]
      }
    }
    return bits ? out + A[(acc << (5 - bits)) & 31] : out
  }
  const B = b32(Buffer.from(key, "latin1"))
  const pct = [...Buffer.from(key, "latin1")].map((n) => `%${n.toString(16).padStart(2, "0")}`).join("")
  const rows = (encoded, width, pad = "") =>
    encoded.match(new RegExp(`.{1,${width}}`, "g")).map((piece, i) => ({ id: `m${String(i).padStart(2, "0")}`, display_name: piece + (pad ? ` ${pad} ${i}`.padEnd(150, "x") : ""), context_window: 1000, protocol: "openai_chat_completions" }))
  for (const [label, data] of [["base32", rows(B, 8)], ["percent", rows(pct, 10)], ["base32 (padded)", rows(B, 8, "ordinary model description")]]) {
    const gen = await genRun({ body: { code: 200, data }, token: key })
    assert.equal(gen.exit, 2, `${label}: the generator writes nothing`)
    assert.equal(gen.after, null)
    // A file that already carries the pieces prints none of them: --check
    // reads the file's values as one list before its diff lines go out.
    const fileRows = data.map((r) => ({ id: String(r.id).replace(/[^\x20-\x7e]/g, " ").slice(0, 120), name: r.display_name, context: 1000, maxOutput: 0, input: ["text"], output: ["text"], protocol: "openai_chat_completions", reasoning: false }))
    const check = await genRun({
      body: { code: 200, data: data.map((r, i) => ({ ...r, id: `fresh-${i}`, display_name: "fresh" })) },
      seeded: render(sortRows(fileRows)),
      argv: ["--check"],
      token: key,
    })
    assert.equal(check.exit, 2, `${label}: --check refuses instead of printing the pieces`)
    assert.ok(!check.logs.join("\n").includes(data[1].display_name), `${label}: no piece reaches the terminal`)
    assert.match(check.logs.join("\n"), /part of the account token/)
  }
  // a split that alternates between a record's id and its name, the other
  // field carrying prose with a number a reader can restore the order from
  const filler = "ordinary model description ".repeat(4) + "x".repeat(80)
  for (const [label, spelling, width] of [["base32 (alternated)", B, 8], ["percent (alternated)", pct, 10]]) {
    const pieces = spelling.match(new RegExp(`.{1,${width}}`, "g"))
    const data = pieces.map((piece, i) => ({ id: i % 2 ? `filler-${i}` : piece, display_name: i % 2 ? piece + filler : `ordinary-${i} ${filler}`, context_window: 1000, protocol: "openai_chat_completions" }))
    const gen = await genRun({ body: { code: 200, data }, token: key })
    assert.equal(gen.exit, 2, `${label}: the generator writes nothing`)
    assert.equal(gen.after, null)
    const fileRows = data.map((r) => ({ id: String(r.id).replace(/[^\x20-\x7e]/g, " ").slice(0, 120), name: r.display_name, context: 1000, maxOutput: 0, input: ["text"], output: ["text"], protocol: "openai_chat_completions", reasoning: false }))
    const check = await genRun({
      body: { code: 200, data: data.map((r) => ({ ...r, display_name: "fresh" })) },
      seeded: render(sortRows(fileRows)),
      argv: ["--check"],
      token: key,
    })
    assert.equal(check.exit, 2, `${label}: --check refuses instead of printing the pieces`)
    assert.ok(!check.logs.join("\n").includes(data[1].display_name), `${label}: no piece reaches the terminal`)
  }
  // an id a reader can number (m0, m1, … m10) puts the printed lines back in
  // token order even though the file sorts them by letters: --check reads
  // that order too, and prints nothing.
  const numbered = pct.match(/.{1,10}/g).map((piece, i) => ({ id: `m${i}`, display_name: piece, context_window: 1000, protocol: "openai_chat_completions" }))
  const numberedRows = numbered.map((r) => ({ id: r.id, name: r.display_name, context: 1000, maxOutput: 0, input: ["text"], output: ["text"], protocol: "openai_chat_completions", reasoning: false }))
  const numberedCheck = await genRun({
    body: { code: 200, data: numbered.map((r, i) => ({ ...r, id: `fresh-${i}`, display_name: "fresh" })) },
    seeded: render(sortRows(numberedRows)),
    argv: ["--check"],
    token: key,
  })
  assert.equal(numberedCheck.exit, 2, "the numbered order is read too")
  assert.ok(!numberedCheck.logs.join("\n").includes(numbered[1].display_name), "and no piece is printed")
})

test("a model named sk-<words> is a model, not a secret", async () => {
  const key = TOKEN
  const list = catalogOf(
    {
      code: 200,
      data: [
        { id: "sk-whisper-large-v3", display_name: "Whisper Large v3", context_window: 1000, protocol: "openai_chat_completions" },
        { id: "sk-swedish-translation-8b", context_window: 1000, protocol: "openai_chat_completions" },
      ],
    },
    key,
  )
  assert.deepEqual(list.map((m) => m.id), ["sk-whisper-large-v3", "sk-swedish-translation-8b"])
  assert.equal(scrub("key sk-whisper-large-v3 is listed", key), "key sk-whisper-large-v3 is listed", "the name reads on the card")
  assert.equal(scrub("bad sk-abcdefghijklmnopqrstuvwx", key), "bad …", "a key's body still goes")
  assert.equal(scrub("bad sk-proj-Ab3xY9Qw", key), "bad …", "and a mixed-case one")
})

test("a long-name catalog is read inside the host's models budget", { timeout: 30000 }, async () => {
  // 1000 records, names of thousands of characters each: the hook reads each
  // field to the width a served field can carry, so the work is the records'
  // number, not their bytes.
  const words = ["General language model for", "able translator", "DeepSeek model", "long ordinary description"]
  const data = Array.from({ length: 400 }, (_, i) => ({
    id: `long-${String(i).padStart(4, "0")}`,
    display_name: (words[i % 4] + " ").repeat(240).slice(0, 7000),
    context_window: 128000,
    protocol: { type: "openai_chat_completions" },
  }))
  const p = await CodarPlugin()
  const t0 = process.hrtime.bigint()
  const list = await withFetch({ "/v1/codar/models": { body: { code: 200, data } } }, async () => p.provider.models({ models: {} }, { auth: { type: "api", key: TOKEN } }))
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  assert.equal(Object.keys(list).length, 400, "every record is served")
  assert.ok(ms < 20000, `the hook took ${ms.toFixed(0)} ms against the host's 20 s`)
  assert.ok(!list["long-0000"].name.startsWith("long-"), "a name is served, not blanked")
})

test("the generator refuses a two-character split the live hook already refuses", async () => {
  const key = TOKEN
  const data = key.match(/[\s\S]{1,2}/g).map((piece, i) => ({ id: `m${i}`, display_name: `fence:${piece}:fence`, context_window: 1000, protocol: "openai_chat_completions" }))
  const { exit, logs, after } = await genRun({ body: { code: 200, data }, token: key })
  assert.equal(exit, 2, "the pieces in order are the token: nothing is written")
  assert.match(logs.join("\n"), /part of the account token/)
  assert.equal(after, null)
})

test("the vendor's rate badge is a model's rate, live and in the catalog file", async () => {
  // The vendor states each model's credit multiple as rate_badge ("0.20x");
  // its own client shows it by the model, and magpie reads a plugin model's
  // rate (host.js's rateOf) — the plugin dropped it, so the badge never
  // appeared. A number is what the host documents; the badge's own spelling
  // is accepted too.
  const list = catalogOf(
    {
      code: 200,
      data: [
        { id: "m", display_name: "M", context_window: 1000, protocol: { type: "openai_chat_completions" }, rate_badge: "0.20x" },
        { id: "n", display_name: "N", context_window: 1000, protocol: { type: "openai_chat_completions" }, rate_badge: "1.50x" },
        { id: "o", display_name: "O", context_window: 1000, protocol: { type: "openai_chat_completions" } },
        { id: "p", display_name: "P", context_window: 1000, protocol: { type: "openai_chat_completions" }, rate_badge: "free" },
      ],
    },
    "",
  )
  assert.deepEqual(list.map((m) => m.rate), [0.2, 1.5, 0, 0], "a number for the badge, 0 where none is stated")
  const models = Object.fromEntries(list.map((r) => [r.id, modelOf(r, "https://api.claw.speedai.com/v1")]))
  assert.equal(models.m.rate, 0.2, "the model the host reads carries the rate")
  assert.equal(models.o.rate, 0, "a model without a badge says none")
  // The models hook reads a rate the way every other number here is read: a
  // number or a string that says one. A boolean or an array is not a rate,
  // and Number(true) would have told the host this model costs 1x.
  assert.equal(modelOf({ id: "t", rate: true }, "https://api.claw.speedai.com/v1").rate, 0, "a boolean is not a rate")
  assert.equal(modelOf({ id: "a", rate: [0.8] }, "https://api.claw.speedai.com/v1").rate, 0, "an array is not a rate")
  assert.equal(modelOf({ id: "s", rate: "0.35" }, "https://api.claw.speedai.com/v1").rate, 0.35, "a string that says one still does")
  assert.equal(modelOf({ id: "z", rate: "free" }, "https://api.claw.speedai.com/v1").rate, 0, "and one that does not says none")
  const p = await CodarPlugin()
  const live = await withFetch({ "/v1/codar/models": { body: { code: 200, data: [{ id: "m", display_name: "M", context_window: 1000, rate_badge: "0.20x" }] } } }, async () => p.provider.models({ models: {} }, { auth: { type: "api", key: TOKEN } }))
  assert.equal(live.m.rate, 0.2, "and the live hook serves it")
  // the generator writes the field, and reads its own file back
  const { exit, after } = await genRun({ body: { code: 200, data: [{ id: "m", display_name: "M", context_window: 1000, rate_badge: "0.20x" }] } })
  assert.equal(exit, 0)
  assert.match(String(after), /"rate": 0\.2/, "the embedded catalog keeps it")
  const check = await genRun({ body: { code: 200, data: [{ id: "m", display_name: "M", context_window: 1000, rate_badge: "0.20x" }] }, seeded: after, argv: ["--check"] })
  assert.equal(check.exit, 0, "--check reads the field back")
  // 0 is "not listed", not a rate: a model the vendor does not badge carries
  // no rate key in the file, and a later badge shows up as a change.
  const none = await genRun({ body: { code: 200, data: [{ id: "m", display_name: "M", context_window: 1000 }] } })
  assert.equal(none.exit, 0)
  assert.doesNotMatch(String(none.after), /"rate"/, "a model with no badge is written without rate")
  assert.equal((await genRun({ body: { code: 200, data: [{ id: "m", display_name: "M", context_window: 1000 }] }, seeded: none.after, argv: ["--check"] })).exit, 0, "--check agrees with the file it wrote")
  assert.equal((await genRun({ body: { code: 200, data: [{ id: "m", display_name: "M", context_window: 1000, rate_badge: "0.20x" }] }, seeded: none.after, argv: ["--check"] })).exit, 1, "a badge the file does not carry is a change to regenerate for")
  // a 0 rate is not a rate this script writes, and a file carrying one is a
  // file it cannot compare (a hand edit): exit 2, not "up to date".
  const zero = String(after).replace('"rate": 0.2', '"rate": 0')
  assert.equal((await genRun({ body: { code: 200, data: [{ id: "m", display_name: "M", context_window: 1000, rate_badge: "0.20x" }] }, seeded: zero, argv: ["--check"] })).exit, 2, "a file with rate 0 is refused, not compared")
})

// The vendor's own requests go through the desktop's transport when it is
// there: request() hands it what it hands fetch (the same init), and what it
// answers is the answer. The fetch behind it is never called — a request that
// goes out twice is the one failure this path must not have.
test("a vendor request the desktop's transport answers does not reach fetch", async () => {
  const seen = []
  const answer = { code: 200, data: [] }
  testables.nativeFetch = async (url, init) => {
    seen.push({ url, init })
    return new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } })
  }
  try {
    let fetched = 0
    const r = await testables.request("https://api.claw.speedai.com/v1/codar/models", {
      token: TOKEN,
      fetchImpl: async () => {
        fetched++
        return new Response("{}", { status: 200 })
      },
    })
    assert.deepEqual(r, answer)
    assert.equal(fetched, 0, "fetch was called although the native transport answered")
    assert.equal(seen.length, 1)
    assert.equal(seen[0].url, "https://api.claw.speedai.com/v1/codar/models")
    assert.equal(seen[0].init.method, "GET")
    assert.equal(seen[0].init.headers.Authorization, `Bearer ${TOKEN}`)
    assert.equal(seen[0].init.headers["Content-Type"], "application/json")
  } finally {
    testables.nativeFetch = null
  }
})

// A transport that cannot run is not an error: the request is the plugin's
// own fetch, the same call it made before the native path existed.
test("a native transport that cannot run leaves the request to fetch", async () => {
  let asked = 0
  testables.nativeFetch = async () => {
    asked++
    const e = new Error("no binary")
    e.name = "NativeUnavailable"
    throw e
  }
  try {
    const r = await testables.request("https://api.claw.speedai.com/v1/codar/models", {
      token: TOKEN,
      fetchImpl: async (url, init) => {
        assert.equal(init.method, "GET")
        return new Response(JSON.stringify({ code: 200, data: [] }), { status: 200 })
      },
    })
    assert.deepEqual(r, { code: 200, data: [] })
    assert.equal(asked, 1, "the native transport was not asked first")
  } finally {
    testables.nativeFetch = null
  }
})

// An answer that came back is not asked again: a native transport that fails
// mid-request (a reset, a TLS refusal) is that failure, not a signal to send
// the same POST a second time through fetch.
test("a native transport that answers with an error does not fall back", async () => {
  testables.nativeFetch = async () => {
    throw new Error("connection reset")
  }
  try {
    let fetched = 0
    await assert.rejects(
      testables.request("https://api.claw.speedai.com/v1/daily-sign", {
        method: "POST",
        body: { username: "user_1" },
        token: TOKEN,
        fetchImpl: async () => {
          fetched++
          return new Response("{}", { status: 200 })
        },
      }),
      /connection reset/,
    )
    assert.equal(fetched, 0, "a failed request was sent again through fetch")
  } finally {
    testables.nativeFetch = null
  }
})
