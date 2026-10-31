// The plugin against a fake Codar: every request goes to a stub, nothing here
// talks to speedai. Fixtures follow the clock, so they don't expire on a day.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import CodarPlugin, { testables } from "../index.mjs"
import * as mod from "../index.mjs"

const { tokenOf, usernameOf, expiresAt, modelOf, catalogOf, mergeModel, publishedConcurrency, humanSecs, payloadOf, request, appToken, configPath } = testables

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
  const calls = []
  const routesAt = Object.entries(routes).map(([key, answer]) => {
    const cut = key.indexOf(" ")
    const named = cut > 0 && /^[A-Z]+$/.test(key.slice(0, cut))
    return { method: named ? key.slice(0, cut) : "", url: named ? key.slice(cut + 1) : key, answer }
  })
  globalThis.fetch = async (url, init) => {
    const u = String(url)
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
  assert.equal(tokenOf({ type: "oauth", key: "eyJabc.def.ghi" }), "")
  assert.equal(tokenOf(null), "")
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
  // The vendor's own check-in reads the answer through Jo alone (app.asar's
  // nRe): only a code that is a number other than 200 is a refusal, so an
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
  // is the HTTP layer saying yes and the vendor saying no — "HTTP 层说好、
  // 业务层说不" — so the flag decides, not the code. It used to be consulted
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
})

test("an already-claimed answer is read in every spelling the vendor's client reads", async () => {
  // The vendor's client reads an answer's words as the first of message, msg,
  // error, detail — and the same four under `data` (app.asar's Vg). Read as
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
  // than 200 before it reads the list (app.asar's Hbt calls Jo first), so a
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
  // one (app.asar's ZAe: typeof i == "number" ? i : Number(i)). Read as a
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
    assert.doesNotThrow(() => new Date(r.until).toISOString(), "and one the host can turn into an ISO string")
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
  assert.ok(win.resetsAt > Date.now())
})

test("a balance that cannot be read fails the read, it does not become 0", async () => {
  const p = await CodarPlugin()
  const u = await withFetch({ "/v1/gettoken": { status: 500, body: { detail: "boom" } } }, async () => p.auth.usage(auth))
  assert.ok(u.error, "an unreadable balance is an error, not an empty card")
})

test("the claim row reads the vendor client's own spellings", async () => {
  // The vendor's client (app.asar's ayt) reads the state as the boolean data
  // itself or from any of four field names, each only as a real boolean. A
  // rename its client still handles must not turn a claimed day into "还没领".
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
})

test("the balances are read by the vendor client's own names", async () => {
  // app.asar's Xbt reads general points by token/remaining_points/points/
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
  // "-5 点" on the card beside a routing figure of 0 — two answers, neither
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

  // The vendor's words are read the way its client reads them (Vg): any of
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
  assert.equal(free[0].used, 0, "an unlimited activity has no share to tell")
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
  // The card waits for the slowest read, not for three in a row. All three
  // are launched before any is awaited: a points read that fails must not
  // stop the other two from having been asked, and the three must overlap
  // in flight (inFlight reaches 3) rather than run one after another.
  const p = await CodarPlugin()
  const seen = []
  let inFlight = 0
  let most = 0
  const real = globalThis.fetch
  globalThis.fetch = async (url) => {
    seen.push(String(url))
    inFlight++
    most = Math.max(most, inFlight)
    // all three must be in before any answer goes out; a serial run would
    // hold each of these until the timeout
    await new Promise((ok) => setTimeout(ok, 15))
    inFlight--
    if (String(url).includes("/v1/gettoken")) return new Response(JSON.stringify({ detail: "boom" }), { status: 500 })
    if (String(url).includes("/v1/daily-sign/status")) return new Response(JSON.stringify({ code: 200, data: { isSigned: true, retry_after: 60 } }), { status: 200 })
    return new Response(JSON.stringify({ code: 200, data: [] }), { status: 200 })
  }
  try {
    const u = await p.auth.usage(auth)
    assert.ok(u.error, "the balance failing is the card's error")
    assert.equal(seen.length, 3, "all three were launched, not the balance first and the rest after")
    assert.equal(most, 3, "the three overlapped in flight, not one after another")
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
      "deepseek-v4.1-flash": modelOf({ id: "deepseek-v4.1-flash" }),
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
  assert.equal(fresh["deepseek-v4.1-flash"], undefined, "a model the vendor dropped is gone")
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
    models: { "deepseek-v4.1-flash": modelOf({ id: "deepseek-v4.1-flash" }, "https://only-this-one.example/v1") },
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
  assert.equal(fresh["deepseek-v4.1-flash"].api.url, "https://only-this-one.example/v1", "a model's own base wins over the provider's")
  assert.equal(fresh["new-model"].api.url, "https://proxy.example/v1", "one without takes the provider's, not the vendor's")
  const bare = await withFetch(
    { "/v1/codar/models": { body: { catalog: { data: [{ id: "solo", protocol: { type: "openai_chat_completions" } }] } } } },
    async () => p.provider.models({ id: "codar", models: {} }, { auth: await auth() }),
  )
  assert.equal(bare["solo"].api.url, "https://api.claw.speedai.com/v1", "with nothing set anywhere, the vendor's gateway")
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
  assert.ok(config.provider.codar.models["deepseek-v4.1-flash"])
  assert.ok(config.provider.codar.models["claude-opus-5"], "the anthropic models are listed too")
})

test("the config hook writes the user's own base onto each model", async () => {
  // host.js reads a config model's base as m.provider?.api ?? cfg.api — not
  // the model's own api.url — so the proxy held on that path either way. The
  // models the hook stores still say the address their requests will go to:
  // a file that names the vendor's gateway under a provider pointed
  // elsewhere is a file that lies about the next start.
  const p = await CodarPlugin()
  const config = { provider: { codar: { api: "https://proxy.example/v1" } } }
  await p.config(config)
  assert.equal(config.provider.codar.api, "https://proxy.example/v1", "the provider keeps the user's api")
  assert.equal(config.provider.codar.models["deepseek-v4.1-flash"].api.url, "https://proxy.example/v1", "and each model is written at it, not at the vendor's gateway")
  assert.equal(config.provider.codar.models["claude-opus-5"].api.npm, "@ai-sdk/anthropic", "the per-model SDK is unaffected")
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
  const opus = merged("claude-opus-5")
  assert.equal(opus.reasoning, true, "the config-path list kept reasoning")
  const flash = merged("deepseek-v4.1-flash")
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
  assert.deepEqual(config.provider.codar.models["my-model"], { name: "自建" }, "the user's own model entry survives")
  assert.ok(config.provider.codar.models["deepseek-v4.1-flash"], "the catalog is still filled in")
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
    assert.ok(config.provider.codar.models["deepseek-v4.1-flash"])
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
  // Infinity — "1.15e+303 天后可再领" is not a thing a card says.
  assert.equal(humanSecs(Infinity), "", "an infinity is not \"Infinity 天\"")
  assert.equal(humanSecs(1e308), "", "nor is 1e308 \"1.15e+303 天\"")
  assert.match(humanSecs(1e11), /天/, "a long wait a calendar can still say is said")
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

test("the read-from-this-machine sign-in hands magpie a key, and says why when it can't", async () => {
  const p = await CodarPlugin()
  const [read, paste] = p.auth.methods
  assert.equal(read.keyless, true, "magpie skips the key prompt for a keyless method")
  assert.equal(typeof read.authorize, "function")
  assert.equal(paste.keyless, undefined, "pasting stays a plain key method")
  assert.deepEqual(
    p.auth.methods.map((m) => m.label),
    ["读取本机科搭令牌", "科搭访问令牌"],
    "both buttons lead with the vendor's name and say which token each one takes",
  )

  // a file the app would leave: nested provider → speedai → token
  const dir = mkdtempSync(join(tmpdir(), "codar-plugin-"))
  const file = join(dir, "config.json")
  const token = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 86400 })
  writeFileSync(file, JSON.stringify({ provider: { speedai: { token, username: "user_1" } } }))
  try {
    assert.equal(appToken(file).token, token, "the token is handed over as it is")
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
      const none = await read.authorize()
      assert.equal(none.type, "failed", "no file is a refusal with words")
      assert.match(none.error, /没找到/)

      const old = mkToken({ username: "user_1", exp: Math.floor(Date.now() / 1000) - 60 })
      writeFileSync(file, JSON.stringify({ provider: { speedai: { token: old } } }))
      const lapsed = await read.authorize()
      assert.equal(lapsed.type, "failed", "the lapsed token is refused, not handed to magpie")
      assert.match(lapsed.error, /已过期/)

      writeFileSync(file, JSON.stringify({ provider: { speedai: { token } } }))
      assert.deepEqual(await read.authorize(), { type: "success", key: token }, "the app's own token, handed over")
      assert.deepEqual(await read.authorize({ file: join(dir, "other.json") }), { type: "success", key: token }, "an argument names no other file: the path is the app's own")
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
  // outcome, credit, streak and message, so a signIn here would be written
  // and never read. What marks an account is usage's.
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
  assert.equal(r.credit, 0)
})

test("a reward that lands on the agent points is reported, and a fall is not a reward", async () => {
  // The vendor only says a claim gives "点数奖励" — it does not say which
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
  // — a read that asked anyway showed "点数查询失败" instead of "sign in".
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
  assert.ok(Buffer.byteLength(JSON.stringify(fresh)) < 32 * 1024 * 1024, "and the answer fits the host's line")
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
  assert.ok(Buffer.byteLength(JSON.stringify(u)) < 32 * 1024 * 1024)
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
  // retry_after: 1e999 is valid JSON and parses to Infinity; "Infinity 天后
  // 可再领" is not a thing a card should say.
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
  assert.equal(free.used, 0, "no share invented from numbers nobody can use")
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
  // free_until: 1e999 is valid JSON that reads as Infinity, so the activity
  // passes the vendor app's own rule (a future free_until) but its end time
  // cannot be written down. The row is still reported; the epoch is not.
  const p = await CodarPlugin()
  const u = await withFetch(
    {
      "/v1/gettoken": { body: { code: 200, token: 500, agent_token: 0 } },
      "/v1/daily-sign/status": { body: { code: 200, data: { isSigned: true, retry_after: 3600 } } },
      "/api/codar/activities/mine": () =>
        new Response('{"code":200,"data":[{"status":"active","free_until":1e999,"remaining_quota":null,"model_ids":["a"]}]}', { status: 200, headers: { "Content-Type": "application/json" } }),
    },
    async () => p.auth.usage(auth),
  )
  const free = u.windows.find((w) => w.name.startsWith("免费模型"))
  assert.ok(free, "the activity is still reported: it is running")
  assert.equal("resetsAt" in free, false, "without a reset time the host would draw as 1970")
  assert.equal(free.display, "免费使用中（不限量）")
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
  const config = { provider: { codar: { models: { "claude-opus-5": { name: "我的名字" } } } } }
  await p.config(config)
  const m = config.provider.codar.models["claude-opus-5"]
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
          "claude-opus-5": { provider: { api: "https://proxy.example/v1" } },
          "glm-5.2": { limit: { output: 4096 } },
        },
      },
    },
  }
  await p.config(config)
  const opus = config.provider.codar.models["claude-opus-5"]
  assert.equal(opus.provider.api, "https://proxy.example/v1", "the address the user set")
  assert.equal(opus.provider.npm, "@ai-sdk/anthropic", "and the SDK that address still needs")
  assert.equal(opus.limit.context, 1000000, "the catalog's limit is untouched")
  const glm = config.provider.codar.models["glm-5.2"]
  assert.equal(glm.limit.output, 4096, "the ceiling the user set")
  assert.equal(glm.limit.context, 1000000, "beside the context window the catalog stated")
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
  const config = {
    provider: {
      codar: {
        models: {
          "claude-opus-5": null,
          "deepseek-v4-pro": "not a model",
          "glm-5.2": 7,
          "glm-5.3": ["not", "a", "model"],
          "my-own": { id: "my-own", name: "Mine" },
        },
      },
    },
  }
  await p.config(config)
  const models = config.provider.codar.models
  for (const id of ["claude-opus-5", "deepseek-v4-pro", "glm-5.2", "glm-5.3"]) {
    assert.equal(models[id]?.id, id, `${id} is the catalog's own entry, not the broken one`)
    assert.ok(models[id].provider?.npm, `${id} still carries the fields the host reads`)
  }
  assert.equal(models["my-own"].name, "Mine", "a model of the user's own is kept")
  assert.equal(Object.keys(models).length, 17, "16 catalog models and the user's one")

  const other = { provider: { codar: { models: [{ id: "x" }] } } }
  await p.config(other)
  assert.equal(Object.keys(other.provider.codar.models).length, 16, "an array of models is no model map")
})

test("a points answer whose code is not 200 is a refusal, not a balance of 0", async () => {
  // The vendor's own client refuses any answer whose code is a number other
  // than 200 before it reads the balances (app.asar's Jo: Number(e.code),
  // finite and not 200, throws). Read only as ">= 400 is an error", a
  // refusal spelled {code: 1, token: 0} came out as "0 点", and routing took
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
  assert.equal(r.credit, 0)
})

test("the balances are read from data when the vendor wraps them, as its client does", async () => {
  // The vendor's client unwraps `data` when it is an object (app.asar's Fc)
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
  // than 200 (app.asar's tRe: Jo before ayt) and reads nothing from it.
  // Drawn from data alone, {code: 500, data: {isSigned: false}} said "现在
  // 可以领" — an offer the vendor would have refused.
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
  // was said as "1 秒后可再领" and an array as an hour. The vendor's own
  // client takes a number or a string that says one (app.asar's B0).
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
  // With remaining_quota unreadable, the card fell to "不限量" and dropped
  // the total — the vendor said a number and the card said there is none.
  // The total is now said; only with no total at all is it unlimited. And a
  // remaining that exceeds the total is not a share: magpie would draw
  // "已用 0 / 100" beside the vendor's "150 left".
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
})

test("the seven promises no test used to pin", async () => {
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
  assert.equal(base["solo"].api.url, "https://proxy.example/v1", "a trailing slash is taken off the user's own base")
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
  assert.equal(Object.keys(models).length, 16, "the catalog is what is listed")
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
  for (const [typed, clean] of [
    ["https://proxy.example/v1/", "https://proxy.example/v1"],
    ["  https://proxy.example/v1  ", "https://proxy.example/v1"],
    ["https://proxy.example/v1//", "https://proxy.example/v1"],
    ["https://proxy.example", "https://proxy.example"],
    ["   ", "https://api.claw.speedai.com/v1"],
    ["/", "https://api.claw.speedai.com/v1"],
    ["///", "https://api.claw.speedai.com/v1"],
    [42, "https://api.claw.speedai.com/v1"],
    [undefined, "https://api.claw.speedai.com/v1"],
  ]) {
    const config = { provider: { codar: { api: typed } } }
    await p.config(config)
    assert.equal(config.provider.codar.api, clean, `config: ${JSON.stringify(typed)}`)
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

// Three promises the README makes that the suite stayed green without
// (mutation-tested in round 9: each change below left 102/102 passing).
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

// The config path builds its model list from catalog.mjs, which cannot carry
// a magic id today — but the guard there exists for the day catalog.mjs is
// regenerated from the vendor and can. CATALOG is an import binding a test
// cannot swap, so this loads a copy of the plugin whose catalog.mjs holds a
// `__proto__` record and checks the guard against that copy.
test("a regeneration that put a __proto__ id in the catalog does not become the map's prototype", async () => {
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
    for (const f of ["index.mjs", "catalog.mjs", "package.json"]) cpSync(join(here, f), join(root, f))
    const cat = readFileSync(join(root, "catalog.mjs"), "utf8")
    writeFileSync(join(root, "catalog.mjs"), cat.replace(/export const CATALOG = \[/, 'export const CATALOG = [\n  { "id": "__proto__", "name": "E", "context": 1, "maxOutput": 1, "input": ["text"], "output": ["text"], "protocol": "openai_chat_completions", "reasoning": false },') )
    const { default: Other } = await import(pathToFileURL(join(root, "index.mjs")).href)
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
  const { CATALOG } = await import("../catalog.mjs")
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
