// The plugin's internal readers, kept out of index.mjs on purpose.
//
// OpenCode 1.x takes every export of the entry module for a plugin and
// refuses the package when one is not — and magpie runs OpenCode's provider
// plugins. The test hooks (the `testables` object) are an export, so they
// live here and index.mjs imports from this file; the entry module exports
// only the plugin function. Nothing here is a plugin entry: magpie never
// loads this file directly.

import { CATALOG } from "./catalog.mjs"
import { guardedFetch } from "./guarded.mjs"
import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, relative, sep } from "node:path"

export const ID = "codar"

// Chat and the catalog go through the claw gateway; account, check-in and
// points go through kuaipaper. The desktop app splits them the same way:
// in main.cjs the target "speedai" takes the former, every other /v1/ the
// latter.
export const API = "https://api.claw.speedai.com"
export const ACCOUNT = "https://api.kuaipaper.com"

export const CATALOG_PATH = "/v1/codar/models"
export const ACTIVITIES_PATH = "/api/codar/activities/mine"
export const SIGN_PATH = "/v1/daily-sign"
export const SIGN_STATUS_PATH = "/v1/daily-sign/status"
export const POINTS_PATH = "/v1/gettoken"
export const AGENT_POINTS_PATH = "/v1/agent/balance"

// The User-Agent each request leaves with is Go's, because the plugin's own Go
// transport answers the official hosts (native.mjs): what request() sets below
// is dropped by the proxy, which writes the headers the desktop's sidecar
// writes. The string still matters on the fallback path — a platform with no
// native build — and each one is kept as the closest thing that path can claim:
//   - chat would be the Go sidecar on a real desktop, so the hook in index.mjs
//     (chat.headers) marks it "Go-http-client/1.1"
//   - catalog, account, check-in, points and activities are handed by 0.3.17's
//     Electron main to the same sidecar (cloud-network.cjs's fetchAuth posts
//     them to /api/desktop/cloud-auth-request), so on that wire they are Go's
//     too; "node" only names the Electron fetch path the app keeps for a host
//     outside its four, which these are not.
// The goal is for requests to look like the App's own traffic, not like an
// unfamiliar client.
export const UA_SIDECAR = "Go-http-client/1.1"
export const UA_DESKTOP = "node"

// Timing: magpie's Go side gives one usage read 20 seconds (plugin_usage.go's
// context.WithTimeout) and one check-in 2 minutes (workbuddy_checkin.go). The
// plugin's timeout has to fire first: if the host cuts the read off first,
// the card shows the host's timeout rather than the plugin's own "request
// timed out".
//
// Those 20 seconds cover more than this hook: before calling it the host runs
// fresh() and infoOf(), and infoOf runs the models hook when the cache is
// cold (host.js's info() has no time limit when no limit is given), while the
// plugin's usage budget only starts inside the hook and cannot cover that
// stretch. So the usage hook's worst case has to fit inside these 8 seconds:
// the four reads (two balances + check-in status + activities) are issued at
// the same instant, so the worst case is one TIMEOUT_MS, not two. The
// vendor's own client sends them the same way (app.asar's S0 runs
// /v1/gettoken, /v1/agent/balance and /api/user/self through allSettled);
// adding one more serially would double the worst case — 8 seconds of lead-in
// plus a 16-second hook busts the 20 seconds, and the card would show the
// host's deadline instead of the plugin's words.
//
// The check-in's three reads are serial, so the worst case is three
// TIMEOUT_MS (a 25-second budget, which leaves room inside the host's 2
// minutes). The budget is the overall cap; each single timeout is
// min(TIMEOUT_MS, what the budget has left), and once the budget is spent the
// remaining requests get 1 second. The tests do not read these constants;
// they measure the timeout each request received from the timer request()
// actually set, so "this path switched to a different number" gets caught.
//
// The usage path's four reads are issued at the same instant (four opts()
// calls in a row inside the Promise.allSettled array literal, with no await
// between them), so left() always gets the whole TIMEOUT_MS today — the
// budget and the 1-second floor on this path clamp nobody; they are ceilings,
// not branches that get taken (setting the floor to 0 is all green too, so
// this is not a gap in the tests). What really needs pinning on this path is
// "each of the four gets that cap", and the tests measure it from the timers
// request() set. What actually uses "what the budget has left" is the
// check-in's three serial reads: when the earlier read is slow, the later
// ones get only the smaller share, at least 1 second.
export const TIMEOUT_MS = 8000
export const CHECKIN_BUDGET_MS = 25 * 1000
export const USAGE_BUDGET_MS = 18 * 1000
export const HOST_USAGE_DEADLINE_MS = 20 * 1000
export const HOST_CHECKIN_DEADLINE_MS = 120 * 1000

// MAX_TIME_MS is the largest time that survives the whole trip to magpie.
// Two ceilings matter, and the lower one wins: JS's Date.toISOString() throws
// past 8.64e15 ("Invalid time value"), and magpie's own side parses the ISO
// string with Go's RFC3339 layout, which has four year digits — a "+275760-…"
// string parses to zero and the time is dropped in silence. 253402300799999
// is 9999-12-31T23:59:59.999Z, the last instant both accept.
export const MAX_TIME_MS = 253402300799999

// safeTime is a stated number of milliseconds when it is a time magpie can
// read (see MAX_TIME_MS), and 0 — "not stated" — when it is not: not a
// number, not positive, or past the last instant both ends accept. A time
// past the calendar is not clamped to it: 9999-12-31 is not a moment the
// vendor stated, and rounding an unwritable time to a wrong one is what
// every other field here refuses to do. 0 is what makes the caller leave the
// field out — and what keeps the host's `new Date(ms).toISOString()` from
// throwing RangeError on a "+275760-…". Each caller bounds the wait first
// (secsOf and the per-window caps), so this is the last gate, not the first.
export const safeTime = (ms) => {
  // A boolean or an array is not a time: Number(true) is 1 and Number([3600])
  // is 3600, and an invented instant is worse than none — the card would say
  // a moment in 1970 that the vendor never stated. numOf is that rule, and it
  // still reads a number or a string that says one.
  const n = numOf(ms)
  return isFinite(n) && n > 0 && n <= MAX_TIME_MS ? n : 0
}

// MAX_WAIT_SECS is the longest wait a card can say: a wait past the last time
// magpie can read (year 9999). humanSecs says one past it as nothing —
// "1.1574074074074072e+303 天后" is not a thing a card says — and the seconds
// the plugin hands it are already bounded by that window's own cap.
export const MAX_WAIT_SECS = MAX_TIME_MS / 1000

// numOf is a vendor field as a number, read the way its own client reads one
// (app.asar's Po): a number, or a string that says one. A boolean, an array
// or an object is not one — Number(true) is 1 and Number([3600]) is 3600, and
// a made-up second is a made-up wait. NaN when there is no number.
export const numOf = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN)

// codeOf is a vendor business code as the vendor's own client reads it
// (app.asar's ft: `const o = Number(e.code)`). Unlike a balance or a wait,
// the client counts every value Number() can read — null and "" are 0, true is
// 1, [] is 0, [400] is 400 — and refuses any finite code that is not 200.
// Reading those as "no code" (which numOf does, and which is right for a
// balance) turned a refusal into a balance of 0 and a failed check-in into a
// claim. Objects are still not read: Number() would call valueOf/toString and
// a hostile body could throw out of a hook; they answer NaN, "no code", as the
// client does when the field is missing. Answers come from JSON.parse, so an
// array's elements are plain values.
// refusedCode reads a business code as a refusal: any code the answer stated
// that is not 200. NaN is "no code" — the field is absent, or its shape is
// not a code — while Infinity is a code: JSON `1e999` parses to it, and a
// gate written as `refusedCode(code)` read it as absent
// and accepted the refused answer (a catalog, a balance, a claim).
export const refusedCode = (code) => !Number.isNaN(code) && code !== 200

export const codeOf = (v) => {
  if (typeof v === "number") return v
  if (typeof v === "string" || typeof v === "boolean" || v === null || Array.isArray(v)) {
    try {
      return Number(v)
    } catch {
      return NaN
    }
  }
  return NaN
}

// plain is a value that is a map: an object, but not an array (an array is
// an object too, and writing a named field on it would be JSON.stringify'd
// away) and not null. What the host builds a config model from, and what a
// vendor record has to be to be read field by field.
export const plain = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v)

// secsOf is a vendor field as a number of seconds, or 0 — "not stated" — when
// it is not one: a value that is not a number (numOf), a zero, or a negative.
// A zero reads as "not stated" because a window with no wait is drawn in its
// own words ("现在可以领"), not as a time. What a particular window will trust
// is not this function's business: the check-in caps a wait at a week
// (checkinWaitSecs), and every time goes through safeTime before a card sees
// it — a number past the calendar comes out of there as 0, not as year 9999.
export const secsOf = (v) => {
  const n = numOf(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// MAX_CHECKIN_WAIT_SECS is the longest wait the daily check-in can name.
// Codar's day is a rolling 24 hours (measured retry_after ≈ 23 h), so a wait
// past a week is not a next-claim time that window can produce. Trusting it
// would settle the check-in for as long as the vendor's number says — 1e9
// seconds is 31 years, and magpie would not ask again until 2058 — so such a
// number is treated as one we cannot use, like a missing one.
export const MAX_CHECKIN_WAIT_SECS = 7 * 24 * 3600
export const checkinWaitSecs = (v) => {
  const n = secsOf(v)
  return n > 0 && n <= MAX_CHECKIN_WAIT_SECS ? n : 0
}

// ALREADY_CLAIMED is how the vendor words "this day is already claimed": its
// 400 says "24小时内仅可领取一次", and the same words on an answer that names
// no code mean the same thing. Its answers come back in English too (the
// status endpoint's "Already signed" is one), so both languages are read
// here, and the pairing in the check-in (a 400 beside a readable retry_after)
// covers a wording this list has never seen.
//
// "24小时" alone is not the phrase: a maintenance notice ("预计24小时后恢复")
// says 24 hours about something else, and reading it as "already claimed"
// settles the day off an outage. The digit is anchored so a bare "24小时" in
// "124小时" is not the window either, and next to the window the claim has to
// be said with the qualifier (仅/只能/才) or the "一次" — rather than the
// window merely being followed somewhere by "领取/签到":
// "24小时后可恢复领取" and "24小时内暂停签到" are about something else too. A
// sentence that says "仅可领取一次" with no window is the claim statement
// itself (the vendor has worded it both ways), so that branch stands alone.
// The Chinese "today already signed" spellings are here too (今日已签到,
// 已经签到过了, 今日已领取, 已签到，请勿重复签到): read as none of them, a
// 200 saying so became "just claimed" and the credit was read off a day that
// had already been settled.
export const ALREADY_CLAIMED = /(?<!\d)24\s*小时(?:内)?[^。；;]{0,8}?(?:(?:仅|只能|才)\s*可?\s*(?:领取|签到)|(?:领取|签到)\s*(?:一次|1\s*次))|(?:仅|只能)可?(?:领取)?一次|once\s+(?:every|in|per)\s+(?:a\s+)?(?:24\s*(?:hours?|h)|day)|already\s+(?:claimed\b|signed\b[^.!?]{0,24}?\btoday\b|checked\s+in\b|checked\b[^.!?]{0,24}?\btoday\b)|(?:今[日天]|本次)\s*已经?\s*(?:签到|领取|签过|领过)(?:过|了|完成)?|已经?\s*(?:签到|领取|签过|领过)过|(?:今[日天]|每天)[^。；;]{0,6}(?:限|仅限|只能)[^。；;]{0,4}(?:一次|1\s*次)|(?:请?勿|无需|不用|不必)?重复(?:签到|领取)/i

// MAX_SCRUB_CHARS is how much of a vendor's string the cleaners look at.
// cleanText and scrubLine both run global regexes over vendor text, and V8's
// engine recurses while matching them: measured 2026-11-03, an 8 MB run of
// "eyJ"+"a " (or of one long word, or of a bare HS256 signature) throws
// RangeError "Maximum call stack size exceeded" out of the usage hook, and an
// 8 MB name of newlines or control characters took 2.5 s to fold. The same
// text clipped to 8k runs in about a millisecond. A card shows 120 characters
// and a 400-character message; 8k leaves room for a vendor that pads its
// prose, and a credential a server quotes back sits where its message is.
export const MAX_SCRUB_CHARS = 8192

// MAX_MODELS is how many models one vendor catalog may bring back. The host
// passes a hook's answer to Go as a single JSON line and kills the whole
// plugin host — every plugin in it — when that line passes 32 MiB
// (host.go's maxWireLine); an unbounded list is a way for a vendor to take
// the host down with data rather than with a bug. Codar lists 15 (2026-11-07).
//
// The same number bounds the entries catalogOf looks at, not just the ones it
// keeps: with the cap on kept records only, a list whose every record is
// malformed — a shape the vendor could send by accident — was walked to the
// end, entry by entry, for nothing. Every real catalog is far below this.
// MAX_TOKENS is the largest token count a record may state (a context window
// or a reply ceiling). Well above any real window (the vendor's largest is
// 2M); a bigger number is treated as the vendor saying something we cannot
// use, not as a size to plan for.
export const MAX_TOKENS = 10_000_000

export const MAX_MODELS = 2000

// MAX_ACTIVITY_WINDOWS is how many free-model activities go on the card.
// The same wire limit applies to the usage answer, and the card has room for
// a handful of rows; Codar has run at most two activities at a time.
export const MAX_ACTIVITY_WINDOWS = 20

export const CLAUDE = "@ai-sdk/anthropic"
export const OPENAI = "@ai-sdk/openai-compatible"

// tokenOf is the key this sign-in carries, or "" when there is none or it is
// not one we can send. A key with anything but visible ASCII in it would put
// the whole value into a fetch error message ("…is an invalid header value"),
// which magpie logs and shows; it is refused here, before it can be echoed.
// An oauth sign-in (the one a login or a renewal that could renew one saves)
// keeps the same JWT under access; one saved before that field existed has it
// under refresh, so both are read.
export const tokenOf = (auth) => {
  // only a string is a key: `String(123)` would hand the host "123" to send,
  // and `String(["…"])` a key nobody typed. A damaged plugin-auth.json then
  // reads as "no key", which the sign-in messages can explain.
  const raw = auth?.type === "api" ? auth.key : auth?.type === "oauth" ? auth.access ?? auth.refresh : undefined
  const token = typeof raw === "string" ? raw.trim() : ""
  return token && /^[\x21-\x7e]+$/.test(token) ? token : ""
}
// unusableKey is a key that is there but cannot be sent: a missing one is a
// different answer, and telling the user to "sign in again" for an empty one
// sends them to the wrong place.
export const unusableKey = (auth) => {
  const raw = auth?.type === "api" ? auth.key : auth?.access ?? auth?.refresh
  return typeof raw === "string" && Boolean(raw.trim()) && !tokenOf(auth)
}

// keptToken is a token the plugin will hand the host as a working sign-in:
// visible ASCII with no whitespace (a header cannot carry it otherwise) and
// not one the token itself says has run out. The vendor is still the one that
// checks it; this refuses the shapes that would be saved and then fail on
// every request, which the host would retry rather than ask for a sign-in.
export const keptToken = (said) => {
  const token = typeof said === "string" ? said.trim() : ""
  return token && /^[\x21-\x7e]+$/.test(token) && !expired(token) ? token : ""
}

// payloadOf is a JWT's claims, or null when the string is not one. No
// verification: the vendor is the one that checks the signature; we read it
// for the account name and the expiry the token itself carries.
export function payloadOf(token) {
  const parts = String(token ?? "").split(".")
  if (parts.length !== 3) return null
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/")
    const json = Buffer.from(b64, "base64").toString("utf8")
    const claims = JSON.parse(json)
    return claims && typeof claims === "object" ? claims : null
  } catch {
    return null
  }
}

// USERNAME is what an account name looks like: anything a person would pick
// — letters of any script, digits, dot, dash, underscore — up to 64
// characters, and no whitespace. A claims' username is vendor-signed data
// that the vendor may quote back on the card as the account's name; one that
// is a JWT (or any other dot-separated base64 run) is not a name and is not
// shown nor sent as one.
// What a name looks like once cleaned (the card shows cleanText's answer),
// with a space in it when a control character was there.
const USERNAME = /^[\p{L}\p{N}._ -]{1,64}$/u
export const usernameOf = (token) => {
  const u = payloadOf(token)?.username
  if (typeof u !== "string" || !USERNAME.test(cleanText(u))) return ""
  // a name has no JWT in it: the eyJ header, or three dot-separated base64url
  // segments where the last is long enough to be a signature. Long letters
  // alone ("AlexanderHamilton") are a name.
  const parts = u.split(".")
  if (/eyJ[A-Za-z0-9_-]{8,}/.test(u)) return ""
  if (parts.length >= 3 && parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part)) && parts[parts.length - 1].length >= 16 && parts[0].length >= 8) return ""
  return u
}

// expSeconds is a token's exp as the vendor's client reads it (app.asar's
// Zh): a number, or a string that says one; NaN when it states none.
export const expSeconds = (token) => numOf(payloadOf(token)?.exp)

// expiresAt is when the token says it runs out (ms), or 0 when it says
// nothing. A token past it is not sent: every endpoint would answer 401 and
// the card would say "check-in failed" instead of "sign in again". The exp
// is read the way the vendor's client reads it (app.asar's Po): a number,
// or a string that says one — a string exp read as "no expiry" would send a
// token the vendor already counts as expired, and the card would say the
// check-in failed instead of asking to sign in again.
// A stated exp of 0 is the epoch, not "says nothing": it is a time that has
// passed, so it is handed back as a time (and read as expired). That is why
// the reading is "> 0" and not ">= 0" — 0 is both a real instant and the
// value expiresAt uses for "not stated", and only the sign tells them apart.
export function expiresAt(token) {
  const n = expSeconds(token)
  return Number.isFinite(n) && n > 0 ? n * 1000 : 0
}

// expired says whether the token has run out, as that same client decides
// (app.asar's Zh: `i*1e3 - t <= 0 ? "expired"`): a stated exp in the past is
// expired — the instant itself included, hence `>=` — while a token that
// states no exp is not declared expired here (that client calls it "unknown",
// and the vendor is the one to answer). A stated exp of 0 is the epoch, so it
// is expired; that is the one case the "0 means not stated" reading of
// expiresAt could not tell apart, which is why this function reads the claims
// itself rather than asking expiresAt.
export const expired = (token) => {
  const n = expSeconds(token)
  return Number.isFinite(n) && Date.now() >= n * 1000
}

class ApiError extends Error {
  constructor(message, status, { code = "", retryAfter = 0, body = null } = {}) {
    super(message)
    this.status = status
    // the parsed answer the refusal carried, when it was JSON: a check-in
    // may still be "already claimed" spoken in a 400 body, and the status
    // alone cannot tell that.
    this.body = body
    // the vendor's business code, where its refusal named one: `code` at the
    // top level or `detail.code` (see errorCodeOf). The 403 the gateway
    // answers with `account_restricted` is the one the hooks read it for.
    this.code = code
    // how long the refusal lasts, in seconds, when the vendor said so in a
    // Retry-After header; 0 when it said nothing.
    this.retryAfter = retryAfter
  }
}

// saidNo reads a vendor's boolean-ish refusal flag: the vendor's activity
// endpoint answers `success: false`, and a JSON API may spell the same thing
// as the string "false", 0, or "no" (app.asar reads it with its own truthy
// test). Only those count: an absent flag is not a refusal, and any other
// value (a number, an object, "ok") is not one either.
export const saidNo = (v) => v === false || v === 0 || (typeof v === "string" && /^\s*(?:false|0|no)\s*$/i.test(v))
export const signedOut = (e) => e?.status === 401 || e?.status === 403

// restricted is a refusal about the account rather than its sign-in: the
// vendor's `account_restricted` answers 403 while the token is valid, so
// telling the user to sign in again sends them to a fix that cannot work.
// Read from the business code the answer carried, or from a message that
// names that code; a bare "access is restricted" is not enough — any endpoint
// may say it about something else, and the card would then send the user past
// the sign-in step to support.
export const restricted = (e) => e?.code === "account_restricted" || e?.error?.code === "account_restricted" || /account[_ ]restricted|api access is restricted/i.test(e?.message ?? "")

// client_not_supported is the vendor's client-identity refusal: the login
// credential is issued for Codar's own client, and the vendor's sentence
// tells other clients to use an API key (measured 2026-11-20 on the gateway:
// 403 {"detail":{"code":"client_not_supported","message":"This login
// credential is restricted to Codar. Use an API key for other clients."}}).
// Signing in again does not change it and Codar support cannot lift it — the
// plugin does not impersonate the client — so every hook that reads it says
// the same sentence and stops there, instead of reading it as an expiry.
export const CLIENT_GATED = "科搭限制登录凭据仅限其客户端使用（client_not_supported）；请使用厂商支持的 API key，或联系科搭支持"
// The answer may name the refusal in a field (`code`/`detail.code`, as the
// gateway does today) or only in the vendor's own sentence, as a rewritten
// body does: both are the same refusal, and reading only the field let a 200
// beside the sentence settle a check-in that never landed.
export const clientGated = (word, said) =>
  (typeof word === "string" && word.toLowerCase() === "client_not_supported") ||
  /client_not_supported|login credential is restricted to Codar|Use an API key for other clients/i.test(typeof said === "string" ? said : "")

// gateWithin is the client gate anywhere in the wrapper chain. The gateway is
// free to keep its success word on the envelope and put the refusal under
// `data` — a shape read as a claim settled a check-in that never landed and
// drew a balance card for an account chat refuses. Every node the walk reaches
// is judged the way the flat answer is: its own word code, or its sentence.
export const gateWithin = (r) => {
  let node = r
  for (let i = 0; i < 9 && node && typeof node === "object" && !Array.isArray(node); i++) {
    if (clientGated(errorCodeOf(node), saidBy(node))) return true
    node = node.data
  }
  return false
}

// restrictedWithin is the account restriction's word anywhere in the wrapper
// chain. When an answer states both this and the client gate, the restriction
// speaks: its fix is the vendor's support, and it is the order both balance
// readers keep.
export const restrictedWithin = (r) => {
  let node = r
  for (let i = 0; i < 9 && node && typeof node === "object" && !Array.isArray(node); i++) {
    if (errorCodeOf(node) === "account_restricted") return true
    node = node.data
  }
  return false
}

// retryAfterOf is a Retry-After header as seconds: the header says either a
// number of seconds or an HTTP date, and only a value this calendar can turn
// into a wait is used. A value that is neither is not read at all: parsing
// a non-date with Date.parse is how "3600.5" became the year 3600 and a
// wait of 31 years. A wait past a week is not one the check-in can name
// (MAX_CHECKIN_WAIT_SECS) — the day is a rolling 24 hours — so it is treated
// as "we cannot use this", the same answer checkinWaitSecs gives, rather
// than clamped to a week and reported as if the vendor had said it. 0 when
// the header said nothing usable.
export const retryAfterOf = (v) => {
  const said = typeof v === "string" ? v.trim() : ""
  if (!said) return 0
  let secs = 0
  if (/^[0-9]+$/.test(said)) secs = Number(said)
  else if (/[A-Za-z]/.test(said)) {
    // an HTTP date always carries letters (a month name); a bare number or a
    // fractional one does not, and is not a date.
    const at = Date.parse(said)
    if (Number.isFinite(at)) secs = Math.ceil((at - Date.now()) / 1000)
  }
  if (!Number.isFinite(secs) || secs <= 0 || secs > MAX_CHECKIN_WAIT_SECS) return 0
  return Math.floor(secs)
}

// whyOf is the message to show for an error, without the token it might name.
export const whyOf = (e) => (e instanceof Error ? e.message : String(e ?? ""))

// controlChars would break a card's line, reorder what follows it, or ride
// along invisibly: a vendor string is shown as one line, never as a control
// sequence. C0 and C1 controls, the zero-width marks, the bidi overrides and
// isolates (a right-to-left override reverses the text after it), the line
// and paragraph separators, a byte-order mark.
export const controlChars =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb]/g

// cut is a string clipped to at most n code points: never longer than the card
// reads, and never ending in half a character. The length check is the UTF-16
// one first — when that already fits, no cut is needed and the array work is
// skipped — then the clip walks code points, so a string that ends on an emoji
// is not broken into a lone surrogate (JSON.stringify writes one as \ud83d and
// the host's decoder reads it as U+FFFD). A vendor name and a vendor message
// both come through here, so they break at the same place.
//
// The walk is over s.slice(0, 2 * n), not the whole string: n code points take
// at most 2n UTF-16 units, so nothing that belongs in the answer is past 2n,
// and a vendor's 8 MB sentence costs a 2n-unit array rather than an 8M-entry
// one (measured before this: 156 ms and 76 MB of heap for 8 MB). A surrogate
// pair straddling the 2n boundary becomes a lone surrogate — always after the
// n code points taken, so it never reaches the answer.
export const cut = (s, n) => (s.length <= n ? s : Array.from(s.slice(0, 2 * n)).slice(0, n).join(""))

// hasSurrogate is a string that holds a lone surrogate: a vendor field the
// JSON parser handed over as one (an escape half of a pair). Written back out
// it becomes that escape in the file, and a reader of the file gets half a
// character; such a value is not written at all.
const hasSurrogate = (s) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s)

// cleanText is a vendor string as a card can show it: control characters
// out, one line (runs of spaces folded), and never longer than a card reads.
// Only the first MAX_SCRUB_CHARS characters are cleaned: a card shows 120,
// and folding the runs of a multi-megabyte name cost seconds in a host every
// plugin shares (measured 2026-11-03: 2.5 s for an 8 MB name of newlines and
// control characters). The cut below drops the rest anyway, so the tail is
// never read — a 120-character answer needs at most 120 characters of input
// plus whatever folding removes, and 8k leaves room for a vendor that pads.
export const cleanText = (s) => cut(String(s).slice(0, MAX_SCRUB_CHARS).replace(controlChars, " ").replace(/\s{2,}/g, " ").trim(), 120)

// jwtShape is a credential as a server might quote it back. Every Codar token
// is a JWT, and every JWT segment is base64url. A server can wrap the token
// at any column or insert whitespace anywhere in the message; the shape must
// match both intact tokens and the same token split with spaces/newlines.
//
// The first alternative is the token itself: an eyJ-started segment, then
// dot-separated segments, whitespace allowed inside either (so the whole
// token cuts regardless of where lines were inserted). The second is the same
// token with its eyJ head eaten — a message that swallowed the first letter
// ("…ror: bGciOiJIUzI1NiJ9.eyJzdWIi…") still leaves a usable credential, and
// it is dot-separated base64url just the same; the 16-character floor on both
// segments keeps host names and file names out of it. The third is a
// signature segment quoted on its own: 40+ base64url characters (a HS256
// signature is 43) carrying an upper case, a lower case and a digit, which
// words and all-lowercase hex hashes do not. A real JWT requires two dots; we
// allow 1–2 extra segments for safety, and prose that happens to fit these
// shapes will be cut too — acceptable in an error message, where failing
// closed (removing more rather than less) matters.
export const jwtShape =
  /eyJ[\w-]*(?:\s+[\w-]+)*(?:\s*\.\s*[\w-]+(?:\s+[\w-]+)*){0,2}|(?<![\w-])[\w-]{16,}(?:\s*\.\s*[\w-]{16,}){1,2}(?![\w-])|(?<![\w-])(?=[\w-]{40})(?=[\w-]{0,39}\d)(?=[\w-]{0,39}[A-Z])(?=[\w-]{0,39}[a-z])[\w-]{40,}(?![\w-])/g

// KNOWN_JWT is the token every JWT starts with: its header for HS256, which
// is what a Codar token is. The keyless shape pass decodes with it to find
// an encoded copy of a token it was not given.
const KNOWN_JWT = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${"A".repeat(64)}.${"A".repeat(43)}`

// configPath is where the Codar app keeps its own config. The app takes
// CODAR_HOME over the home directory when it is set (its sidecar's
// `codar config path` says so), so the file is looked for in the same
// place the app would have written it — value verbatim, not trimmed:
// `CODAR_HOME="  /tmp/x  "` answers `  /tmp/x  /config.json` from the
// sidecar (measured against the installed app), so a plugin that trimmed
// would read a file the app never wrote. An empty value is the app's
// "not set" and falls back to ~/.codar.
export const configPath = () => {
  const home = String(process.env.CODAR_HOME ?? "")
  return join(home || join(homedir(), ".codar"), "config.json")
}

// shownPath is a local path as a sign-in message may say it: under the home
// directory the home part is written ~, so a dialog read off a screenshot or
// pasted into an issue carries no account name. Any other path is the user's
// own choice (CODAR_HOME, a test's temp dir) and is said as it is.
export const shownPath = (file) => {
  const home = homedir()
  if (!home) return file
  const rel = relative(home, file)
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? `~${sep}${rel}` : file
}

// appToken reads the token the Codar desktop app keeps, for the "read from
// this machine" sign-in: provider.speedai.token in ~/.codar/config.json
// (%USERPROFILE%\.codar\config.json on Windows, as the app's own docs say;
// on macOS/Linux the home directory is the same place). Read only — the file
// is the app's, and the plugin never writes it. A failure says why in words
// the sign-in dialog can show, since this runs where no card exists yet.
// MAX_CONFIG_BYTES caps how much of the app's config is read: the file is
// the app's own, but a damaged one (a FIFO, a directory, a runaway write)
// must not hang or exhaust the reader. 1 MiB is ~20x a real config.
export const MAX_CONFIG_BYTES = 1024 * 1024
// readConfigText reads the app's config with that cap. A path that is not a
// regular file is refused before it is opened — a FIFO would block
// readFileSync for ever — and a file past the cap is refused by its size,
// before its bytes are pulled into the host process. The error carries a
// code the callers turn into their own sentence (ENOENT, EFBIG, EFTYPE).
export const readConfigText = (file) => {
  const st = statSync(file)
  if (!st.isFile()) throw Object.assign(new Error("not a regular file"), { code: "EFTYPE" })
  if (st.size > MAX_CONFIG_BYTES) throw Object.assign(new Error("file is larger than the cap"), { code: "EFBIG" })
  return readFileSync(file, "utf8")
}

export function appToken(file = configPath()) {
  // The error text says ~/.codar/config.json rather than the full local path:
  // the sign-in dialog shows up in screenshots, screen recordings and issues,
  // and the home-directory part carries the user name. A path the user built
  // himself can carry a credential-shaped segment too (CODAR_HOME is read
  // verbatim); the shape rules blank it like they would in any other line.
  const shown = scrubShapes(shownPath(file), "")
  let text
  try {
    text = readConfigText(file)
  } catch (e) {
    // "Does not exist" and "cannot be read" are different things: telling
    // someone to "sign in to Codar once" does not fix a permissions problem,
    // and sending them there is a wasted trip.
    if (e?.code === "ENOENT") return { error: `没找到 ${shown}，先在这台机器上登录一次科搭，或在「科搭令牌（留空读本机）」里粘贴一个令牌` }
    if (e?.code === "EFBIG") return { error: `读不了 ${shown}（文件太大，超过 1 MB），不是科搭的配置；在「科搭令牌（留空读本机）」里粘贴一个令牌` }
    if (e?.code === "EFTYPE") return { error: `读不了 ${shown}（不是一个普通文件），不是科搭的配置；在「科搭令牌（留空读本机）」里粘贴一个令牌` }
    return { error: `读不了 ${shown}（${e?.code ?? whyOf(e)}），检查文件权限后重试，或在「科搭令牌（留空读本机）」里粘贴一个令牌` }
  }
  let token = ""
  try {
    // A config written on Windows may carry a BOM, and JSON.parse refuses
    // the whole file over it — the same leading character request() strips
    // from a vendor answer.
    token = String(JSON.parse(text.replace(/^\uFEFF/, ""))?.provider?.speedai?.token ?? "").trim()
  } catch {
    return { error: `${shown} 读不出 JSON，可能损坏了；在「科搭令牌（留空读本机）」里粘贴一个令牌` }
  }
  if (!token) return { error: `${shown} 里没有 provider.speedai.token；先在这台机器上登录一次科搭，或改用粘贴` }
  if (!tokenOf({ type: "api", key: token })) return { error: `${shown} 里的令牌无法识别；在「科搭令牌（留空读本机）」里粘贴一个令牌` }
  // every call this plugin makes sends the account name from the token's
  // own claims; one without it would be saved and then fail on the card
  if (!usernameOf(token)) return { error: `${shown} 里的令牌没有账号名；打开一次科搭重新登录，或在「科搭令牌（留空读本机）」里粘贴一个令牌` }
  if (expired(token)) return { error: `${shown} 里的令牌已过期；打开一次科搭让它续期，再试一次` }
  return { token }
}

// saidBy is what an answer says in words, read the way the vendor's own client
// reads it (app.asar's vo): the first non-blank string among the top-level
// message/msg/error/detail and the same four under `data`. Read as `message`
// alone, a refusal the vendor spelled in `msg`, and an "already claimed" note
// under `data`, both came out as no text at all — the check-in then reported a
// failure where the day was simply already claimed, and the card dropped what
// the vendor said about every other refusal.
export const saidBy = (body) => {
  if (!body || typeof body !== "object") return ""
  // `detail` is an object in the vendor's own refusals — the gateway answers
  // `{"detail":{"code":"account_restricted","message":"…"}}` — so an entry is
  // read for the words inside it as well as for being words itself.
  const words = (v) => {
    if (typeof v === "string" && v.trim()) return v
    if (v && typeof v === "object") {
      for (const inner of [v.message, v.msg, v.error, v.detail]) if (typeof inner === "string" && inner.trim()) return inner
    }
    return ""
  }
  const data = body.data && typeof body.data === "object" ? body.data : null
  for (const said of [body.message, body.msg, body.error, body.detail, data?.message, data?.msg, data?.error, data?.detail]) {
    const got = words(said)
    if (got) return got
  }
  return ""
}

// errorCodeOf is the business code a vendor's refusal carries, where it
// carries one: top-level `code` when it is a word, else `detail.code`. The
// plugin's own messages are not built from a bare status, so a refusal that
// says `account_restricted` can say so instead of "sign in again".
export const errorCodeOf = (body) => {
  // A code that is a word, wherever the vendor put it: top-level `code`,
  // `error.code` (the vendor wraps refusals there too), `detail.code`, or the
  // same under `data` — including `data.error.code`, the wrapped shape of the
  // `error.code` refusal. A numeric code is not a business code word —
  // returning "401" here put a status where a word belongs, and callers that
  // want the number read codeOf — so only a code carrying a non-digit is kept.
  // A numeric string with surrounding space or a decimal/exponent spelling
  // (" 200 ", "200.0", "2e2") is a number codeOf reads as 200: testing the raw
  // text treated the spaces and the dot as "a word", refused a healthy catalog,
  // dropped the check-in status row, and masked a real account_restricted
  // behind a " 200 " envelope. Number.isFinite is the same reader codeOf uses.
  for (const c of [body?.code, body?.error?.code, body?.detail?.code, body?.data?.error?.code, body?.data?.detail?.code, body?.data?.code]) {
    const text = typeof c === "string" ? c.trim() : ""
    if (text && !Number.isFinite(Number(text))) return text
  }
  return ""
}

// MAX_ANSWER_BYTES is how much of a vendor's answer request() reads before it
// gives up. Every endpoint this plugin calls answers in kilobytes (the whole
// catalog is tens of them); a body past this is not an answer we could use,
// and holding it costs the host — one process shared by every plugin — memory
// in the size of whatever the vendor sends. 8 MiB is ~200× the catalog.
export const MAX_ANSWER_BYTES = 8 * 1024 * 1024

// readAnswer is a Response's body as text, refusing one larger than
// MAX_ANSWER_BYTES. The read goes through the body stream so the limit is
// applied while reading rather than after: res.text() holds the whole answer
// first, whatever its size. A Response that offers no stream (a stub in a
// test) falls back to text().
export const readAnswer = async (res) => {
  const stream = res.body
  if (!stream || typeof stream.getReader !== "function") {
    // No stream to count through. Check what the answer says about its own
    // size first: a Content-Length past the cap is refused without reading
    // it. What is left — a Response with neither a stream nor a length, a
    // stub in a test — is read whole and then measured, so the cap holds on
    // every path rather than only the one with a readable body.
    //
    // A compressed body is a different number on the wire and after the
    // fetch's own decompression, but every transport hands back the decoded
    // bytes (Bun's and Node's fetch decode, and the Go proxy's client is
    // given Accept-Encoding by net/http and decodes what it asked for): the
    // stream below yields decompressed chunks, so the cap counts what a
    // decompression bomb would actually cost. An answer is not refused for
    // stating a Content-Encoding — the vendor started gzipping the QR
    // endpoint and every sign-in failed on a header that no longer described
    // the bytes.
    const stated = Number(res.headers?.get?.("content-length"))
    if (Number.isFinite(stated) && stated > MAX_ANSWER_BYTES) throw new ApiError(`厂商应答超过 ${MAX_ANSWER_BYTES / 1024 / 1024} MB，已放弃`, 0, { code: "answer_too_large" })
    const text = await res.text()
    if (Buffer.byteLength(text, "utf8") > MAX_ANSWER_BYTES) throw new ApiError(`厂商应答超过 ${MAX_ANSWER_BYTES / 1024 / 1024} MB，已放弃`, 0, { code: "answer_too_large" })
    return { text }
  }
  const reader = stream.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > MAX_ANSWER_BYTES) {
      // telling the server to stop; an implementation that cannot is not a
      // reason to fail differently
      try {
        await reader.cancel()
      } catch {}
      throw new ApiError(`厂商应答超过 ${MAX_ANSWER_BYTES / 1024 / 1024} MB，已放弃`, 0, { code: "answer_too_large" })
    }
    chunks.push(value)
  }
  // decoded once, at the end: a chunk boundary can fall inside a multi-byte
  // character, and per-chunk decoding would turn it into U+FFFD
  const all = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.byteLength
  }
  return { text: new TextDecoder().decode(all) }
}

// headerWaits holds a 2xx answer's Retry-After header, keyed by the answer
// object request() returns (see request): the header lives on the Response,
// which is gone once the body is handed back, and a 200 whose *business* code
// refuses (a 429/503 stated in the body) is exactly the case where the
// gateway's Retry-After is the only wait on the wire. WeakMap, so the entry
// dies with the answer.
const headerWaits = new WeakMap()
export const headerWaitOf = (r) => (r && typeof r === "object" ? headerWaits.get(r) ?? 0 : 0)

export async function request(url, { method = "GET", body, token, timeoutMs = TIMEOUT_MS, fetchImpl = fetch, ua = UA_DESKTOP, businessCodes = false, signal: outer } = {}) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  // A caller's own signal (the sign-in page's, closed with its listener) ends
  // the request as its timeout would: the call is abandoned, not awaited to
  // the vendor's pace, and the AbortError is read below as the abandonment it
  // is.
  const onOuter = () => ctl.abort()
  if (outer?.aborted) ctl.abort()
  else outer?.addEventListener?.("abort", onOuter, { once: true })
  try {
    // The sidecar's own transport answers the vendor's catalog, check-in and
    // points (native.mjs): those leave through the desktop's Go client, with
    // its TLS fingerprint and headers rather than Bun's. A transport that
    // cannot answer — no binary for this platform, the proxy did not start —
    // answers null, and the request is this same fetch it always was. A test
    // names its own transport through testables.nativeFetch (see withFetch).
    // Endpoints that take no credential (the QR sign-in asks for its code and
    // polls it anonymously, as the vendor's web client does) must not be sent
    // a made-up one: `Bearer undefined` is not a token, and it tells the
    // vendor this request came from something other than its own client.
    const said = typeof token === "string" ? token.trim() : ""
    const init = {
      method,
      headers: {
        ...(said ? { Authorization: `Bearer ${said}` } : {}),
        "Content-Type": "application/json",
        "User-Agent": ua,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
      // the same cap readAnswer applies, so the native transport refuses an
      // answer that large while it arrives instead of after holding it whole
      maxBytes: MAX_ANSWER_BYTES,
    }
    const native = await nativeFetchOf()
    let res = null
    if (native) {
      try {
        res = await native(url, init)
      } catch (e) {
        // Only a transport that could not run falls back here; an answer
        // from the vendor, even a refusal, is not asked for twice.
        if (e?.name !== "NativeUnavailable") throw e
      }
    }
    // A copy, not the same object: a body already handed to the native
    // transport has been read, and a fetch handed a used stream refuses it.
    // The fetch is guarded: the proxy refuses to follow a redirect off its own
    // origin, and so does this one (guarded.mjs), which is where the answer
    // says so when the proxy is not there.
    res ??= await guardedFetch(url, { ...init }, { transport: fetchImpl })
    // A leading BOM would make JSON.parse refuse the whole body. Node's and
    // Bun's network fetch drop it from text(), but the fetch the host hands
    // in need not, so it is dropped here too: one line, one guarantee less
    // that depends on which fetch answered.
    const text = (await readAnswer(res)).text.replace(/^\uFEFF/, "")
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    if (!res.ok) {
      // Retry-After is the vendor saying how long the refusal lasts: a 429
      // carries one today, and passing it on (instead of a bare "HTTP 429")
      // is what lets the card say "wait a moment" rather than "something is
      // wrong". Seconds or an HTTP date, as the header allows.
      const ra = retryAfterOf(res.headers?.get?.("retry-after"))
      // The body's own retry_after is the business layer's number and wins
      // over the gateway's header; the header is stated only when the body
      // says none (see the check-in's catch, which would otherwise see the
      // header's wait already in the message and keep it).
      const stated = checkinWaitSecs(data?.data?.retry_after) || checkinWaitSecs(data?.retry_after)
      const said = saidBy(data) || `HTTP ${res.status}`
      throw new ApiError((stated || ra) ? `${said}（约 ${humanSecs(stated || ra)}后可重试）` : said, res.status, { code: errorCodeOf(data), retryAfter: ra, body: data })
    }
    if (data === null) throw new ApiError("接口返回的不是 JSON")
    // a 2xx answer's Retry-After is kept beside the body (see headerWaits)
    const wait = retryAfterOf(res.headers?.get?.("retry-after"))
    if (wait && typeof data === "object") headerWaits.set(data, wait)
    // The vendor's business code on a 200: a refusal can arrive as
    // {"code":401,"message":"Invalid token"} with HTTP 200 (measured
    // 2026-10-27 on the points endpoints, and again on the sign-in's refresh,
    // which answers {"code":401,"message":"Token has expired"} for a token
    // past its exp). Callers that read balances do their own gate; a sign-in
    // and a renewal must not read that answer as a new token, so they ask for
    // it with businessCodes and get the ApiError a 4xx would have been.
    const status = codeOf(data?.code)
    if (businessCodes && typeof data === "object" && refusedCode(status)) {
      throw new ApiError(saidBy(data) || `code ${status}`, 200, { code: String(status), body: data })
    }
    return data
  } catch (e) {
    if (e?.name === "AbortError") throw new ApiError("请求超时", 0)
    throw e
  } finally {
    clearTimeout(timer)
    outer?.removeEventListener?.("abort", onOuter)
  }
}

// LOGIN_PATH and REFRESH_PATH are the account endpoints behind a sign-in.
// They are the desktop client's own (electron main / the web app's bundle,
// both on api.kuaipaper.com): POST /v1/login {username, password} answers
// {token, username}; POST /v1/token/refresh with the token as a bearer
// answers a fresh one. The client refreshes on its own schedule; here the host
// does (see auth.refresh below), because a token that has run out cannot be
// refreshed — the vendor answers it with code 401, "Token has expired"
// (measured 2026-11-11) — so a renewal is only ever made before expires.
export const LOGIN_PATH = "/v1/login"
export const REFRESH_PATH = "/v1/token/refresh"
// VERIFY_IP_PATH is the vendor's second half of a sign-in its IP risk check
// stopped: POST /v1/user/verify_ip {username, phone, code} with the temp token
// the refused login answered as a bearer, answering {token, username}
// (packages/web index-*.js: Og, `ft("/v1/user/verify_ip",{username,phone,code},
// tempToken ? {Authorization: Bearer tempToken} : undefined)`). Its SMS code is
// asked for with type "ip_verify" and the account's own name (the web app's
// Ji call beside it), which is what separates it from a plain login code.
export const VERIFY_IP_PATH = "/v1/user/verify_ip"
export const CODE_PATH = "/v1/verification-code"

// login exchanges an account's name and password for its token. The password
// is sent once and never kept: what the caller returns to the host is the
// token alone. A refusal the vendor states on a 200 (code !== 200) or a 4xx
// throws the ApiError request() made; the two answers worth telling apart are
// read by the caller (see signInFailure).
export async function login(username, password, opts = {}) {
  const r = await request(`${ACCOUNT}${LOGIN_PATH}`, { method: "POST", body: { username, password }, ...opts, businessCodes: true })
  // A refusal can sit inside the wrapper, at any depth: `{"code":200,
  // "data":{"code":201,"status":"ip_verify_required","token":…}}` passes the
  // top-level business gate, and its token is a temp one good for
  // /v1/user/verify_ip alone — saved as a finished sign-in it would fail
  // every request. A refusal whose data still holds a token (an inner 401
  // beside a stale one) was read the same way, because unwrapped() walks past
  // it to the fields. Every node of the chain is read.
  const refusedNode = refusalWithin(r)
  if (refusedNode) {
    const inner = codeOf(refusedNode.code)
    const wordCode = errorCodeOf(refusedNode)
    const stated = Number.isFinite(inner) ? String(inner) : String(wordCode)
    throw new ApiError(saidBy(refusedNode) || `code ${stated}`, 200, { code: stated, body: refusedNode })
  }
  const body = unwrapped(r)
  const said = typeof body?.token === "string" ? body.token.trim() : ""
  if (!said) throw new ApiError("登录响应里没有令牌", 200, { code: "no_token", body: r })
  const token = keptToken(said)
  if (!token) throw new ApiError("登录返回的令牌无法使用（含不可见字符或已过期）", 200, { code: "unusable_token", body: r })
  const name = typeof body?.username === "string" && body.username.trim() ? body.username.trim() : username
  return { token, username: name }
}

// verifyIp completes a sign-in the vendor's IP check stopped. The temp token
// from the refused login is the only credential this call has, and it is
// spent here: what comes back is the account's own token. The vendor reads the
// same three fields a password sign-in carries, so nothing new is collected
// beyond the SMS code the person received.
export async function verifyIp({ username, phone, code, tempToken }, opts = {}) {
  const r = await request(`${ACCOUNT}${VERIFY_IP_PATH}`, {
    method: "POST",
    body: { username, phone, code },
    token: tempToken,
    ...opts,
    businessCodes: true,
  })
  const refusedNode = refusalWithin(r)
  if (refusedNode) {
    const inner = codeOf(refusedNode.code)
    const wordCode = errorCodeOf(refusedNode)
    const stated = Number.isFinite(inner) ? String(inner) : String(wordCode)
    throw new ApiError(saidBy(refusedNode) || `code ${stated}`, 200, { code: stated, body: refusedNode })
  }
  const body = unwrapped(r)
  const said = typeof body?.token === "string" ? body.token.trim() : ""
  if (!said) throw new ApiError("安全验证响应里没有令牌", 200, { code: "no_token", body: r })
  const token = keptToken(said)
  if (!token) throw new ApiError("安全验证返回的令牌无法使用（含不可见字符或已过期）", 200, { code: "unusable_token", body: r })
  const name = typeof body?.username === "string" && body.username.trim() ? body.username.trim() : username
  return { token, username: name }
}

// WECHAT_QR_PATH and WECHAT_STATUS_PATH are the vendor's QR sign-in. Neither
// carries a credential: the code is the vendor's own, and the status answer is
// what hands over the token once the phone confirms (packages/web index-*.js:
// Rg → POST /v1/wechat/login/qrcode {scene, qr_url}; w5 → POST
// /v1/wechat/login/status {scene}).
export const WECHAT_QR_PATH = "/v1/wechat/login/qrcode"
export const WECHAT_STATUS_PATH = "/v1/wechat/login/status"

// wechatQrOf reads the code's answer ({scene, qr_url}). qrUrl is the page's
// image src, so it is held to what an image can be: an https URL on the
// vendor's own hosts (see officialHost), no userinfo, no port. The page runs in
// a browser beside the person signing in, and an unchecked src is a request
// that browser makes — a hostile answer could point it at a loopback service or
// a scheme it never means to visit. A code whose image is not one is no code.
export const wechatQrOf = (body) => {
  const data = unwrapped(body)
  const scene = typeof data?.scene === "string" ? data.scene.trim() : ""
  const said = typeof data?.qr_url === "string" ? data.qr_url.trim() : typeof data?.qrUrl === "string" ? data.qrUrl.trim() : ""
  return scene && qrImageURL(said) ? { scene, qrUrl: said } : null
}

// qrImageURL is said when it is an image this page may display: https, no
// userinfo, no port, and one of the vendor's hosts (the desktop's own
// OFFICIAL_HOSTS, less the gateway, which serves no images — the page is
// served by codar-web and the web client loads its assets from there).
const qrImageHosts = new Set(["codar-web.speedai.com", "api.kuaipaper.com", "test.api.kuaipaper.com"])
export const qrImageURL = (said) => {
  let u
  try {
    u = new URL(String(said ?? ""))
  } catch {
    return false
  }
  return u.protocol === "https:" && !u.username && !u.password && !u.port && qrImageHosts.has(u.hostname.toLowerCase())
}

// wechatStatusOf reads one status answer as the page's own five states. The
// vendor speaks in words the web app upper-cases (uu) and compares against
// three success words, "expired", "scanned", the phone-required ones and the
// IP-check ones; a business code 404 is its other way of saying the code
// expired. Anything else is "waiting", which is what the app shows too.
export const WECHAT_DONE = new Set(["SUCCESS", "AUTHORIZED", "COMPLETED"])
// the app's own lists (index-*.js: VS/FS both want a phone, US/$S both want an
// IP check), spelled the way its upper-cased comparison reads them
export const WECHAT_BIND = new Set(["REQUIRED_BIND_PHONE", "BIND_PHONE_REQUIRED", "BIND_PHONE", "REQUIRE_PHONE_BINDING"])
export const WECHAT_IP = new Set(["REQUIRED_IP_VERIFY", "IP_VERIFY_REQUIRED", "IP_VERIFY", "REQUIRE_IP_VERIFY"])
export const wechatStatusOf = (body) => {
  const data = unwrapped(body)
  const said = typeof data?.status === "string" ? data.status.trim().toUpperCase() : ""
  // The vendor's sentence is shown on the page and kept by the host as the
  // failure, so a credential it quotes is cut here, at the source: whatever
  // reads this state is handed words with no token in them.
  const message = scrubShapes(saidBy(body), "")
  const expired = said === "EXPIRED" || codeOf(body?.code) === 404
  // A refusal is no status: a gateway answering 500 (or success:false, or a
  // word code) beside a stale `data.status:"SUCCESS"` used to finish the
  // sign-in with the token inside that refusal. The 404 expiry is the
  // vendor's other way of saying "this code is gone" and is read below.
  if (!expired && refusalWithin(body)) {
    const refused = refusalWithin(body)
    const rCode = codeOf(refused?.code)
    const expiredWord = /^(?:invalid_token|token_expired|token_invalid|unauthorized)$/.test(errorCodeOf(refused) ?? "")
    return { state: "error", message: scrubShapes(saidBy(refused), "") || (rCode === 401 || rCode === 403 || expiredWord ? "登录已过期，请重新登录" : "扫码登录失败") }
  }
  if (WECHAT_DONE.has(said)) {
    const token = keptToken(typeof data?.token === "string" ? data.token : "")
    const username = typeof data?.username === "string" ? data.username.trim() : ""
    if (token) return { state: "done", token, username }
    // A "done" is not one unless its token is one the plugin can keep: the
    // same gate login, verify_ip and a renewal pass, so a malformed or spent
    // token is refused here rather than saved and then unreadable on the card.
    if (typeof data?.token === "string" && data.token.trim()) {
      return { state: "error", message: message || "扫码登录返回的令牌无法使用（含不可见字符或已过期）" }
    }
    // a "done" that carries no token is not one either: the page would close on
    // a sign-in that never happened
    return { state: "error", message: message || "扫码登录没有返回令牌" }
  }
  if (WECHAT_BIND.has(said)) return { state: "error", message: message || "该微信还没有绑定科搭账号：请先登录科搭并绑定手机号，再回来扫码" }
  if (WECHAT_IP.has(said)) return { state: "error", message: message || "该账号当前网络需要短信安全验证：请改用「科搭OAuth登录」里的手机号登录" }
  if (said === "FAILED") return { state: "error", message: message || "扫码登录失败" }
  if (expired) return { state: "expired" }
  if (said === "SCANNED") return { state: "scanned" }
  // A code that is still waiting answers with the vendor's own "查询成功"
  // (measured 2026-11-11), which is a sentence about the poll, not about the
  // sign-in: the page says "请使用微信扫码" and this would replace it with a
  // word that tells the person nothing. Only a sentence the vendor wrote for
  // an unusual state is passed on.
  const waiting = /^(?:查询成功|成功|ok|success)$/i.test(message.trim()) ? "" : message
  return { state: "waiting", message: waiting }
}

// refreshToken asks the vendor for the next token in place of one that has not
// run out yet. It throws ApiError with signIn "expired" when the vendor says
// the token is no longer one it will renew, so the host marks the account
// signed out instead of asking again on a schedule.
export async function refreshToken(token, opts = {}) {
  let r
  try {
    r = await request(`${ACCOUNT}${REFRESH_PATH}`, { method: "POST", token, ...opts, businessCodes: true })
  } catch (e) {
    // 401 is the vendor's "not a token I renew" (expired, revoked, signed in
    // elsewhere) — the same answer every other endpoint gives a dead sign-in.
    // It arrives two ways: as the HTTP status, or as the business code of a
    // 200 body ({"code":401,"message":"Token has expired"}), which is the
    // shape this endpoint actually answers with.
    if (e?.status === 401 || String(e?.code ?? "") === "401") throw Object.assign(e, { signIn: "expired" })
    throw e
  }
  // A refusal can sit inside the wrapper, at any depth: `{"code":200,"data":
  // {"code":401,"message":"Token has expired"}}` passes the top-level business
  // gate and then has no token, which was reported as "the answer had no
  // token" — a failure the host retries forever instead of the expired
  // sign-in it is; an inner refusal whose data still holds a token was read
  // as a renewed one. Every node of the chain is read.
  const refusedNode = refusalWithin(r)
  if (refusedNode) {
    const inner = codeOf(refusedNode.code)
    const wordCode = errorCodeOf(refusedNode)
    const stated = Number.isFinite(inner) ? String(inner) : String(wordCode)
    const e = new ApiError(saidBy(refusedNode) || `code ${stated}`, 200, { code: stated, body: refusedNode })
    if (inner === 401 || inner === 403 || /^(?:invalid_token|token_expired|token_invalid|unauthorized)$/.test(String(wordCode ?? ""))) e.signIn = "expired"
    throw e
  }
  const body = unwrapped(r)
  const said = typeof body?.token === "string" ? body.token.trim() : ""
  if (!said) throw new ApiError("续期响应里没有令牌", 200, { code: "no_token", body: r })
  const next = keptToken(said)
  if (!next) throw new ApiError("续期返回的令牌无法使用（含不可见字符或已过期）", 200, { code: "unusable_token", body: r })
  return next
}

// humanSecs says a number of seconds the way a card wants it. A number no
// calendar can say (a vendor's Infinity, a NaN, a wait past year 9999) is
// said as nothing rather than as "Infinity 天" or "1.15e+303 天": the caller
// leaves it out. Neither is a value that is not a number at all (see numOf):
// Number(true) would be said as "1 秒", and the vendor said no such thing.
export function humanSecs(secs) {
  const raw = numOf(secs)
  if (!isFinite(raw) || raw > MAX_WAIT_SECS) return ""
  // A positive wait under half a second rounds to 0, and the card read
  // "0 秒后可再领" — a window the vendor opened almost now, said as no wait
  // at all. Rounded up instead: retry_after 0.4 is said as "1 秒".
  const n = raw > 0 ? Math.max(1, Math.round(raw)) : 0
  if (n < 60) return `${n} 秒`
  const m = Math.round(n / 60)
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  const rest = m % 60
  if (h < 24) return rest ? `${h} 小时 ${rest} 分钟` : `${h} 小时`
  const d = Math.floor(h / 24)
  const rh = h % 24
  return rh ? `${d} 天 ${rh} 小时` : `${d} 天`
}

// balanceOf is a vendor field as a balance: a number, or a string that says
// one (numOf). A made-up 0 is a balance the account does not have — routing
// would read the account as spent. A negative is not a balance either: the
// host clamps a wallet reading to 0, so passing one on would put "-5 点" on
// the card beside a routing figure of 0.
export const balanceOf = (v) => {
  const n = numOf(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

// pickOf reads each field by trying the vendor's own names in the order its
// client does (app.asar's Dn), and takes the first that says a balance.
export const pickOf = (body, names) => {
  for (const name of names) {
    const n = balanceOf(body?.[name])
    if (n != null) return n
  }
  return null
}

// unwrapped is the body the vendor's client reads: `data` when that is an
// object, the answer itself otherwise (app.asar's Gt). The live points body
// is flat ({code, token, agent_token, rewrite_token}); a wrapped one is what
// that client prefers if the vendor starts sending it.
export const unwrapped = (r) => {
  // One wrapper is today's shape ({code, data:{…}}); a refusal carried two
  // levels in ({code:200, data:{code:200, data:{code:500}}}) is read the
  // same way, to a stop: a body that wraps itself is a loop.
  let out = r
  for (let i = 0; i < 8 && out?.data && typeof out.data === "object" && !Array.isArray(out.data); i++) out = out.data
  return out
}

// refusalWithin is the first node of the wrapper chain (the answer, then each
// object under its `data`) that states a refusal, or null. A wrapper's code
// 200 does not make the object under it an answer: an inner 401 beside a
// token, or an inner success:false beside yesterday's balance, is the refusal
// it is, and unwrapped() walks past it to the fields. The day's own
// `already_claimed` word is the caller's to read, so it is not a refusal here
// unless the caller asks for every word to count.
export const refusalWithin = (r, { all = false } = {}) => {
  // the word code a node states about itself: errorCodeOf also reads `data`,
  // which here would make the envelope look like the refusal and hand its 200
  // back as the code
  const wordHere = (node) => {
    for (const c of [node?.code, node?.error?.code, node?.detail?.code]) {
      const text = typeof c === "string" ? c.trim() : ""
      if (text && !Number.isFinite(Number(text))) return text
    }
    return ""
  }
  // The deepest node that names the sign-in's death (an expiry or a
  // restriction) is the refusal to report: an outer `success:false` beside an
  // inner 401 is the flag a refusal carries along, and returning the outer
  // node would hand the caller a 200 code and a generic sentence exactly where
  // the expired sign-in and its fix are the answer. Any other refusal is the
  // first one met.
  const endsSignIn = (node) => {
    const code = codeOf(node?.code)
    return code === 401 || code === 403 || /^(?:invalid_token|token_expired|token_invalid|unauthorized|account_restricted)$/.test(wordHere(node))
  }
  let first = null
  let deepest = null
  let node = r
  // The root and every node under a `data` wrapper unwrapped() would hand
  // back — eight wrappers. Reading one node less left a refusal at the last
  // wrapper unread, and freeModelOf claimed a campaign the answer had just
  // refused.
  for (let i = 0; i < 9 && node && typeof node === "object" && !Array.isArray(node); i++) {
    const wordCode = wordHere(node)
    if (saidNo(node.success) || refusedCode(codeOf(node.code)) || (wordCode && (all || wordCode !== "already_claimed"))) {
      first ??= node
      if (endsSignIn(node)) deepest = node
    }
    node = node.data
  }
  return deepest ?? first
}
// GENERAL_POINTS_NAMES / AGENT_POINTS_NAMES are the names the vendor's own
// client reads each balance by (app.asar's am → Dn(n, […])); the live body
// says `token` and `agent_token`, and the rest are the spellings it hedges on.
export const GENERAL_POINTS_NAMES = ["token", "remaining_points", "points", "balance"]
export const AGENT_POINTS_NAMES = ["agent_token", "agentToken", "agent_points", "agentPoints"]

// pointsOf reads the account's two balances. `token` is the general points,
// `agent_token` the agent ones; both are integers the server keeps. A refusal
// comes back as HTTP 200 with a body code (measured 2026-10-27: {"code":401,
// "message":"Invalid token"}); left as "two fields we cannot read", the card
// came out blank with no error and no expired mark.
export const pointsOf = async (token, username, opts) => {
  const r = await request(`${ACCOUNT}${POINTS_PATH}`, { method: "POST", body: { username, token: 0 }, token, ...opts })
  // Any node of the wrapper chain can state a refusal — an inner 401 beside a
  // stale token included — and unwrapped() walks past it to the fields.
  const refusedNode = refusalWithin(r)
  if (refusedNode) {
    const rCode = codeOf(refusedNode.code)
    const rWord = errorCodeOf(refusedNode)
    const said = saidBy(refusedNode).trim()
    if (rWord === "account_restricted") throw new ApiError("账号 API 访问受限（account_restricted），请联系科搭支持", Number.isFinite(rCode) ? rCode : 0, { code: "account_restricted" })
    if (clientGated(rWord, said)) throw new ApiError(CLIENT_GATED, Number.isFinite(rCode) ? rCode : 0, { code: "client_not_supported" })
    const expiredWord = /^(?:invalid_token|token_expired|token_invalid|unauthorized)$/.test(rWord ?? "")
    const why = rCode === 401 || rCode === 403 || expiredWord
      ? restricted({ message: said }) ? "账号 API 访问受限（account_restricted），请联系科搭支持" : "登录已过期，请重新登录"
      : said || (Number.isFinite(rCode) ? `点数查询失败（code ${rCode}）` : "点数查询失败")
    // a word that names the sign-in's death carries the same status its
    // numeric spelling would: the usage hook marks the account signed out by it
    throw new ApiError(why, Number.isFinite(rCode) ? rCode : expiredWord ? 401 : 0, { code: rWord })
  }
  // The gate anywhere in the chain, read after the refusal node so an
  // account_restricted word keeps its words: a success word outside with the
  // refusal under `data` was read as a balance.
  if (gateWithin(r)) throw new ApiError(CLIENT_GATED, 0, { code: "client_not_supported" })
  // the vendor's own client (app.asar's ft) refuses any answer whose code is
  // a number other than 200 — Number(e.code) as it reads it — and only then
  // reads the balances. Only `>= 400` was refused here, so a refusal spelled
  // with a smaller code ({code: 1, token: 0}) read as a balance of 0 and the
  // card said the account was spent.
  //
  // codeOf, not Number: Number({toString:1}) calls the object's toString and
  // Number({valueOf:…}) calls valueOf, so a vendor answering {"code":{…}}
  // threw out of the hook — no card, no message, just a failed read. codeOf
  // reads what the client's Number() reads without calling into an object,
  // and answers NaN for an object, which the isFinite guard below treats as
  // "no code", as the vendor's own client does when the field is missing.
  const code = codeOf(r?.code)
  // The business code is read before the numeric one: a body whose code is the
  // word account_restricted answers 200 as readily as 403, and a 200 with no
  // numeric code used to fall through to "no balance in the answer" — the
  // card then said the points read failed (or worse, drew the agent figure
  // and said nothing at all) instead of naming the restriction.
  if (errorCodeOf(r) === "account_restricted") throw new ApiError("账号 API 访问受限（account_restricted），请联系科搭支持", Number.isFinite(code) ? code : 0, { code: "account_restricted" })
  // Any other business code in words is a refusal too ({"code":"invalid_token"}):
  // read as "no code", the body's token:0 and agent_token:0 became a balance
  // of zero the account does not have. An invalid token is the sign-in's.
  const word = errorCodeOf(r)
  if (word) {
    const expiredWord = /^(?:invalid_token|token_expired|token_invalid|unauthorized)$/.test(word)
    if (clientGated(word)) throw new ApiError(CLIENT_GATED, Number.isFinite(code) ? code : 0, { code: "client_not_supported" })
    throw new ApiError(expiredWord ? "登录已过期，请重新登录" : saidBy(r).trim() || "点数查询失败", expiredWord ? 401 : 0, { code: word })
  }
  if (refusedCode(code)) {
    // A refusal's words are read the way the vendor's client reads them
    // (app.asar's vo): the first of message/msg/error/detail, and the same
    // four under data, that has text — reading message alone drops words the
    // vendor put in msg or data, and the card then reports a bare code.
    const said = saidBy(r).trim()
    // A restriction can be spelled in the words beside a 401/403 rather than
    // in a code: telling the user to sign in again is then the wrong fix
    // (restricted() exists for that), and `signIn: "expired"` marks the
    // account expired in magpie.
    const why = code === 401 || code === 403
      ? restricted({ message: said }) ? "账号 API 访问受限（account_restricted），请联系科搭支持" : "登录已过期，请重新登录"
      : said || `点数查询失败（code ${code}）`
    throw new ApiError(why, code, { code: errorCodeOf(r) })
  }
  // `success: false` is the vendor's explicit refusal, whatever the code says:
  // a 200 beside it is "the HTTP layer says yes, the business layer says no",
  // and reading its fields as a balance is how a refusal became "0 点".
  // The wrapper carries the same refusals one level in (`{data:{code:401,…}}`,
  // `{data:{success:false,…}}`), and the gates above ran on the envelope only;
  // without these, a wrapped refusal was read as a balance of 0.
  const wrapped = unwrapped(r)
  if (wrapped !== r) {
    const wCode = codeOf(wrapped.code)
    if (errorCodeOf(wrapped) === "account_restricted") throw new ApiError("账号 API 访问受限（account_restricted），请联系科搭支持", Number.isFinite(wCode) ? wCode : 0, { code: "account_restricted" })
    if (clientGated(errorCodeOf(wrapped), saidBy(wrapped))) throw new ApiError(CLIENT_GATED, Number.isFinite(wCode) ? wCode : 0, { code: "client_not_supported" })
    if (refusedCode(wCode)) {
      const said = saidBy(wrapped).trim()
      const why = wCode === 401 || wCode === 403
        ? restricted({ message: said }) ? "账号 API 访问受限（account_restricted），请联系科搭支持" : "登录已过期，请重新登录"
        : said || `点数查询失败（code ${wCode}）`
      throw new ApiError(why, wCode, { code: errorCodeOf(wrapped) })
    }
    if (saidNo(wrapped.success)) throw new ApiError(saidBy(wrapped).trim() || "点数查询失败", 0, { code: errorCodeOf(wrapped) })
  }
  if (saidNo(r?.success)) throw new ApiError(saidBy(r).trim() || "点数查询失败", 0, { code: errorCodeOf(r) })
  const body = unwrapped(r)
  const general = pickOf(body, GENERAL_POINTS_NAMES)
  const agent = pickOf(body, AGENT_POINTS_NAMES)
  // a 200 whose body names no balance at all is a read we cannot use: said
  // as an error, the card says why, instead of drawing nothing
  if (general == null && agent == null) throw new ApiError("点数查询没有返回余额", 0)
  return { general, agent }
}

// AGENT_BALANCE_NAMES is the vendor's own list for the second endpoint
// (app.asar's cm → Dn(n, […])) plus the name today's answer actually uses:
// measured 2026-11-02 it answers {data:{"username":…,"agent_balance":N}}, and
// neither that client's list nor ours named `agent_balance` — so neither of
// us could read it. `balance`/`points` keep their place at the front, as that
// client has them.
export const AGENT_BALANCE_NAMES = ["balance", "points", "agent_balance", "agent_token", "agentToken", "agent_points", "agentPoints", "remaining_points"]

// agentPointsOf reads the account's agent points from the vendor's second
// balance endpoint. Its own client keeps this read beside the one above and
// falls back across the two (app.asar's S0: allSettled over /v1/gettoken,
// /v1/agent/balance and /api/user/self), so a dead /v1/gettoken still leaves
// the agent figure readable.
//
// It does not read /api/user/self, the third path: that one answers a
// different pot (measured the same day: its quota is 0 while the points are
// 2348). Reported as this account's wallet it would put "0 点" on the card
// and route a funded account as spent — the one thing every read here
// refuses to do.
export const agentPointsOf = async (token, username, opts) => {
  const r = await request(`${ACCOUNT}${AGENT_POINTS_PATH}`, { method: "POST", body: { username }, token, ...opts })
  // Any node of the wrapper chain can state a refusal, as in pointsOf.
  const refusedNode = refusalWithin(r)
  if (refusedNode) {
    const rCode = codeOf(refusedNode.code)
    const rWord = errorCodeOf(refusedNode)
    const said = saidBy(refusedNode).trim()
    if (rWord === "account_restricted") throw new ApiError("账号 API 访问受限（account_restricted），请联系科搭支持", Number.isFinite(rCode) ? rCode : 0, { code: "account_restricted" })
    if (clientGated(rWord, said)) throw new ApiError(CLIENT_GATED, Number.isFinite(rCode) ? rCode : 0, { code: "client_not_supported" })
    const expiredWord = /^(?:invalid_token|token_expired|token_invalid|unauthorized)$/.test(rWord ?? "")
    const why = rCode === 401 || rCode === 403 || expiredWord
      ? restricted({ message: said }) ? "账号 API 访问受限（account_restricted），请联系科搭支持" : "登录已过期，请重新登录"
      : said || (Number.isFinite(rCode) ? `点数查询失败（code ${rCode}）` : "点数查询失败")
    // a word that names the sign-in's death carries the same status its
    // numeric spelling would: the usage hook marks the account signed out by it
    throw new ApiError(why, Number.isFinite(rCode) ? rCode : expiredWord ? 401 : 0, { code: rWord })
  }
  if (gateWithin(r)) throw new ApiError(CLIENT_GATED, 0, { code: "client_not_supported" })
  const code = codeOf(r?.code) // an object code must not throw (see pointsOf)
  // the word code first, as in pointsOf: an answer may carry it beside a 200
  if (errorCodeOf(r) === "account_restricted") throw new ApiError("账号 API 访问受限（account_restricted），请联系科搭支持", Number.isFinite(code) ? code : 0, { code: "account_restricted" })
  if (clientGated(errorCodeOf(r), saidBy(r))) throw new ApiError(CLIENT_GATED, Number.isFinite(code) ? code : 0, { code: "client_not_supported" })
  if (refusedCode(code)) {
    const said = saidBy(r).trim()
    // A restriction can be spelled in the words beside a 401/403 rather than
    // in a code: telling the user to sign in again is then the wrong fix
    // (restricted() exists for that), and `signIn: "expired"` marks the
    // account expired in magpie.
    const why = code === 401 || code === 403
      ? restricted({ message: said }) ? "账号 API 访问受限（account_restricted），请联系科搭支持" : "登录已过期，请重新登录"
      : said || `点数查询失败（code ${code}）`
    throw new ApiError(why, code, { code: errorCodeOf(r) })
  }
  // the explicit refusal flag, as in pointsOf
  if (saidNo(r?.success)) throw new ApiError(saidBy(r).trim() || "点数查询失败", 0, { code: errorCodeOf(r) })
  // the wrapped shape's refusals, as in pointsOf: read without them,
  // `{data:{code:401,agent_balance:0}}` answered a refused read as 0.
  const wrapped = unwrapped(r)
  if (wrapped !== r) {
    const wCode = codeOf(wrapped.code)
    if (errorCodeOf(wrapped) === "account_restricted") throw new ApiError("账号 API 访问受限（account_restricted），请联系科搭支持", Number.isFinite(wCode) ? wCode : 0, { code: "account_restricted" })
    if (clientGated(errorCodeOf(wrapped), saidBy(wrapped))) throw new ApiError(CLIENT_GATED, Number.isFinite(wCode) ? wCode : 0, { code: "client_not_supported" })
    if (refusedCode(wCode)) {
      const said = saidBy(wrapped).trim()
      const why = wCode === 401 || wCode === 403
        ? restricted({ message: said }) ? "账号 API 访问受限（account_restricted），请联系科搭支持" : "登录已过期，请重新登录"
        : said || `点数查询失败（code ${wCode}）`
      throw new ApiError(why, wCode, { code: errorCodeOf(wrapped) })
    }
    if (saidNo(wrapped.success)) throw new ApiError(saidBy(wrapped).trim() || "点数查询失败", 0, { code: errorCodeOf(wrapped) })
  }
  return pickOf(wrapped, AGENT_BALANCE_NAMES)
}

// tokensOf is a vendor's token count — a context window, a reply ceiling —
// as a non-negative whole number. A negative or an infinite one is not a
// size anyone can plan with, and it would reach magpie's list as written, so
// it becomes "not stated" (0). Neither is a value that is not a number at
// all (see numOf).
export function tokensOf(v) {
  const n = numOf(v)
  // an upper bound as well as a lower one: 1e15 is a valid JSON number but no
  // context window, and written into magpie's list it would plan for a context
  // the vendor does not have. MAX_TOKENS is far above the largest window the
  // vendor lists today (2M), so a real one is never cut.
  return Number.isFinite(n) && n > 0 && n <= MAX_TOKENS ? Math.floor(n) : 0
}

// baseURL is an address as it is written down: the surrounding whitespace
// and the trailing slashes off, the vendor's gateway when nothing is said.
// magpie joins a request path onto the base as written, so a base kept as
// ".../v1//" would ask ".../v1//chat/completions" — and one with a newline
// in it is a URL no client can send. One rule for both places an address is
// written: the config entry (which magpie reads as cfg.api), and the base a
// live refresh writes on each model.
export const baseURL = (v) => {
  const said = typeof v === "string" ? v.trim().replace(/\/+$/, "") : ""
  if (!said) return `${API}/v1`
  // an address magpie will join a path onto must be an absolute http(s) URL:
  // `//host/v1` joins onto no scheme, `file://` sends a chat request at a
  // file, and a value a hand-edited config got wrong would otherwise carry
  // the account's key to wherever it points. A value that is not one falls
  // back to the vendor's gateway rather than being used.
  try {
    const u = new URL(said)
    // A host is what makes it an address to send a key to. WHATWG reads
    // "https:///v1" as host "v1" with no path — but nobody writes an empty
    // authority on purpose; they meant the path, and the address would send
    // the account's key to a host named after the first path segment. An
    // authority written empty is not used.
    const authority = said.replace(/^[a-z][a-z0-9+.-]*:/i, "").replace(/^\/\//, "")
    if ((u.protocol === "https:" || u.protocol === "http:") && u.hostname && authority && !authority.startsWith("/")) return underV1(said)
  } catch {}
  return `${API}/v1`
}

// underV1 is the address a request's "/v1" is joined under, and it follows
// one rule for the vendor's gateway and a user's own address alike: an
// address whose path already ends in "/v1" is left as it is, and any other
// has "/v1" appended to its path. The vendor writes its gateway without
// "/v1" and means the API under it (the loader's comment says why an OpenAI
// and an Anthropic client alike need it there); a user who re-points the
// provider at a proxy writes the proxy's address the same way, and the base
// magpie joins onto is the same base.
//
// The query and the fragment are dropped, not moved: magpie (plugins.go's
// pluginFetch) and both clients join the endpoint by string concatenation,
// so a base ending "?route=chat" would put "/chat/completions" inside the
// query value, and one ending "#frag" inside the fragment. A base with
// either is not a base a request path can be joined onto — the query the
// user wrote would be sent with every request rather than as one path's
// parameters — so the address is read by its scheme, host and path.
const underV1 = (said) => {
  const u = new URL(said)
  const path = u.pathname.replace(/\/+$/, "")
  // The authority as written, credentials included: a user's own proxy may
  // sit behind a name and password, and the URL parser keeps them apart from
  // the origin, which never carries them.
  const authority = u.host ? `${u.username ? `${u.username}${u.password ? `:${u.password}` : ""}@` : ""}${u.host}` : ""
  return `${u.protocol}//${authority}${/\/v1$/.test(path) ? path : `${path}/v1`}`
}

// apiBase is where this provider's requests go: the address the host already
// resolved for it — the user's own setting when they made one, else the
// vendor's gateway. host.js builds a config model's api.url as
// `m.provider?.api ?? cfg.api ?? …`, so a provider handed to the models hook
// already carries the user's choice on its own api and on each model's; the
// hook has to keep it, because magpie picks the base as
// `firstOf(o.BaseURL, m.URL, pp.API, …)` — a model-level URL wins over the
// provider's, so a hard-coded gateway on every model sends a user's own
// proxy nowhere the moment a live refresh succeeds.
export const apiBase = (provider, id) => {
  const perModel = id ? provider?.models?.[id]?.api?.url : ""
  const said = typeof perModel === "string" && perModel.trim() ? perModel : provider?.api
  return baseURL(said)
}

// KINDS are the modalities magpie knows, in the order a card lists them.
export const KINDS = ["text", "image", "audio", "video", "pdf"]

// modalitiesOf is a vendor modality list as the record keeps it: the kinds we
// know, strings only, in the vendor's order, and "text alone" when it names
// none (the same reading kindsOf gives, kept here so the catalog a record is
// written from holds nothing else). A list is otherwise the one place a
// vendor's arbitrary value — an object, a credential — could ride into the
// committed catalog.mjs and into the model list the host persists.
export const modalitiesOf = (v) => {
  const known = Array.isArray(v) ? v.filter((k) => typeof k === "string" && KINDS.includes(k)) : []
  return known.length ? known : ["text"]
}

// kindsOf is a vendor modality list as the kinds we know. An answer that
// names none of them — an empty list, or names this host does not know
// (a rename, a case change) — is read as "text alone", not as "takes
// nothing": every model here is a chat model, and a model that takes no
// text at all would be asserted onto magpie's catalog (host.js's imageSaid
// turns a stated `image: false` into a fact), taking every input away over
// a name we merely failed to translate. A missing field reads the same way,
// so "not said" has one meaning everywhere.
export const kindsOf = (v) => {
  const known = Array.isArray(v) ? KINDS.filter((k) => v.includes(k)) : []
  return known.length ? known : ["text"]
}

// protocolOf is a vendor record's protocol as its own catalogue names it. The
// vendor's schema has three (its sidecar's protocol.type enum:
// openai_chat_completions | openai_responses | anthropic_messages, the last
// two posted to /v1/responses and /v1/messages). A record keeps the vendor's
// own word: flattened to the chat one, the fallback list would say a protocol
// we cannot serve is one we can, and a regeneration would write that lie into
// catalog.mjs.
export const PROTOCOLS = new Set(["openai_chat_completions", "openai_responses", "anthropic_messages"])
export const protocolOf = (m) => {
  // a record states the protocol as an object ({type}) or, in some answers,
  // as the bare string; both are read, and a protocol the vendor names but
  // this host does not know still reads "" either way.
  const p = m?.protocol
  const said = typeof p === "string" ? p : p?.type
  // a protocol the vendor *named* with a value that is not a string — a
  // number, an object — is a shape we cannot read, not "no protocol stated":
  // reading it as chat is the one answer this function must not give.
  if (typeof said !== "string" && p != null && (typeof p !== "object" || Object.hasOwn(p, "type"))) return ""
  // a record that states no protocol is a chat one (every record before the
  // vendor named protocols was); one that states a protocol this host cannot
  // serve is "" — not chat. Flattening it to chat is what the catalog's own
  // comment warns about: the fallback would say a wire we cannot send is the
  // one we use, and a regeneration would write that lie into catalog.mjs.
  if (typeof said === "string" && said) return PROTOCOLS.has(said) ? said : ""
  return "openai_chat_completions"
}

// modelOf is one catalog record as magpie's provider list has it. `base` is
// the provider's address (apiBase), the vendor's gateway when nothing else
// says otherwise.
//
// An Anthropic model states base + "/v1" as its own URL; a chat model states
// the base itself. magpie sends a request at `base + rest`, where base is the
// loader's address, else the model's own URL, else the provider's, after
// taking the SDK's own "/v1" off `rest` for an Anthropic request (the loader's
// comment at index.mjs's config hook says what it measured). The address the
// loader answers already ends in "/v1" (baseURL's rule), so both protocols
// arrive at ".../v1/...": a chat request carries its own "/v1"
// (base + "/chat/completions"), and an Anthropic one's "/messages" joins onto
// the same base.
export function modelOf(m, base = `${API}/v1`) {
  const anthropic = m?.protocol === "anthropic_messages"
  // The provider's bare address, whichever form the caller passes: the
  // config hook writes .../v1 there, the models hook resolves it from the
  // provider, and the loader answers that same address (see the config hook).
  // modelOf's own URL is built from it with "/v1" put back by hand, so it is
  // taken off here; the loader's baseURL is not (the host joins under it).
  const bare = String(base ?? "").trim().replace(/\/+$/, "").replace(/\/v1$/, "")
  const url = anthropic ? `${bare}/v1` : bare || `${API}/v1`
  const npm = anthropic ? CLAUDE : OPENAI
  const reasons = Boolean(m?.reasoning)
  const input = kindsOf(m?.input)
  const output = kindsOf(m?.output)
  const takes = (list) => Object.fromEntries(KINDS.map((k) => [k, list.includes(k)]))
  return {
    id: m.id,
    name: m.name || m.id,
    // host.js resolves a config model's SDK as m.provider?.npm ?? cfg.npm ??
    // … (the `m.provider?.npm ?? cfg.npm ?? was?.api.npm` line): api.npm is
    // not read on that path. Without provider.npm the fallback list gave
    // every model the provider-level openai-compatible, so Claude models
    // lost the anthropic protocol whenever the vendor's catalog could not
    // be fetched.
    provider: { npm },
    api: { id: m.id, url, npm },
    limit: { context: tokensOf(m.context), output: tokensOf(m.maxOutput) },
    // the credits a request costs, as the vendor lists them (catalog.mjs's
    // rate): magpie shows it by the model; 0 is "not listed". Only the
    // models hook reads this — the config hook's model path does not — so the
    // hook returns every model here, the embedded catalog's included.
    rate: numOf(m.rate) > 0 ? numOf(m.rate) : 0,
    // The vendor prices in CNY per million tokens; magpie's cost column is
    // US dollars, and inventing an exchange rate here would put a wrong
    // number on the Usage page. Left at 0, which magpie shows as unpriced
    // where no catalog knows the model's maker price.
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    // The model's abilities are read from two places, and only together do
    // they cover both paths a model takes into magpie: the config hook's
    // list is merged from these top-level fields (`m.reasoning`,
    // `m.attachment`, `m.tool_call`, `m.modalities`), while the list the
    // models hook returns is read through `capabilities` (`m.capabilities?
    // .reasoning`, `kinds(m.capabilities?.input)`). The config path alone
    // had neither reasoning nor image.
    reasoning: reasons,
    tool_call: true,
    attachment: input.includes("image"),
    modalities: { input, output },
    capabilities: { temperature: true, toolcall: true, reasoning: reasons, input: takes(input), output: takes(output) },
    headers: {},
  }
}

export const modelsOf = (list, base) => Object.fromEntries(list.map((m) => [m.id, modelOf(m, typeof base === "function" ? base(m.id) : base)]))

// mergeModel is the user's own model entry folded onto the catalog's, field by
// field at every depth: what the user set wins, and the fields they did not
// touch stay. A plain spread kept the catalog's fields only at the top level —
// a user who set just `provider.api` lost `provider.npm` with it, and the
// host, reading m.provider?.npm ?? cfg.npm, built a Claude model on the
// provider-level openai-compatible: it went out over the chat protocol. The
// same loss hit `limit` (an entry saying only `{ output: 4096 }` dropped the
// context window). Values that are not maps (a name, a number, a list such as
// variants or modalities.input) are taken as the user wrote them.
//
// Keys that name properties of every object (`__proto__`, `constructor`,
// `prototype`) are never folded in: writing out["__proto__"] = … sets the
// merged entry's prototype instead of a field, so a hand-written entry could
// put inherited getters under m.name/m.provider; the rest would ride along
// as own keys the host copies into the model it builds. No model has a field
// by those names, so dropping them loses nothing.
export const MAGIC_KEYS = new Set(["__proto__", "constructor", "prototype"])

// noMagicKeys drops the keys that name properties of every object from a map
// about to be handed to the host as a model list. `Object.fromEntries` and
// object spread both create own data properties — a record whose id is
// `__proto__` becomes an own key without touching the prototype — but the
// host's next step on that list is `out.models[key] = { … }`, a bracket
// assignment, and that one sets the prototype: the model would vanish from
// `Object.keys` and its fields would answer for the map itself. No model is
// named any of these, so dropping them costs nothing.
export const noMagicKeys = (map) => {
  for (const k of MAGIC_KEYS) if (Object.hasOwn(map, k)) delete map[k]
  return map
}
export const mergeModel = (ours, theirs) => {
  if (!plain(ours) || !plain(theirs)) return theirs
  const out = { ...ours }
  for (const [k, v] of Object.entries(theirs)) {
    if (MAGIC_KEYS.has(k)) continue
    out[k] = Object.hasOwn(ours, k) ? mergeModel(ours[k], v) : v
  }
  return out
}

// shapeCuts says a vendor string is not one to serve: a lone surrogate (the
// host would throw on it), the account's key in any form that reassembles
// (plain, folded, encoded, split across the list, or encoded past what a fold
// walk sees), or a credential shape a model id and name cannot legitimately
// wear (an `sk-` key, a Bearer, a JWT, a run of hex, a field that names itself
// one). The card's mixed-token rule is deliberately not asked of a catalog
// field: it cuts any 24+ run carrying a digit and a letter, and a vendor names
// model ids exactly like that ("a1b2c3d4e5f6a7b8c9d0e1f2"), so a field is
// judged by how a credential is written instead of by the prose rule's
// fail-closed answer (a card loses a word; a catalog loses the record). On the
// generator path there is no key: every string there was already cut by
// cutKey, and the shape pass over prose would cut a vendor name that merely
// looks long.
const shapeCuts = (said, key, list = [said]) =>
  hasSurrogate(String(said ?? "")) ||
  (Boolean(key) && (echoesIn(list, key) || modelCredential(said)))
// credentialish is the question for a vendor field before the shape pass:
// does this string hold anything a credential is written with (a JWT's head
// or segment shape, an sk- key, a Bearer, a fullwidth letter, a JSON escape,
// a dot between characters, a separator inside a word, a run of hex, a word
// that names itself one, a long mixed-case run with a digit)? An ordinary
// model name ("able translator") and an ordinary id
// ("a1b2c3d4e5f6a7b8c9d0e1f2", "DeepSeekR1DistillQwen32BInstruct") are none
// of these, which is what keeps the card's mixed-run rule from dropping the
// record. The full shape pass is expensive, and the pass over every name of
// a 2000-record catalog is what made the hook slow, so this cheap question
// goes first.
const credentialish = (said) => {
  // as in echoesKey: the run match below threw RangeError (V8 recurses on a
  // global match) on an 8 MB vendor field, in a hook
  const saidText = String(said ?? "")
  const text = saidText.length > MAX_SCRUB_CHARS ? saidText.slice(0, MAX_SCRUB_CHARS) : saidText
  return (
    /eyJ|(?:sk|pk|rk)[-_]|Bearer|[\uff01-\uff5e]|\\+u[0-9a-fA-F]{4}|[A-Za-z0-9_-](?:[.][A-Za-z0-9_-]){4,}|[A-Za-z0-9._-][^A-Za-z0-9._-\s]/.test(text) ||
    // a run with an upper case, a lower case and a digit, long enough to be a
    // key's body: how a credential is written ("Ab3xY9Qw\u2026"), and not how a
    // vendor names a model (an id is lower case, all one case, or words \u2014
    // wordish exempts those, as the shape pass itself does)
    (text.match(/[A-Za-z0-9_-]{24,}/g) ?? []).some((run) => /\d/.test(run) && /[A-Z]/.test(run) && /[a-z]/.test(run) && !wordish(run)) ||
    /(?<![0-9A-Za-z])(?:0x)?[0-9a-fA-F]{32,}(?![0-9A-Za-z])/.test(text) ||
    /(?:^|[^A-Za-z0-9])(?:access|token|secret|key|auth|bearer|credential|api)[_-]/i.test(text) ||
    text.search(jwtShape) >= 0
  )
}
// modelCredential finds in a model id or name the credential shapes the
// scrubber cuts that a catalog entry cannot legitimately carry.
const modelCredential = (said) => {
  const text = String(said ?? "")
    .replace(INVISIBLE_BETWEEN, " ")
    .replace(/(?<![\w-])(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}(?![\w-])/g, (run) => (skModelish(run) ? run : "…"))
    .replace(/(?<![\w-])Bearer\s+[A-Za-z0-9._~+/-]{20,}(?![\w-])/g, "…")
    .replace(/(?<![0-9A-Za-z])0x?[0-9a-fA-F]{64,}(?![0-9A-Za-z])/g, "…")
  return text !== String(said ?? "")
}

// catalogOf is the vendor's answer as our catalog records: the same fields
// catalog.mjs keeps, so both paths build the same entries. Vendor text is
// cleaned: a control character would break the card it lands on, and an id
// that has to be cleaned is not an id a request can ask for, so that record
// is left out rather than renamed. A record that is not a plain object is
// left out too.
export function catalogOf(body, key = "") {
  // an answer whose business code refuses is no list, even when it carries
  // one: `{code: 500, data: [...]}` from a gateway, or an expired-token answer
  // that still echoes a stale list, is a refusal the vendor's own client
  // checks first (app.asar's ft). Read as a list it would replace every model
  // with whatever that refusal carried.
  const code = codeOf(body?.code)
  if (refusedCode(code)) return null
  // a business code stated in words (`{"code":"account_restricted"}`, the
  // shape the vendor's own refusals use) is a refusal too: the numeric gate
  // above reads it as "no code" and would serve whatever list the refusal
  // carried. The nested list gets the same gate.
  if (errorCodeOf(body) || errorCodeOf(body?.catalog)) return null
  // the nested list may carry its own code (the {catalog:{code, data}} shape):
  // a refusal stated there is a refusal too, and reading its data as a list
  // would replace every model with whatever that refusal carried.
  const inner = codeOf(body?.catalog?.code)
  if (refusedCode(inner)) return null
  // an explicit `success: false` is a refusal whatever the code says: the
  // vendor's activity endpoint uses the flag without a code, on the envelope
  // or on the nested catalog object.
  if (saidNo(body?.success) || saidNo(body?.catalog?.success)) return null
  const list = body?.catalog?.data ?? body?.data ?? null
  if (!Array.isArray(list)) return null
  const out = []
  // every raw id and name, for the two list-level questions at the end
  const idNames = []
  // each field's strings on their own too: a split echo sits in one field
  // (names, or ids), and an ids-and-names join interleaves two orders.
  const idHeads = []
  const nameHeads = []
  let examined = 0
  // examined counts every record looked at, kept or dropped; out.length alone
  // never reaches the cap on a list of records that all fail the checks below,
  // and the walk would run to the end of whatever the vendor sent.
  for (const m of list) {
    if (out.length >= MAX_MODELS || ++examined > MAX_MODELS) break
    // a record that is not a plain object (the list held a null, a boolean,
    // a bare number, an array) is left out: it has no id to serve, and the
    // host reads the list this hook answers with while it builds every
    // provider's row in one Promise.all — one such record would throw there
    // and take the whole provider list down, not just that row.
    if (!m || typeof m !== "object" || Array.isArray(m)) continue
    // The account's own token is cut out of the *raw* strings, before
    // cleanText truncates them: a name that is 80 characters of prose
    // followed by the token would lose all but the token's first 40
    // characters to the 120-character cut, and those 40 were past what
    // cutKey could still match. The key is empty on the generator path, which
    // cuts the whole answer itself (scripts/catalog.mjs's withoutToken).
    // an id or name carrying any 8-character run of the token is a split
    // echo: the whole-token cut above sees nothing, and the fields reassemble
    // once a reader puts them together. The id is dropped (no request can ask
    // for a fragment) and the name is left to fall back to the id.
    const rawId = typeof m.id === "string" ? m.id.trim() : ""
    const rawName0 = typeof m.display_name === "string" ? m.display_name : ""
    // what a served field can still carry: every check below reads these
    // (the strings as they would reach the host), so a megabyte-long name
    // is not walked a dozen times over for characters it has lost anyway.
    const idHead = rawId.slice(0, FIELD_REACH)
    const nameHead = rawName0.slice(0, FIELD_REACH)
    idNames.push(idHead, nameHead)
    idHeads.push(idHead)
    nameHeads.push(nameHead)
    // A credential of some other provider's (an `sk-` key, a Bearer) in an id
    // is not an id either: the account's own token is not the only thing a
    // hostile gateway can leak, and this list is persisted and served.
    if (shapeCuts(idHead, key)) continue
    // a match against the raw id, not the cut one: cutKey replaces the token
    // with "…", and comparing cleanText's output to the already-cut text said
    // "clean" about an id that had just been renamed — the record was served
    // under "model-…", an id no request can ask for.
    const idText = key ? cutKey(idHead, key) : idHead
    const id = cleanText(idText)
    if (!id || id !== idText || id !== idHead) continue
    // a record on a protocol this provider cannot carry is left out, as an id
    // a request could not ask for is: the vendor posts `openai_responses` to
    // /v1/responses, and the only OpenAI wire this plugin has is the chat one
    // (provider.npm = @ai-sdk/openai-compatible). Listed as chat it would be
    // a model whose every request goes out in the wrong shape. `""` is a
    // protocol the vendor named and this host does not know — the same
    // answer for the same reason, and a wire the vendor adds later cannot
    // come out as chat by default.
    const protocol = protocolOf(m)
    if (!protocol || protocol === "openai_responses") continue
    const cleaned = cleanText(key ? cutKey(nameHead, key) : nameHead)
    // A name that carries a run of the token, folded or encoded, is not a
    // name: the record's name falls back to its id. echoesKey reads the folded
    // form, decodedCarriesKey the base64 form (a gateway that echoes the token
    // encoded leaves nothing the fold walk or the shape rules can see). This
    // reads the name without its 120-character cut, so a token parked past
    // the cut still counts.
    const said = shapeCuts(nameHead, key) ? "" : cleaned
    out.push({
      id,
      name: said || id,
      context: tokensOf(m.context_window),
      // the most tokens a reply may hold, as the vendor's own request schema
      // states it (request_schema.properties.max_tokens.maximum): magpie
      // lowers a request asking for more to it (gateway's maxoutput.go),
      // which is what keeps a client's over-asking from reaching the vendor
      // as a refusal. 0 where the vendor states none — every model in the
      // 0.3.17 list states one, so this is the shape a quiet one takes.
      maxOutput: tokensOf(m.request_schema?.properties?.max_tokens?.maximum),
      // the vendor's own multiple of its base price (rate_badge, "0.20x"),
      // shown by magpie beside the model's name; 0 when it states none.
      rate: rateOf(m.rate_badge),
      input: modalitiesOf(m.input_modalities),
      output: modalitiesOf(m.output_modalities),
      protocol,
      reasoning: Boolean(m.reasoning),
    })
  }
  // the whole list as one text: pieces of the key spread over records carry
  // nothing alone, and put back together they are the key — even when the
  // record carrying the first piece was blanked by the shape rules. Read on
  // the raw strings (a served name has already lost what was cut), but not
  // the strings that carry the key on their own: those records were dropped
  // above, and would otherwise empty the list over a token one record held
  // whole. One check at the end, not one per record (the list grows as it is
  // walked).
  if (out.length && key) {
    // each field read on its own, then both together: a split echo is one
    // field's pieces in order, and joining ids into the names breaks the
    // order (the ids are ordinary words between the pieces). The strings are
    // judged once (the same ids and names appear in every list), and the
    // walks only run when a list holds the opening of the key — or of an
    // encoding of it — where a split's first piece is: a list of ordinary
    // names holds none.
    const judged = new Map()
    const keepOf = (s) => {
      const head = String(s ?? "").slice(0, FIELD_REACH)
      if (!judged.has(head)) judged.set(head, Boolean(head) && !echoesKey(head, key) && !encodedCarries(head, key))
      return judged.get(head)
    }
    const spelled = key.replace(/[^A-Za-z0-9._-]/g, "")
    const openers = [spelled, base32Encode(spelled), percentEncode(spelled)].map((spelling) => spelling.slice(0, OPENING_CHARS))
    for (const list of [idHeads, nameHeads, idNames]) {
      const kept = list.map((s) => String(s ?? "").slice(0, FIELD_REACH)).filter(keepOf)
      // field by field first: it needs no opening (a piece may sit behind a
      // label, "model-000-ey"), and it is what reads pieces with prose
      // between them. The joined walk is the cheap one and runs only when
      // the opening is there.
      if (splitFields(kept, key)) return null
      const text = kept.join(" ")
      if (openers.some((opening) => text.includes(opening)) && splitAcross(text, key)) return null
    }
  }
  // a list whose every id the credential gate dropped, with nothing kept to
  // judge a name by (the generator hands names on without the key, so the
  // per-name cut cannot fire there), is a list we could not serve either: its
  // ids were pieces of a credential, and read as "no models" it would empty a
  // committed fallback.
  if (!out.length && key && idNames.length && idNames.some((s) => shapeCuts(s, key))) return null
  // an empty list is the vendor's answer too — "this account is served no
  // models" — while a list whose every record we had to drop is a list we
  // could not read. Only the latter is "no answer": read as an empty list it
  // would take every model off the provider over records we merely failed to
  // parse, and read as an answer an empty one keeps the card honest. (A
  // refusal that carries a list is caught by the business-code gate above,
  // so an outage cannot empty the provider through this door.)
  if (!out.length && list.length) return null
  return out
}

// runningActivities are the free-model activities on right now, as the
// vendor's own clients say (free_until in the future, and not exhausted):
// one whose quota was spent is not free anymore. We follow the vendor app's
// own filter: ignore status, use only free_until and remaining_quota (the
// live data shows status "active" and ended_at null; the catalog shows
// status "active" too).
export const runningActivities = (body) => {
  // The answer code passes the vendor client's gate first (app.asar's EI
  // calls ft before reading the list): an answer whose numeric code is not
  // 200 is a refusal, even when it still carries a data — drawn anyway, it
  // would report activities that are not running at all as free. Today's
  // answer body has no code, only {data,message,success}, so this gate has
  // nothing to do for it; on the day the vendor sends a refusal with a code,
  // this blocks it the same way its client does.
  const code = codeOf(body?.code) // an object code must not throw (see pointsOf)
  // the explicit refusal flag: the vendor's activity endpoint answers
  // {data, message, success} and may say success:false with a stale list.
  if (saidNo(body?.success)) return []
  if (refusedCode(code)) return []
  // a business code in words ({"code":"account_restricted", data:[…]}) is a
  // refusal with a stale list beside it: drawn, it would report activities
  // that are not running as free.
  if (errorCodeOf(body)) return []
  // A wrapped answer ({data:{…}}) names no list here at all: the array check
  // below refuses it, refusal or not — the same answer for a wrapped refusal
  // and a shape this reader does not know, which draws nothing either way.
  const list = Array.isArray(body?.data) ? body.data : []
  const now = Date.now() / 1000
  return list.filter((a) => {
    if (!a || typeof a !== "object") return false
    // the same reading every other number here gets (numOf): a time the
    // vendor spells as a string is a time, not a missing one, and one no
    // calendar can state (1e999 reads as Infinity) is still a running
    // activity — the window below draws it without an end rather than
    // dropping a campaign over a number it cannot write down. Read as "not a
    // number" the activity vanished from the card without a word.
    const until = numOf(a.free_until)
    // `>` is false for a value that says no number at all (NaN) and for an
    // end already past, and true for an end past the calendar: 1e999 reads
    // as Infinity, and Infinity is in the future. The vendor's own client
    // rejects only a non-number, and a future it cannot write down is still
    // a future — the window below draws it without a time rather than
    // dropping a campaign over a number nobody can spell.
    if (!(until > now)) return false
    // A quota that says it is exhausted means these models are not free. One
    // that states a value we cannot read is not shown either: the card reads
    // quotaLeft == null as 「不限量」, so an unreadable value would be drawn as
    // "unlimited" — a claim we cannot stand behind. A null says unlimited;
    // a present but unreadable value says nothing at all.
    const quotaLeft = numOf(a.remaining_quota)
    if (a.remaining_quota != null && (!Number.isFinite(quotaLeft) || quotaLeft <= 0)) return false
    return true
  })
}

// FREE_MODEL_PATH is the one-time free-model campaign the vendor's web app
// offers on its activities page (packages/web index-*.js: ig calls
// GET /api/codar/activities/free-model and rg posts .../free-model/claim,
// both with target "speedai" — api.claw.speedai.com, not the account host).
// The claim takes no body; the app calls it only when the campaign says
// status "available" and names an activity_id.
export const FREE_MODEL_PATH = "/api/codar/activities/free-model"
export const FREE_MODEL_CLAIM_PATH = "/api/codar/activities/free-model/claim"

// freeModelOf reads that campaign's answer. available is the app's own
// condition, spelled the same way: status "available" and an activity_id.
// The claim window (free_until) is the activity's own end, which is what the
// card should say the claim runs to; it is 0 when the answer does not state
// one. The envelope is read first, as every other reader here reads it: an
// answer that says it failed (a business code that is not 200, success:false,
// or a code in words) is a refusal even when a stale data block beside it
// still says "available" — claiming on that would spend a write on a refusal.
export const freeModelOf = (body) => {
  // Every level of the wrapper chain is read for a refusal, not only the
  // envelope: a body that says success:false or names a business code a
  // `data` level in is the same refusal, and read as "available" it spent a
  // write on the claim below. The chain is walked as deep as unwrapped walks
  // it — the root and the eight `data` wrappers; a four-node walk stopped
  // short of a refusal and the claim was made anyway. `all` counts the day's
  // own `already_claimed` word
  // as a refusal too, as this reader always has: a campaign answer that says
  // already claimed is not a campaign to claim.
  if (refusalWithin(body, { all: true })) return null
  const data = unwrapped(body)
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  const status = typeof data.status === "string" ? data.status.trim().toLowerCase() : ""
  const id = data.activity_id
  const named = typeof id === "string" ? id.trim() !== "" : typeof id === "number" && Number.isFinite(id)
  const until = safeTime(secsOf(data.free_until) * 1000)
  return { available: status === "available" && named, until, activityId: named ? String(id).trim() : "" }
}

// claimFreeModel claims the campaign when there is one to claim, and answers
// what it claimed ({until, activityId}) or null. It is best-effort by design:
// the caller treats it as an extra, and any refusal (already claimed, no
// campaign, expired sign-in) leaves the caller's own answer untouched. Both
// calls read the vendor's business code: a 200 that says the GET failed must
// not lead to a claim, and a 200 that says the claim was refused must not be
// reported as one.
//
// opts.claimed is the caller's own record of campaigns it already wrote
// against. It is asked about the activity the vendor just named, not about
// the account: the vendor can open a second campaign later, and a guard that
// remembered "this account has been claimed once" would silently skip it.
export const claimFreeModel = async (token, opts = {}) => {
  const { claimed, ...rest } = opts
  const got = freeModelOf(await request(`${API}${FREE_MODEL_PATH}`, { method: "GET", token, ...rest, businessCodes: true }))
  if (!got?.available) return null
  if (typeof claimed === "function" && claimed(got.activityId)) return null
  const answer = await request(`${API}${FREE_MODEL_CLAIM_PATH}`, { method: "POST", token, ...rest, businessCodes: true })
  // The claim is a write, so its own answer has to say it landed: any node of
  // the wrapper chain carrying success:false, a business code that is not
  // 200, or a code in words is the vendor refusing it. Read as a claim, it
  // put "已领取免费模型" on the card for a campaign that was never opened
  // and recorded it as done, so no later check-in tried again — and a
  // refusal whose data still held the vendor's fields was read that way,
  // because unwrapped() walks past it.
  if (refusalWithin(answer, { all: true })) return null
  return { until: got.until, activityId: got.activityId }
}

// rateOf reads the credit multiple the vendor shows on a model (its own
// client displays it as written, "0.20x", by the model's name): the number
// the badge spells, as magpie's rate (host.js's rateOf takes "0.20x" too, but
// a number is what it documents, and 0 is "none" there). Only a finite,
// positive number is a rate; anything else says nothing.
export const RATE_BADGE = /^\s*[x×]?\s*([0-9]+(?:\.[0-9]+)?)\s*[x×]?\s*$/i
export const rateOf = (badge) => {
  const said = typeof badge === "number" ? String(badge) : String(badge ?? "")
  const m = RATE_BADGE.exec(said)
  const n = m ? Number(m[1]) : NaN
  return Number.isFinite(n) && n > 0 ? n : 0
}

// publishedConcurrency is the concurrency a vendor's catalog states, when it
// states one: a max_concurrency on the catalog or on any of its models, the
// smallest it names. 0 when it says nothing — which is every reading so far
// (measured 2026-10-27: no such field in /v1/codar/models, none in
// /api/pricing, and the 429's own body carries only retry-after).
//
// The walk goes over the vendor's whole list (catalogOf's MAX_MODELS cap is
// about the answer we hand the host, not this reading), so the minimum is
// folded as it comes instead of Math.min(...nums): a spread passes one
// argument per entry, and a catalog of ~125k entries throws "Maximum call
// stack size exceeded" inside the models hook — where the catch turns it into
// a fallback, so a perfectly good live list would be dropped for its size.
export const publishedConcurrency = (body) => {
  let min = 0
  const take = (v) => {
    // a number, or a string that says one (numOf): a boolean or an array is
    // not a count, and a vendor field of the wrong type would otherwise
    // silently pin the whole account to one request at a time.
    const n = numOf(v)
    if (Number.isInteger(n) && n > 0 && n <= 1000 && (min === 0 || n < min)) min = n
  }
  const list = body?.catalog?.data ?? body?.data
  take(body?.max_concurrency)
  take(body?.catalog?.max_concurrency)
  if (Array.isArray(list)) for (const m of list) take(m?.max_concurrency)
  return min
}

// signStateOf is the vendor's answer about whether today is claimed, as one
// of the four spellings its client reads (see signedIn), or null when the
// answer names none of them. The difference matters on the card: a body whose
// data is `{}` says nothing, and reading "not signed" out of it would offer a
// claim the account may not have. An object that names a state field with
// something other than a boolean still names one — read strictly, `"false"`
// is not true — so the row is drawn as "not claimed", as it always was.
export const signStateOf = (data) => {
  if (typeof data === "boolean") return data
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  // The first *boolean* of the four spellings decides, as the vendor's client
  // reads it (app.asar's um): a body naming two of them, one null or a string
  // and the other true, is "signed", and the old first-name-present rule said
  // the reverse. A name that is present but is no boolean still counts as the
  // state being named (drawn as "not claimed", never offered), and a body that
  // names none is no state at all.
  let named = false
  for (const name of ["isSigned", "signed", "hasSigned", "has_signed"]) {
    if (!Object.hasOwn(data, name)) continue
    named = true
    if (typeof data[name] === "boolean") return data[name]
  }
  return named ? false : null
}

// signedIn is whether the account has claimed today, read the way the
// vendor's own client reads it (app.asar's um): the answer's data is either
// the state itself (a boolean) or an object naming it, and the client accepts
// any of four spellings, each only as a real boolean. A string "false" is not
// one: Boolean("false") is true, and a card that claims the day when it is
// not costs the user a claim. Anything else is "not signed", as that client
// reads it — the card then offers the claim instead of hiding the row.
export const signedIn = (data) => signStateOf(data) === true

// cutFolded cuts a known key echoed with characters folded into it. A regex
// with an optional separator between every character would be a pattern as
// long as the key, and V8 refuses one past a few thousand characters with an
// error whose text quotes the pattern — the key — into a host log. So this
// walks the text instead: at each position where the key's first character
// stands, it follows the key on, skipping whichever separators the text
// happens to carry between them, and cuts a stretch only when the whole key
// was followed. Nothing is compiled per message, and the walk is bounded by
// the part that can still reach a card (plus the key's own length, for a
// credential straddling the cut), so an 8 MB answer costs one scan.
//
// FOLDED_RANGES is the one list both paths below use: whitespace (a token
// wrapped at a space or NBSP), the C0/C1 controls, soft hyphen, the invisible
// formatting characters and BOM. They were once two hand-written lists that
// disagreed on exactly the characters a folding server would pick.
const FOLDED_RANGES = [[0x00, 0x20], [0x7f, 0xa0], [0xad, 0xad], [0x1680, 0x1680], [0x2000, 0x200f], [0x2028, 0x202f], [0x205f, 0x2069], [0x3000, 0x3000], [0xfeff, 0xfeff], [0xfff9, 0xfffb]]
const codePoint = (n) => "\\u" + n.toString(16).padStart(4, "0")
// The per-character test is a Set, not a regex: the walk can ask it a million
// times on one hostile answer, and a regex test per character is ~10x slower.
const FOLDED_SKIP = (() => {
  const set = new Set()
  for (const [a, b] of FOLDED_RANGES) for (let c = a; c <= b; c++) set.add(String.fromCharCode(c))
  return set
})()
// INVISIBLE_ONE is the rest of the invisible characters a folding server can
// pick: any whitespace, every Unicode format character (zero-width marks, bidi
// controls, tag characters), combining marks (the combining grapheme joiner),
// and the fillers and braille blank that render as nothing. The Set above is
// the fast path for the common ones; this predicate keeps the walk from
// depending on that list being exhaustive — the shortest way to leak a token
// is to fold a character nobody enumerated between its characters.
const INVISIBLE_ONE = /[\s\p{Cf}\p{Mn}\p{Me}\p{Mc}\u115f\u1160\u3164\uffa0\u2800]/u
const INVISIBLE_ALL = /[\s\p{Cf}\p{Mn}\p{Me}\p{Mc}\u115f\u1160\u3164\uffa0\u2800]/gu
// INVISIBLE_BETWEEN is the separator set the shape pass normalizes: the
// fold points that matter are the ones *inside* a credential, between two
// characters of its alphabet. A blanket pass over every invisible character
// would also take the combining marks out of ordinary prose (Devanagari,
// Thai, a decomposed accent) and word-split the message. Plain space and tab
// are left out: the shape rules already match them as \s.
const INVISIBLE_BETWEEN = /(?<=[\w.-])[\p{Cf}\p{Mn}\p{Me}\p{Mc}\u115f\u1160\u3164\uffa0\u2800\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+(?=[\w.-])/gu
const foldedSkip = (c) => FOLDED_SKIP.has(c) || INVISIBLE_ONE.test(c)

// WINDOWS_OF is the width of the run `echoesKey` looks for. Six characters
// of base64url still cannot occur by chance in ordinary text (64^6, a model
// name is tens of characters), and the cost of a false hit is a blanked name,
// never a leak. Six, not eight: a gateway that splits the token into seven-
// character pieces leaves each piece holding a six-character run; the previous
// width missed every piece of a split at seven or fewer.
const WINDOWS_OF = 6
// windowsOf is every WINDOWS_OF-length run of the key's own alphabet, read
// after the fold: a key whose characters are interleaved with separators
// (a zero-width mark between every character, a space every few) still has
// these runs in its *flattened* form, and the text is flattened the same way
// before the lookup. With no fold at all this is the plain contiguous-window
// set.
export const windowsOf = (key, width = WINDOWS_OF) => {
  // The key is not flattened here: hasWindow flattens the text and looks for
  // these windows in it, so a window holding a separator the key carries
  // itself simply never matches — and a key a server folded has its real
  // characters on both sides after the text's own flatten. Flattening the key
  // too would cost a copy and change no answer.
  const raw = String(key ?? "")
  const set = new Set()
  for (let i = 0; i + width <= raw.length; i++) set.add(raw.slice(i, i + width))
  return set
}
// hasWindow asks the question in linear time over a text already allowed
// MAX_SCRUB_CHARS, so an 8 MB answer still costs one scan. The strict set
// (spread) holds the key's windows over [A-Za-z0-9_-] alone: a key split by
// one of its own alphabet characters (a dot after every character, every
// other character taken) leaves no run of the plain window set, and at a
// width of three or four those runs are what a hostile catalog would carry.
const strictOf = (key, width) => {
  const flat = flatten(key).replace(/[^A-Za-z0-9_-]/g, "")
  const set = new Set()
  for (let i = 0; i + width <= flat.length; i++) set.add(flat.slice(i, i + width))
  return set
}
// hasMark says a text holds one of the key's characters at all: a reading of
// the key holds them all, and an ordinary sentence of another subject usually
// holds none — one scan, where a flatten and two window walks would follow.
const hasMark = (text, chars) => {
  for (let i = 0; i < text.length; i++) if (chars.has(text[i])) return true
  return false
}
const hasRun = (flat, set) => {
  const width = set.size ? set.values().next().value.length : 0
  for (let i = 0; i + width <= flat.length; i++) if (set.has(flat.slice(i, i + width))) return true
  return false
}
const hasWindow = (said, windows, width = WINDOWS_OF) => {
  if (!windows.size) return false
  const text = String(said ?? "").slice(0, MAX_SCRUB_CHARS)
  if (text.length < width) return false
  const flat = flatten(text)
  for (let i = 0; i + width <= flat.length; i++) if (windows.has(flat.slice(i, i + width))) return true
  return false
}
// A key past this length is not walked character by character: the path is
// for a token a server wrapped, real tokens are ~130 characters, and for a
// longer one the same question is answered in one pass over the stripped copy.
const MAX_FOLD_KEY = 256
// walkIsRisky says whether the text has a long run of characters that the
// key's own body also has — the shape that makes the walk below restart at
// every position of the run.
const walkIsRisky = (scope, key) => {
  const body = new Set(key.slice(1))
  let run = 0
  for (let i = 0; i < scope.length && i < 4096; i++) {
    run = body.has(scope[i]) ? run + 1 : 0
    if (run >= 32) return true
  }
  return false
}
// strippedHas looks for the key in the whole text with every separator the
// fold can use taken out. It is the same question the walk answers, in
// linear time, and it is asked over the whole text rather than the walk's
// reach window: a key folded several separators per character reaches
// further than two characters per key character, and a key whose head sits
// just inside the card's cut would otherwise be found half-eaten.
// The global replacements below used to run over the whole vendor string:
// linear in theory, but seconds of V8 recursion on a multi-megabyte field.
// Only the prefix a card can show, plus the same folded-key margin cutFolded
// reads, can survive to a message — scrubLine and cleanText cap their output
// there. A key folded with more separators per character than that margin
// would not be cut out of the whole field either.
const strippedHas = (text, key) => {
  const reach = MAX_SCRUB_CHARS + key.length * 2
  const scope = text.length > reach ? text.slice(0, reach) : text
  return scope.replace(controlChars, "").replace(INVISIBLE_ALL, "").includes(key)
}
const cutFolded = (text, key) => {
  const first = key[0]
  if (!first || !text.includes(first)) return text
  // The scope reaches past the card's cut by the key's own (doubled) length:
  // a key that starts just inside MAX_SCRUB_CHARS and is folded one separator
  // per character used to be invisible to the walk and to the stripped check,
  // and the first half of it survived the slice that follows.
  const reach = MAX_SCRUB_CHARS + key.length * 2
  const scope = text.length > reach ? text.slice(0, reach) : text
  // Over the cap, or in a message that could make the walk quadratic (a run
  // of the key's own characters, checked with one pass over a short window),
  // the stripped copy answers the same question in linear time — and being
  // wrong here costs a message, never a leak.
  if (key.length > MAX_FOLD_KEY || walkIsRisky(scope, key)) return strippedHas(text, key) ? "…" : text
  let out = ""
  let at = 0
  for (let i = scope.indexOf(first); i !== -1; i = scope.indexOf(first, i + 1)) {
    let j = i + 1
    let p = 1
    while (p < key.length) {
      while (j < scope.length && foldedSkip(scope[j])) j++
      if (j >= scope.length || scope[j] !== key[p]) break
      j++
      p++
    }
    if (p === key.length) {
      out += scope.slice(at, i) + "…"
      at = j
      i = j - 1
      // resume at the first character after the cut that could start a key
      // again: inside an 8 MB run of the key's own characters ("aaaa…") the
      // walk would otherwise restart at every position of the run.
      while (i + 1 < scope.length && foldedSkip(scope[i + 1])) i++
      if (i + 1 < scope.length && scope[i + 1] === first) {
        if (key.length > 1) continue
        while (i + 1 < scope.length && scope[i + 1] === first) i++
      }
    }
  }
  if (at) return out + text.slice(at)
  // The walk found nothing, but the key's characters can still all be here
  // with a separator the walk does not know between them. One stripped copy
  // answers that in linear time; being wrong costs a message, never a leak.
  return strippedHas(text, key) ? "…" : text
}

// cutKey cuts a known key out of a string however the echo holds it together:
// as itself, with its controls stripped, or folded at ordinary whitespace or
// an invisible character. A server that wraps a key every 20 characters leaves
// no contiguous copy for `split(key)` to find, and the remainder is still most
// of a working credential. Shared with scripts/catalog.mjs, which writes the
// vendor's fields into a committed file — the same echo there would put the
// account's token into the repository.
// flatten is text with every separator a fold can use taken out, so a
// credential split across fields or wrapped at any column can be looked for
// in one flat string. Used by the catalog generator's last-gate leak check.
//
// Fullwidth forms come back to ASCII before anything else: every fullwidth
// letter and digit is its ASCII self plus the offset of U+FF01–FF5E, so a key
// spelled ｕｓｅｒ_1 is the key again once folded. And a JSON-escaped spelling
// (the literal text \\u0065\\u0079…, six characters per letter) is read as what
// a second JSON.parse would make of it — a gateway that escapes its answer
// twice (a proxy re-encoding a body it already encoded) leaves nothing the
// plain text shows.
const FULLWIDTH = /[\uff01-\uff5e]/g
const fullwidthASCII = (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)
const JSON_ESCAPE = /\\+u([0-9a-fA-F]{4})/g
const unescapeJSON = (t) => t.replace(JSON_ESCAPE, (m, hex) => {
  const n = parseInt(hex, 16)
  return n >= 0x20 && n <= 0x7e && n !== 0x5c && n !== 0x2f ? String.fromCharCode(n) : m
})
// flatten is a text as the token might be written in it: fullwidth letters
// folded to ASCII, and a JSON-escaped spelling (the literal text \\u0065…) read
// as a second JSON.parse would make of it. Control characters are spaces: a
// token wrapped at a newline or folded with a NUL is one line.
export const flatten = (text) => unescapeJSON(String(text))
  .replace(controlChars, " ")
  .replace(INVISIBLE_ALL, "")
  .replace(FULLWIDTH, fullwidthASCII)
// stripLog is a text cut to what can still be part of a credential: the key's
// own characters, the dot between a JWT's segments, and nothing else but a
// space where a control character was. Every check that looks for the key
// plain, or for it interleaved with separators of its own alphabet, reads the
// text through this one function.
const stripLog = (text) => flatten(text).replace(/[^A-Za-z0-9._-]/g, "")
// stripStrict is stripLog without the dot (and without a space).
const stripStrict = (text) => flatten(text).replace(/[^A-Za-z0-9_ -]/g, "")
// repairProjection puts a span the projection found back together: a character
// read as fullwidth or as a JSON escape is written as the character it stands
// for, a control character as a space.
const repairProjection = (s) => unescapeJSON(String(s).replace(controlChars, " ")).replace(FULLWIDTH, fullwidthASCII)

// An edit-application through the projection, used by the cutters so their
// answer holds what they found: the log form of a text, the input span, and
// the function that puts back the input's spelling of a span the log found.
// The log is from the input's start to its first character that is neither
// kept nor a skip; one item per logged character, { i, e }, where e is the
// last input character of the unit (a surrogate pair is two units, one item).

export const cutKey = (text, key) => {
  let out = typeof text === "string" ? text : ""
  const k = String(key ?? "")
  if (!k) return out
  // includes() is a plain scan; split/join allocates a copy of the whole
  // string (and an array of parts) even when there is nothing to cut. A
  // vendor message is usually a few KB, but one 8 MB answer would pay that
  // allocation twice for a key it never echoed.
  if (out.includes(k)) out = out.split(k).join("…")
  const kn = k.replace(controlChars, "")
  if (kn && out.includes(kn)) out = out.split(kn).join("…")
  // The server may have folded a character *inside* the key while the key
  // itself is clean: cut with a walk that allows the same separators between
  // its characters. Ordinary whitespace counts — a token wrapped at a space is
  // the most common folding there is — so the trigger is the key's own head and
  // tail still being in the message, not merely a control character being
  // present.
  if (kn) out = cutFolded(out, kn)
  // And a split the walk cannot follow at all: pieces joined by punctuation
  // (", " between eight-character chunks) leave the key's characters in order
  // with separators the fold does not know between them. Project the text onto
  // the key's own alphabet and cut the span a match there came from.
  if (kn) out = cutProjected(out, kn)
  // The key with a separator from its own alphabet between every character
  // (a dot after each, every other character taken): the projection above
  // keeps those separators and folds the key, so the other projection —
  // which drops them — is what puts the key back together.
  if (kn) out = cutSpread(out, kn)
  // …and the same spelling with an underscore or a hyphen between the key's
  // characters: both are inside the strict alphabet, so the projection above
  // keeps them. Letters and digits alone drop them.
  if (kn) out = cutSpreadAlnum(out, kn)
  // The key in an encoded form: base64 or hex, whole or in pieces joined
  // with a label or a fence character. The plain checks above see none of it.
  out = cutEncoded(out, kn)
  // …and the key's own characters split across runs by an alphabet character
  // the plain cutters fold away (a run of pieces joined with "|", kept apart
  // by a decoder): the pieces in order are the key. A cut only counts when
  // the connected match holds most of the key, so prose is not cut for a few
  // letters that happen to line up.
  if (kn) out = cutRunOf(out, kn)
  return out
}
// ALNUM_SPLIT is every run of the key's own characters in a text, as the
// (index, text) pairs that are they: a run may end at a space.
const ALNUM_SPLIT = /[A-Za-z0-9_-]+/g
const cutRunOf = (text, key) => {
  const kn = stripStrict(key).replace(/ /g, "")
  if (!kn || kn.length < SPREAD_OF) return text
  const need = Math.min(kn.length, Math.max(SPREAD_OF, Math.floor((kn.length * 2) / 3)))
  const runText = text.length > PROJECT_REACH ? text.slice(0, PROJECT_REACH) : text.replace(SPACE_FOLD, " ")
  const runs = new Map()
  const all = []
  let off = 0
  for (const m of runText.matchAll(ALNUM_SPLIT)) {
    all.push([m.index, m[0]])
    runs.set(m.index, m[0])
  }
  void off
  if (all.length > 4096) return text
  // greedily connect runs: from a run's start, take the next run while its
  // first characters continue the key from where the connected text stands
  let out = ""
  let at = 0
  for (let i = 0; i < all.length; i++) {
    const [start] = all[i]
    let joined = all[i][1]
    let p = 0
    while (p < kn.length) {
      const piece = all[i][1].slice(p)
      if (kn.slice(p, p + piece.length) !== piece) break
      p += piece.length
      if (p >= kn.length) break
      let next = null
      for (let j = i + 1; j < all.length && j <= i + 64; j++) {
        const gap = all[j][0] - (all[j - 1][0] + all[j - 1][1].length)
        if (gap > 64) break
        const rest = kn.slice(p)
        if (rest.startsWith(all[j][1])) { next = j; break }
        if (all[j][1].startsWith(rest)) { next = j; break }
        // a run that continues the key partway: take what it offers
        let take = 0
        while (take < all[j][1].length && take < rest.length && all[j][1][take] === rest[take]) take++
        if (take >= 3) { next = j; break }
      }
      if (next === null) {
        // nothing continues it here; a run may also hold more than the key
        // part promises only at its start — stop.
        break
      }
      const rest = kn.slice(p)
      joined += all[next][1]
      if (all[next][1].startsWith(rest)) { p = kn.length; i = next; break }
      let take = 0
      while (take < all[next][1].length && take < rest.length && all[next][1][take] === rest[take]) take++
      if (!rest.startsWith(all[next][1])) p += take
      i = next
    }
    if (p >= need) {
      const last = all[i]
      out += text.slice(at, start) + "…"
      at = last[0] + last[1].length
      joined = ""
    }
  }
  return out ? out + text.slice(at) : text
}

// project maps a text onto a credential's alphabet and keeps each kept
// character's offset: `keep` tags a character the log takes as it is, `skip` a
// character that is dropped as a separator, and a fullwidth letter or a
// literal JSON escape is read as the character it stands for. A tab, a newline
// and a NUL are spaces (a token wrapped at one), like every other separator.
// The bound matches what can still reach a card or a committed line:
// scrubShapes slices to MAX_SCRUB_CHARS after the cut, and a cut only shifts
// content left, so a match past the doubled cap could never reach an output.
const PROJECT_REACH = MAX_SCRUB_CHARS * 2
const KEEP_LOG = /[A-Za-z0-9._-]/
const KEEP_STRICT = /[A-Za-z0-9_-]/
const SPACE_FOLD = /[\t\n\u000b\u000c\r]/g
const project = (text, strict = false) => {
  // (the slice first, then the fold, then the bound again: folding can shrink
  // a text but never grow one, and the slice keeps an 8 MB copy off the heap)
  const head = text.length > PROJECT_REACH * 2 ? text.slice(0, PROJECT_REACH * 2) : text
  const whole = head.replace(SPACE_FOLD, " ")
  const str = whole.length > PROJECT_REACH ? whole.slice(0, PROJECT_REACH) : whole
  const keep = strict === true ? KEEP_STRICT : strict instanceof RegExp ? strict : KEEP_LOG
  let flat = ""
  const at = []
  const end = []
  for (let i = 0; i < str.length; i++) {
    let unit = str[i]
    let j = i
    if (unit === "\\") {
      // a literal JSON escape the way flatten reads one (an ASCII \ in \\uXXXX)
      const m = /^\\+u([0-9a-fA-F]{4})/.exec(str.slice(i))
      if (m) {
        const n = parseInt(m[1], 16)
        if (n >= 0x20 && n <= 0x7e && n !== 0x5c && n !== 0x2f) {
          unit = String.fromCharCode(n)
          j = i + m[0].length - 1
        }
      }
    }
    if (j === i) {
      const cw = unit.charCodeAt(0)
      if (unit.length === 1 && cw >= 0xff01 && cw <= 0xff5e) unit = String.fromCharCode(cw - 0xfee0)
      else if (cw >= 0xd800 && cw <= 0xdbff && i + 1 < str.length) j = i + 1
    }
    if (keep.test(unit)) {
      flat += unit
      at.push(i)
      end.push(j)
    }
    i = j
  }
  return { flat, at, end }
}

// cutProjected cuts a key that is only contiguous once the text is projected:
// the message "…, eyJhbGci, OiJIUzI1…" holds the key's characters in order with
// commas between the pieces. The span cut in the original runs from the match's
// first kept character to its last, so the separators between the pieces go
// with them. A key shorter than a window is not worth cutting: no single piece
// of it is identifiable as credential material.
const cutProjected = (text, key) => {
  const flatKey = stripLog(key)
  if (!flatKey || flatKey.length < WINDOWS_OF) return text
  const { flat, at, end } = project(text)
  let out = ""
  let cut = 0
  let from = 0
  for (let hit = flat.indexOf(flatKey); hit !== -1; hit = flat.indexOf(flatKey, from)) {
    out += text.slice(cut, at[hit]) + "…"
    cut = end[hit + flatKey.length - 1] + 1
    from = hit + flatKey.length
  }
  return out ? out + text.slice(cut) : text
}
// cutSpread is cutProjected over the strict alphabet: the same span cut, for
// a key whose own characters were split by a dot or another alphabet
// character.
// SPREAD_OF is where a *partial* spread match starts to count: a match of
// fewer than SPREAD_OF key characters — dropping every dot from ordinary prose
// ("…tool v1.2…") leaves short runs of the key by chance, and cutting at 6 of
// 138 would blank half a sentence for nothing. A key shorter than this is
// still read (a password is eight characters, an SMS code six), but only a
// match of the whole key counts: "h.u.n.t.e.r.4.2" projects to exactly the
// password, while prose with dots does not spell it.
const SPREAD_OF = 12
const SPREAD_MIN = 6
// spreadOver is the cut both spreads make: a key read on a projected text.
const spreadOver = (text, flatKey, keep) => {
  if (!flatKey || flatKey.length < SPREAD_MIN) return text
  const need = Math.min(flatKey.length, Math.max(SPREAD_OF, Math.floor((flatKey.length * 2) / 3)))
  const { flat, at, end } = project(text, keep)
  let out = ""
  let cut = 0
  let from = 0
  for (let hit = flat.indexOf(flatKey); hit !== -1; hit = flat.indexOf(flatKey, from)) {
    if (hit + need <= flat.length) {
      out += text.slice(cut, at[hit]) + "…"
      cut = end[hit + flatKey.length - 1] + 1
    }
    from = hit + flatKey.length
  }
  return out ? out + text.slice(cut) : text
}
const cutSpread = (text, key) => spreadOver(text, stripStrict(key).replace(/ /g, ""), KEEP_STRICT)
// ALNUM_ONLY is the strict alphabet less its own punctuation: a key spelled
// "h_u_n_t_e_r_4_2" keeps its underscores in the projection above, so that
// projection cannot put the key back together. Letters and digits alone drop
// them from the text and the key alike; a key that legitimately holds one of
// them still matches, because both sides lose it.
const ALNUM_ONLY = /[A-Za-z0-9]/
const cutSpreadAlnum = (text, key) => spreadOver(text, stripStrict(key).replace(/[^A-Za-z0-9]/g, ""), ALNUM_ONLY)
// credentialSpan is a JWT seen only after the projection, for the paths that
// have no key to cut by (getAuth threw; --check prints an older token's
// record): find it in the projected text and say where it sits in the original,
// so the surrounding prose survives the cut.
const FLAT_JWT = /eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})(?:\.[A-Za-z0-9_-]{2,})?(?![A-Za-z0-9_-])/
const credentialSpan = (text) => {
  const { flat, at, end } = project(text)
  const m = FLAT_JWT.exec(flat)
  return m ? [at[m.index], end[m.index + m[0].length - 1] + 1] : null
}
// ENCODED_RUN is a run that may be carrying the key in an encoded form: 16
// base64 characters (12 bytes) or 32 hex characters (16 bytes) are long
// enough for a credential. The runs are read from the whole text, up to
// BASE64_CAP rather than one string tested against /^[A-Za-z0-9+/_-]+$/ —
// a value that mixes base64 with anything else (a "b64:" label, a fence
// character, a line break every 20 characters) is still a base64 payload.
// Base64 is decoded at three alignment offsets, so a run that starts a
// character or two off the encoder's boundary still yields the key; the hex
// spelling is read when no base64 reading carries it.
const BASE64_CAP = 64 * 1024
// ALNUM_RUN is a run of letters and digits: the carrier of an encoded key,
// in whatever shape the gateway wrote it (a label, a fence, a line break
// between the pieces of one encoding — the run is taken across those).
const ALNUM_RUN = /[A-Za-z0-9+/_-]{12,}/g
// BASE64_PHASE is the alphabet of one base64 phase: every third character of
// an encoding is one of sixteen values, and a separator or a label lands in a
// different phase. That is how one encoding cut with separators of its own is
// found without decoding at every offset (which was O(n²) on a long run).
const PHASE64 = new Map([
  [0, "AEIMQUYcgkosw048"],
  [1, "BFJNRVZdhlptx159"],
  [2, "CGKOSWaeimquy26-"],
])
const base64Phase = (run) => {
  // a run of sixteen any character in one phase: a long encoding that has a
  // label every few characters leaves such runs whatever the offset.
  for (const [phase, alphabet] of PHASE64) {
    let count = 0
    for (let i = phase; i < run.length; i += 3) if (alphabet.includes(run[i])) count++
    if (count >= 16) return true
  }
  return false
}
const HEX_PHASE = /^[0-9a-fA-F]+$/
const decodeHits = (latin, windows, strict) => {
  const flat = flatten(latin)
  return hasWindow(flat, windows) || hasRun(flat.replace(/[^A-Za-z0-9_-]/g, ""), strict)
}
// decodeCarries says a run, decoded as base64 (three alignments) or as hex,
// carries the key; the decoded text is looked for it in its flattened form on
// the two alphabets alike (a decoded copy carries the key with nothing folded
// into it — the plain reading keeps the dots between a JWT's segments).
const decodeCarries = (run, windows, strict) => {
  const body = run.replace(/-/g, "+").replace(/_/g, "/").replace(/\/+$/, "").replace(/=+$/, "")
  for (let o = 0; o < 3 && o < body.length; o++) {
    const part = body.slice(o, o + ((body.length - o) >> 2) * 4)
    if (decodeHits(Buffer.from(part, "base64").toString("latin1"), windows, strict)) return true
  }
  const hex = run.replace(/[^0-9a-fA-F]/g, "")
  if (hex.length % 2 === 0 && hex.length >= 32 && HEX_PHASE.test(hex)) {
    const latin = Buffer.from(hex, "hex").toString("latin1")
    if (hasWindow(flatten(latin), windows) || hasRun(flatten(latin).replace(/[^A-Za-z0-9_-]/g, ""), strict)) return true
  }
  return false
}
// KEY_HEAD matches the opening of the key as a hex or a percent-encoded
// text writes it ("6579…", "%65%79…"): a text holding neither is not an
// encoding of this key. Set from the key on first use.
let KEY_HEAD = null
const keyHeadOf = ({ head }) => {
  if (!head) return null
  const bytes = Buffer.from(head, "latin1").toString("hex").slice(0, 4)
  const pct = [...Buffer.from(head, "latin1")].map((n) => `%${n.toString(16).padStart(2, "0")}`).join("")
  return new RegExp(`${bytes}|${pct}`, "i")
}
const base32Decode = (text) => {
  const A = "abcdefghijklmnopqrstuvwxyz234567"
  let bits = 0
  let acc = 0
  let out = ""
  for (const ch of text.toLowerCase().replace(/=+$/, "")) {
    const v = A.indexOf(ch)
    if (v < 0) return null
    acc = ((acc << 5) | v) & 0xffff
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out += String.fromCharCode((acc >> bits) & 255)
    }
  }
  return out
}
// base32Encode is base32Decode's inverse: an encoded token split into pieces
// carries no run of the token itself, but it is the encoding's pieces, and
// that text can be followed through the fields as splitHits follows the
// token's (a piece split between two fields still lines up as one chunk).
const base32Encode = (text) => {
  const A = "abcdefghijklmnopqrstuvwxyz234567"
  let bits = 0
  let acc = 0
  let out = ""
  for (const ch of String(text)) {
    acc = ((acc << 8) | ch.charCodeAt(0)) & 0xffff
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += A[(acc >> bits) & 31]
    }
  }
  if (bits) out += A[(acc << (5 - bits)) & 31]
  return out
}
// percentEncode is a byte-per-byte %XX copy: the spelling a gateway writes
// instead of the token's characters, and the one splitIn can follow piece by
// piece the way it follows the token itself.
const percentEncode = (text) => [...Buffer.from(String(text), "latin1")].map((n) => `%${n.toString(16).padStart(2, "0")}`).join("")
export const base32Of = base32Encode
export const percentOf = percentEncode
// percentDecode reads every %XX as its byte; a text without one reads as
// itself. A raw byte outside UTF-8 reads as a space, as a fold would.
const percentDecode = (text) =>
  text.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => Buffer.from(run.slice(1).split("%").join(""), "hex").toString("utf8").replace(/\ufffd/g, " "))
// unbase64 decodes a base64url or base64 text at three alignments, latin1:
// the token's characters are ASCII, and a decoded byte outside it is a
// character no window holds.
const unbase64 = (text) => {
  const body = String(text).trim().replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "")
  if (!/^[A-Za-z0-9+/]+$/.test(body) || body.length < 16) return []
  const out = []
  for (let o = 0; o < 3; o++) out.push(Buffer.from(body.slice(o, o + ((body.length - o) >> 2) * 4), "base64").toString("latin1"))
  return out
}
const unhex = (text) => {
  const hex = String(text).replace(/[^0-9a-fA-F]/g, "")
  return hex.length >= 32 && hex.length % 2 === 0 && HEX_PHASE.test(hex) ? Buffer.from(hex, "hex").toString("latin1") : null
}
// decodeAll says how much of a text is a spelling of the key: the text as it
// stands, and its base64, hex (a text of letters and digits only), base32 (a
// text of its alphabet only), percent-decoded and JSON-unescaped readings,
// each looked for with the key's windows. The length of the source is the
// answer when any reading carries the key — the caller cuts that much — and 0
// when none does. Cheap: a reading is tried only when the text wears that
// reading's marks.
const decodeAll = (text, readings, { hex = true, plain = true } = {}) => {
  const said = String(text ?? "")
  if (!said) return 0
  const forms = []
  const alpha = /^[A-Za-z0-9+/=_-]+$/
  if (alpha.test(said)) {
    forms.push(...unbase64(said))
    if (hex) {
      const h = unhex(said)
      if (h) forms.push(h)
    }
    if (/^[a-z2-7=]+$/i.test(said)) {
      const d = base32Decode(said)
      if (d) forms.push(d)
    }
  }
  if (/%[0-9a-fA-F]{2}/.test(said)) {
    const d = percentDecode(said)
    forms.push(d)
    if (alpha.test(d)) forms.push(...unbase64(d))
  }
  if (/\\+u[0-9a-fA-F]{4}/.test(said)) forms.push(unescapeJSON(said))
  // The text as it stands is evidence only where the caller does not already
  // ask the plain question itself (echoesKey): a run of the key's own
  // characters is a fragment, not an encoding of one.
  if (plain) forms.push(said)
  // a text holding none of the key's letters is no reading of it: a megabyte
  // of prose costs one scan for a character, not a flatten and two windows.
  const { chars } = readings
  for (const form of forms) {
    if (!form || !hasMark(form, chars)) continue
    if (decodeHits(form, readings.windows, readings.strict)) return said.length
    const flat = flatten(form).replace(/[^A-Za-z0-9._-]/g, "")
    if (flat.length > form.length && hasMark(flat, chars) && decodeHits(flat, readings.windows, readings.strict)) return said.length
  }
  return 0
}
const decodeOne = (run, readings) => {
  if (decodeAll(run, readings, { plain: false }) > 0) return true
  const { windows, strict, head, hexHead } = readings
  if (!head && !hexHead) return false
  const looks = (head && run.includes(head)) || (hexHead && /^[0-9a-fA-F]+$/.test(run) && run.includes(hexHead))
  if (!looks) return false
  if (decodeCarries(run, windows, strict)) return true
  for (let i = 1; i <= 6 && i + 12 < run.length; i++) {
    const part = run.slice(i)
    if (part.includes(head) || (hexHead && /^[0-9a-fA-F]+$/.test(part) && part.includes(hexHead))) {
      if (decodeCarries(part, windows, strict)) return true
    }
  }
  return false
}
// ENCODED_SEGMENT is a run of the base64url and base64 alphabets joined
// across separators, as long as a folded encoding can be: the generator reads
// a committed file that way. It needs two runs, so an ordinary sentence of
// words (one run, cut at its first space) is not reassembled.
// (a segment starts at a run's beginning or right after a separator, never
// inside one: a match attempt at every offset of a long run is what made
// this the slowest line in the pass)
const ENCODED_SEGMENT = {
  base64url: /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{1,80}(?:[\s]{1,4}[A-Za-z0-9_-]{1,80}){1,60}/g,
  base64: /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{1,80}(?:[\s]{1,4}[A-Za-z0-9+/]{1,80}){1,60}/g,
}
// UNETCHED says a joined run was no more than its runs: nothing to decode
// that a run on its own did not already offer.
const unetched = (joined) => !/[\s]/.test(joined)
// encodedHits says a text carries the key in an encoded form, whole or in
// pieces with a label between them: every run is tried as it stands, one to
// six characters in (a label in front), by phase, and past a digest pasted in
// front of it. A run folded with spaces (an encoding written twenty
// characters to a line) is decoded with the spaces taken out.
const decodedRuns = (text, readings) => {
  const { windows, strict, kn } = readings
  const scope = String(text ?? "").slice(0, BASE64_CAP)
  const hashes = new Set()
  const tried = (run) => decodeOne(run, readings)
  for (const m of scope.matchAll(ALNUM_RUN)) {
    const run = m[0]
    if (tried(run)) return true
    // (the hex reading of a phase-tagged run is the hex one: hex has 16
    // characters evenly spread, no phase)
    if (run.length > 2 * kn.length) hashes.add(run)
  }
  if (hashes.size) {
    const seen = new Set()
    for (const run of hashes)
      for (let o = kn.length; o + kn.length <= Math.min(run.length, BASE64_CAP); o++) {
        const key = run.slice(o, o + kn.length * 2)
        if (seen.has(key)) continue
        seen.add(key)
        if (decodeCarries(key, windows, strict)) return true
      }
  }
  // A run with the key's dots put back is still a whole run: the key's
  // segments are base64url, and a fold of the whole token has dots of its own.
  const dotted = scope.replace(/(?<=[A-Za-z0-9_-])[.]\s*(?=[A-Za-z0-9_-])/g, ".")
  if (dotted !== scope) for (const m of dotted.matchAll(ALNUM_RUN)) if (tried(m[0])) return true
  for (const re of Object.values(ENCODED_SEGMENT)) {
    for (const m of scope.matchAll(re)) {
      const joined = m[0].replace(/\s+/g, "")
      if (unetched(m[0]) || joined.length < 12) continue
      if (tried(joined)) return true
    }
  }
  // …and the spellings that are not base64 or hex at all: percent-encoded
  // bytes, base32, a JSON-escaped text. Read over the scope with its
  // separators taken out (a fold breaks a percent triplet too), then as it
  // stands.
  const squashed = scope.replace(/[\s\u0000-\u001f]+/g, "")
  const flat = squashed.replace(/[^%A-Za-z0-9+/=_-]/g, "")
  if (decodeAll(flat, readings, { plain: false, hex: false }) > 0 || decodeAll(squashed, readings, { plain: false, hex: false }) > 0) return true
  return false
}
const encodedHits = (text, readings) => decodedRuns(text, readings)
// encodedRun reports a run of letters and digits that decodes to the key: the
// generator's joined runs (pieces carried between labels) are not base64 as
// they stand, but they are once the labels go.
// spelledCarriesKey reports text that carries the key in a spelling the
// window scan cannot see — percent-encoded bytes, base32, base64, hex, a JSON
// escape — and not the text holding the key's characters as they are (that is
// echoesKey's question, and a fragment of the key is not a spelling of it).
export const spelledCarriesKey = (said, key) => {
  const readings = keyReadings(key)
  if (!readings.kn) return false
  const text = String(said ?? "").slice(0, BASE64_CAP)
  return decodeAll(text, readings, { plain: false }) > 0 || decodedRuns(text, readings)
}
export const encodedRun = (run, key) => {
  const readings = keyReadings(key)
  return Boolean(readings.kn) && decodedRuns(String(run ?? "").replace(/[^\sA-Za-z0-9+/_-]/g, ""), readings)
}
// keyReadings is computed once per key: the same token is read against every
// name in a list, and the window sets cost as much as the scans did.
let readingsOf = { key: null, at: 0, value: null }
const keyReadings = (key) => {
  const said = String(key ?? "")
  const now = Date.now()
  if (readingsOf.key === said && now - readingsOf.at < 1000) return readingsOf.value
  const kn = flatten(said)
  const head = kn.slice(0, 3)
  const value = {
    kn,
    windows: windowsOf(kn),
    strict: strictOf(kn, WINDOWS_OF),
    // the encoding of the key's first three bytes: any encoding of the whole
    // key carries it, and a string that carries neither is not one
    head: head ? Buffer.from(head, "latin1").toString("base64").slice(0, 4) : "",
    hexHead: head ? Buffer.from(head, "latin1").toString("hex") : "",
    flatWindows: windowsFlat(kn.replace(/ /g, "")),
    // the characters the key is made of: a decoded form holding none of them
    // is no reading of this key (decodeAll's first, cheapest question).
    chars: new Set(kn.replace(/ /g, "")),

  }
  KEY_HEAD = keyHeadOf(value)
  readingsOf = { key: said, at: now, value }
  return value
}
// decodedCarriesKey reports text whose base64 or hex decoding carries the key:
// a gateway can encode the token before echoing it, and neither the fold walk
// nor the shape pass can see the credential inside the encoded form.
export const decodedCarriesKey = (said, key) => {
  const readings = keyReadings(key)
  return Boolean(readings.kn) && encodedHits(said, readings)
}
// encodedCarries is the encoded-form question over a string short enough to
// be a vendor field: at most 2,000 characters are read. A model name, an id
// and a card message are far shorter; an 8 KB blob costs a decode per run,
// and the paths that judge a whole answer (the generator, --check) use
// hexCarriesKey and decodedCarriesKey on the reassembled text instead.
const ENCODED_FIELD = 2000
const encodedCarries = (said, key) => {
  const text = String(said ?? "")
  if (text.length > ENCODED_FIELD) return false
  return encodedHits(text, keyReadings(key))
}
// hexCarriesKey reports text that carries the key spelled in hexadecimal: a
// gateway can spell the token in hex (its base64 is not, as a whole, a valid
// JWT, so the shape rules see nothing). The decoded run is taken with its
// separators dropped, so a fold or a label does not hide it.
export const hexCarriesKey = (said, key) => {
  const readings = keyReadings(key)
  const { kn, windows, strict } = readings
  if (!kn) return false
  const text = String(said ?? "").slice(0, BASE64_CAP)
  if (encodedHits(text, readings)) return true
  const hex = text.replace(/[^0-9a-fA-F]/g, "")
  if (hex.length < 32 || hex.length % 2) return false
  const latin = Buffer.from(hex, "hex").toString("latin1")
  return hasWindow(flatten(latin), windows) || hasRun(flatten(latin).replace(/[^A-Za-z0-9_-]/g, ""), strict)
}
// cutEncoded is decodedCarriesKey's cut: each run whose decoding carries the
// key becomes "…", the prose around it kept. A run is a candidate by its
// shape first (base64 has a sixteen-character run in one of three phases; hex
// has one long enough to hold the key doubled), so an ordinary sentence is
// not decoded.
const cutEncoded = (text, key, cap = MAX_SCRUB_CHARS) => {
  const readings = keyReadings(key)
  const { kn, windows, strict } = readings
  if (!kn || typeof text !== "string") return text
  const scope = text.length > cap ? text.slice(0, cap + 1) : text
  const spans = []
  const holds = (a, b) => spans.some(([x, y]) => a < y && x < b)
  for (const m of scope.matchAll(ALNUM_RUN)) {
    const run = m[0]
    const candidate = base64Phase(run) || (HEX_PHASE.test(run) && run.length >= 2 * kn.length)
    if (!candidate || !decodeCarries(run, windows, strict)) continue
    spans.push([m.index, m.index + run.length])
  }
  // a folded or labelled encoding: the runs with the separators between them
  // taken out are the encoding, and the whole span goes.
  for (const re of Object.values(ENCODED_SEGMENT)) {
    for (const m of scope.matchAll(re)) {
      const a = m.index
      const b = a + m[0].length
      if (holds(a, b)) continue
      const joined = m[0].replace(/\s+/g, "")
      if (unetched(m[0]) || joined.length < 12) continue
      if (decodeOne(joined, readings)) spans.push([a, b])
    }
  }
  // a percent-encoded or base32 copy with its separators between: the runs
  // of the spellings that are not base64 or hex, with the separators taken
  // out, are the encoding, and the span from its first to its last run goes
  // whole.
  const pieces = []
  for (const m of scope.matchAll(/%(?:[0-9a-fA-F]{2})|[A-Za-z2-7]{16,}/g)) pieces.push([m.index, m.index + m[0].length])
  const merged = []
  for (const [a, b] of pieces) {
    const last = merged[merged.length - 1]
    if (last && a - last[1] <= LABEL_CHARS) last[1] = b
    else merged.push([a, b])
  }
  for (const [a, b0] of merged) {
    // the tail a writer left literal (a percent copy's last characters are
    // often written as themselves) belongs to the same span
    let b = b0
    while (b < scope.length && /[A-Za-z0-9%]/.test(scope[b])) b++
    if (holds(a, b) || b - a < 12) continue
    if (decodeAll(scope.slice(a, b).replace(/[\s\u0000-\u001f]+/g, ""), readings, { plain: false, hex: false }) > 0) spans.push([a, b])
  }
  if (!spans.length) return text
  spans.sort((x, y) => x[0] - y[0])
  let out = ""
  let at = 0
  for (const [a, b] of spans) {
    if (a < at) continue
    out += scope.slice(at, a) + "…"
    at = b
  }
  return out + text.slice(at)
}

// scrubLine is said as one line with no credential in it: the key itself
// where it is known, then anything credential-shaped where it is not (a
// getAuth that threw leaves no key to cut by). A token a server spliced a
// space or newline into is still cut — jwtShape lets whitespace fall anywhere
// inside a segment, and every Codar token is a JWT. Only the first
// MAX_SCRUB_CHARS characters are cleaned (see the constant); nothing past
// them could reach a card or a log line, and cleaning them would cost
// seconds on a multi-megabyte sentence. The key is cut over the whole string
// first, so a token the vendor split around the boundary is still removed
// where its parts are.
export const scrubLine = (said, key) => scrubShapes(said, key)
  .replace(/\s{2,}/g, " ")
  .trim()

// scrubShapes is the shape rules alone (see scrubLine): a credential quoted
// back is cut, but the surrounding layout — runs of spaces, a line's leading
// detail — is left as written. Used where the reader compares or aligns the
// line (catalog.mjs's --check prints the old record), not where a card shows
// it. Folding runs of spaces (scrubLine) is what puts a whitespace-split
// token back together for the shape rules; a caller that has already turned
// the separators into spaces does not need it, and one that keeps the layout
// cannot have it.
// skModelish says an sk-/pk-/rk- run reads as a model's name and not a
// secret: lower-case words joined by hyphens ("sk-whisper-large-v3",
// "sk-swedish-translation-8b"), while a key's body is a random run — mixed
// case, or no hyphenation at all ("sk-proj-Ab3…", "sk-live-0123…",
// "sk-abcdefghijklmnopqrstuvwx").
const skModelish = (run) =>
  /^(?:sk|pk|rk)-(?:[a-z0-9]+-)+[a-z0-9]+$/.test(run) && run.split("-").every((part) => part.length <= 12)
// wordish says a run reads as words, the way a model identifier does: three
// or more words of letters on average a few letters long, however the vendor
// joins them (camelCase, hyphens, digits between). A secret's run does not
// spell words — cobbling "Qz7vc4ndj2m8p1r6s9t3u5w0xe" out of stray letter
// pairs is not one.
const wordish = (run) => {
  const said = String(run)
  if (/[_]/.test(said) || /^[A-Z0-9]+$/.test(said)) return false
  // hyphenated words: "claude-sonnet-4-5-20250929" is three or more segments
  if (/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+){2,}$/.test(said) && said.split("-").filter((x) => /[A-Za-z]/.test(x)).length >= 2) return true
  // camelCase words: three or more, a few letters each
  const words = said.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) ?? []
  if (words.length < 3) return false
  const letters = words.reduce((n, w) => n + w.length, 0)
  return letters / words.length >= 3
}
export const scrubShapes = (said, key) => {
  const raw = typeof said === "string" ? said : ""
  // A JWT whose characters are interleaved with separators (one zero-width
  // mark between every character, a space or a comma every few) defeats both
  // cutKey's walk (separators it does not enumerate) and the shape pass (which
  // reads the literal text). When the key is known, cutKey's projection cuts
  // it; when it is not — getAuth threw, --check prints another token's old
  // record — project the text and cut the span the JWT sits in, so the prose
  // around it survives.
  const span = key ? null : credentialSpan(raw)
  // An encoded spelling the key's own characters do not show: a base64 (or
  // hex) copy of the token, whole or folded over lines. It is not a JWT in
  // the text, so the shapes below cannot see it; the decoded text is the
  // key. Same on the keyless path, where the shape of the encoding is the
  // only evidence (a JWT's own base64 always starts "ZXlJ").
  // (the encoded stage reads at most SCRUB_REACH characters, as the shape
  // rules below do: nothing past them can reach the card this line is cut
  // for, and an 8 MB word is not measured twice for it)
  const reach = raw.length > MAX_SCRUB_CHARS ? raw.slice(0, MAX_SCRUB_CHARS + 1) : raw
  // (cutKey reads the key's encoded forms itself; this stage is for the
  // keyless path, where there is no key to cut by)
  const encodedText = key ? raw : cutEncoded(reach, KNOWN_JWT)
  const source = encodedText !== raw ? encodedText : raw
  const text = span ? source.slice(0, span[0]) + "…" + source.slice(span[1]) : cutKey(source, key)
  return text.slice(0, MAX_SCRUB_CHARS)
    .replace(controlChars, " ")
    // Every invisible separator becomes a space before the shape pass: the
    // shapes allow \s between segments, and a server can fold with a
    // character \s does not match (U+180E, a combining enclosing mark
    // such as U+20DD) — the token would then pass through whole. Folding runs
    // of spaces at the end puts the pieces back together.
    .replace(INVISIBLE_BETWEEN, " ")
    .replace(jwtShape, "…")
    // A JWT spelled with a separator *inside* its alphabet — a dot after
    // every character, every other character taken — is one contiguous run
    // of [A-Za-z0-9_-] once the dots go, and the shape rules above see
    // neither. Cut that span whole; a prose sentence loses its dots and is
    // measured. Groups of one or two characters both count: "ey.Jh.bG…" is
    // the same spelling as "e.y.J.h…", and one-character groups alone left
    // the wider form readable. Sixteen groups is far past any sentence, a
    // version list or an abbreviation this pass meets.
    .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{1,2}(?:[.]{1,2}[A-Za-z0-9_-]{1,2}){15,}(?![A-Za-z0-9_-])/g, "…")
    // The same JWT in fullwidth letters: nothing in it is ASCII, so the
    // shapes see a word; folded, it is the eyJ shape or the long segment
    // above. Read on the folded copy, with its own alphabet mapped back.
    .replace(/[\uff21-\uff3a\uff41-\uff5a\uff10-\uff19\uff0e\uff3f\uff0d][\uff01-\uff5e]+/gu, (w) => {
      const a = [...w].map(fullwidthASCII).join("")
      return /eyJ|(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_-])/.test(a) ? "…" : w
    })
    // A hex spelling: 32+ hexadecimal characters decode to a credential. A
    // digest is introduced by its label ("sha256 9f86…", sha-256:, md5),
    // which stays readable; a bare run of 64+ is not one.
    .replace(/(?<![0-9A-Za-z])(?<!(?:sha-?1|sha-?256|sha-?512|md5|hash) )(?<!(?:sha-?1|sha-?256|sha-?512|md5|hash):)(?<!(?:sha-?1|sha-?256|sha-?512|md5|hash): )0x?[0-9a-fA-F]{64,}(?![0-9A-Za-z])/g, "…")
    // A non-JWT credential a server may quote back is cut by what it is, not
    // by a guess that swallows ordinary words: `sk-`/`pk-`/`rk-` keys (a
    // hyphen or underscore is required, so "skateboarding" survives),
    // `api_key=…`/`secret_key: …` assignments, a long Bearer token (20+ so
    // "Bearer authentication" survives), and a long mixed token such as
    // `codar_access_…` (24+ characters carrying both a digit and a letter;
    // hyphenated English without digits, like
    // "secretary-general-of-the-united-nations", is left alone). A run of hex
    // is a token too, unless a digest label introduces it: "sha256 9f86…" is
    // a diagnostic, and redacting every hash makes a fault report unreadable
    // while a bare hex key is still a key. Two fixed-length lookbehinds, not
    // one variable-length one: the latter is ~400× slower per match attempt
    // and turned an 8 KB line of control characters into half a second.
    .replace(/(?<![\w-])(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}(?![\w-])/g, (run) => (skModelish(run) ? run : "…"))
    .replace(/(?<![\w-])(?:api[_-]?key|apikey|access[_-]?token|secret[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{8,}["']?/gi, "…")
    .replace(/(?<![\w-])Bearer\s+[A-Za-z0-9._~+/-]{20,}(?![\w-])/g, "Bearer …")
    .replace(/(?<![\w-])(?<!(?:sha-?1|sha-?256|sha-?512|md5|hash) )(?<!(?:sha-?1|sha-?256|sha-?512|md5|hash):)(?<!(?:sha-?1|sha-?256|sha-?512|md5|hash): )(?=[A-Za-z0-9_-]{24,}(?![\w-]))(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}(?![\w-])/gi, (run) =>
      // a model identifier of the vendor's reads as words ("claude-sonnet-4-5-20250929",
      // "DeepSeekR1DistillQwen32BInstruct", "LongCamelCaseModelIdentifierV2")
      // and is left readable; a secret's name does not (an underscore, all
      // capitals, or word boundaries that spell gibberish).
      wordish(run) ? run : "…"
    )
    // a bare run of 32+ hexadecimal characters is 16 bytes of a credential;
    // a digest is introduced by its label, as above.
    .replace(/(?<![0-9A-Za-z])(?<!(?:sha-?1|sha-?256|sha-?512|md5|hash) )(?<!(?:sha-?1|sha-?256|sha-?512|md5|hash):)(?<!(?:sha-?1|sha-?256|sha-?512|md5|hash): )0x?[0-9a-fA-F]{32,}(?![0-9A-Za-z])/g, "…")
}

// signMessage says what the check-in answered, in the user's words, with the
// token scrubbed: a server that quotes the credential back would otherwise
// put it on the card and in magpie's log. The token itself is cut where it
// is known; a credential-shaped string is cut by its shape, which covers the
// path where the sign-in threw and there is no token to cut by. The cut is by
// code point (see cut): a message full of emoji does not end in half of one.
// echoesKey says a string carries a run of the key, whether the run sits
// contiguous or has separators folded between its characters (windowsOf's
// flattened form). cutKey cuts the whole key; a vendor that splits the token
// across fields leaves no whole copy, but each piece is still a long run of
// the credential, and a reader who puts the fields back together has it.
// Eight characters of base64url are far above chance in ordinary text (64^8),
// so a hit is a fragment worth removing rather than a coincidence. Used where
// vendor strings are handed on without a card's cut: model names and ids in
// catalogOf, and the activity names the usage card joins.
// A split leaves the key in pieces of w characters, each wrapped in a label
// of its own: the characters a reader sees, in order, spell the key again —
// piece, label, piece, label — even though no piece is a window and no field
// holds more than w characters. splitHits follows the pieces through the text
// at every width from 1 to the square root of the key's length (a wider piece
// than that could not leave four pieces between labels). LABEL_CHARS is the
// longest run between two pieces a split of the vertex's own record can have:
// a label on both sides plus the separator between records, with room for a
// vendor's own padding.
const LABEL_CHARS = 40
// SPLIT_REACH is how much of a text splitAcross reads. A list of pieces is
// as long as the key plus a label per piece — a couple of kilobytes — and a
// field is served cut to MAX_SCRUB_CHARS and the card's 120 characters.
const SPLIT_REACH = 16 * 1024
// FIELD_REACH is how much of one vendor string the catalog's checks read: a
// served field is cut to 120 characters (cleanText), so a credential starting
// past this cannot reach the host; a megabyte-long name walked a dozen times
// over is a hook past its budget instead.
const FIELD_REACH = 512
// OPENING_CHARS is how much of the key (or of an encoding of it) a list has
// to hold before the split walk is worth running: a split writes its first
// piece first, and an ordinary name or sentence does not open with the key's
// characters.
const OPENING_CHARS = 6
// splitHits asks whether the key is the pieces the text spells, piece after
// piece: the first piece appears, and every next piece appears after it
// within LABEL_CHARS characters — a split writes each piece as a field of its
// own, a short label between. Prose does not spell a key that way; each
// lookup moves forward only, so the walk is linear in the text.
const splitHits = (text, key, w) => {
  const first = key.slice(0, w)
  let from = text.indexOf(first)
  while (from >= 0) {
    let end = from + w
    let k = w
    for (; k < key.length; k += w) {
      const at = text.indexOf(key.slice(k, k + w), end)
      if (at < 0 || at - end > LABEL_CHARS) break
      end = at + w
    }
    if (k >= key.length) return true
    from = text.indexOf(first, from + 1)
  }
  return false
}
// spelledForms says the texts as the encodings they may be: each as it stands
// (when asked), percent-decoded, JSON-unescaped, hex-decoded and base32-decoded
// (a complete text of one alphabet, a text with folds and labels taken out, and
// the text with everything but that alphabet taken out — so a sequence of
// short pieces, each with a label of its own, still reads as the encoding
// again). splitOf reads every one of them: a split of an encoded token is a
// split of the encoding, and the pieces only read as one after decoding.
const ENCODED_ALPHABET = { hex: /[0-9A-Za-z]/, b32: /[A-Za-z2-7]/ }
const decodedForm = (text, kind) => {
  // the pieces of a split sit at the opening of the fields they were written
  // into; a megabyte decode buys nothing the first 256 KiB does not show.
  const said = String(text).slice(0, 256 * 1024)
  if (kind === "hex") {
    const hex = said.replace(/[^0-9a-fA-F]/g, "")
    return hex.length % 2 === 0 && hex.length >= 32 && HEX_PHASE.test(hex) ? Buffer.from(hex, "hex").toString("latin1") : null
  }
  const out = base32Decode(said)
  return out === null ? null : out
}
const spelledForms = (plain, { plain: keep = true } = {}) => {
  const forms = keep ? [plain] : []
  if (/%[0-9a-fA-F]{2}/.test(plain)) {
    forms.push(percentDecode(plain))
    // the same text with the separators between pieces taken out: a `%XX`
    // triple a field boundary cut in half ("%4", "a%68") lines up again.
    const glued = plain.replace(/[^A-Za-z0-9%]+/g, "").replace(/%(?![0-9a-fA-F]{2})/g, "")
    if (glued !== plain && /%[0-9a-fA-F]{2}/.test(glued)) {
      forms.push(percentDecode(glued))
      // a piece can open with half of a triple ("%4a" + "%494f"): the text
      // with its opening character taken out lines up from there.
      forms.push(percentDecode(glued.slice(1)))
    }
  }
  if (/\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}/.test(plain)) forms.push(unescapeJSON(plain))
  for (const [kind, marks] of Object.entries(ENCODED_ALPHABET)) {
    const joined = plain.replace(/[^A-Za-z0-9]/g, "")
    const picked = plain.replace(new RegExp(`[^${kind === "hex" ? "0-9A-Fa-f" : "A-Za-z2-7"}]+`, "g"), "")
    for (const text of marks.test(joined) ? [joined, picked] : []) {
      if (text.length < 16) continue
      const out = decodedForm(text, kind)
      if (out && !forms.includes(out)) forms.push(out)
    }
  }
  return forms
}
// spelledCarriesAcross answers for a text that is only the pieces: the token,
// or the token split across the fields (splitAcross), is in one of the text's
// spellings.
export const spelledCarriesAcross = (said, key, reach = SPLIT_REACH) => {
  const kn = String(key ?? "").replace(/[^A-Za-z0-9._-]/g, "")
  if (!kn) return false
  const plain = String(said ?? "").replace(/[^\x20-\x7e]+/g, " ")
  return spelledForms(plain).some((form) => {
    const flat = flatten(form)
    return hasWindow(flat, keyReadings(key).windows) || (kn.length >= 30 && splitIn(flat, kn, reach))
  })
}
const splitOf = (said, key, reach = SPLIT_REACH) => {
  const kn = key.replace(/[^A-Za-z0-9._-]/g, "")
  if (kn.length < 30) return false
  // The walk reads only `reach` characters (splitIn), and the spellings below
  // are folded character by character, so the text is cut to that reach first:
  // a multi-megabyte field of newlines paid four global regexes over bytes the
  // walk never reached, seconds inside a hook. The margin keeps a `%` triple
  // that straddles the cut whole.
  const source = (Array.isArray(said) ? said.join(" ") : String(said ?? "")).slice(0, reach + 64)
  // a percent copy read with its joiners taken out ("%6 5%79"): the
  // spelling's chunks line up again as they were written.
  const plain = source.replace(/ (?=%[0-9a-fA-F])|(?<=%[0-9a-fA-F]) /g, "")
    .replace(FULLWIDTH, fullwidthASCII)
    .replace(controlChars, " ")
    .replace(/[^\x20-\x7e]+/g, " ")
  return splitIn(plain, kn, reach)
}
// splitFields asks the same question field by field: a split writes one piece
// into each field, and the vendor may pad it — a label before it, prose after
// it — so the pieces are not a short walk apart in one joined text. Each field
// contributes its longest run that continues the spelling, in order; a block
// of two or more is the piece itself, and a block of one is a piece too when
// the fields spell the whole key in order (a split one character per field is
// still the key, and it was the one split this walk did not see). The whole
// spelling must be consumed before this answers yes, and a key is at least 30
// characters (above), so a row of ordinary names spelling it by accident is
// not a case worth a leak. Reads what splitAcross cannot: pieces with prose
// between them.
export const splitFields = (heads, key) => {
  const kn = String(key ?? "").replace(/[^A-Za-z0-9._-]/g, "")
  if (kn.length < 30) return false
  const spellings = [kn, base32Encode(kn), percentEncode(kn)]
  const read = (h) => String(h ?? "").slice(0, FIELD_REACH).replace(/[^A-Za-z0-9%._-]+/g, " ")
  for (const spelling of spellings) {
    let pos = 0
    for (const head of heads) {
      const text = read(head)
      let best = pos
      for (let from = text.indexOf(spelling[pos]); from >= 0; from = text.indexOf(spelling[pos], from + 1)) {
        let i = from
        let p = pos
        while (i < text.length && p < spelling.length && text[i] === spelling[p]) {
          i++
          p++
        }
        if (p > best) best = p
        if (best === spelling.length) return true
      }
      if (best > pos) pos = best
    }
    if (pos >= spelling.length) return true
  }
  return false
}
// splitIn asks whether the key is the pieces the text spells: every width up
// to the square root of its length. The pieces spell the key's own characters
// or an encoding of them — base32, or `%XX` bytes — and chunks cut from
// either encoding are still chunks of the spelling, whatever labels sit
// between them.
const splitIn = (said, kn, reach = SPLIT_REACH) => {
  // the `%` of a percent copy is one of a piece's characters, not a label
  const text = String(said).slice(0, reach).replace(/[^A-Za-z0-9%._-]+/g, " ")
  // the three spellings a split can write the token in: its own characters,
  // a base32 copy and a `%XX` copy. Pieces cut out of either encoding are
  // still exact chunks of the encoding, and the walk finds them through the
  // labels between them — a `%XX` triple a piece boundary cut in half is
  // just two chunks of the spelling.
  const spellings = [kn, base32Encode(kn), percentEncode(kn)]
  for (let w = 1; w * w <= kn.length + 1; w++) if (spellings.some((spelling) => splitHits(text, spelling, w))) return true
  return false
}

export const splitAcross = (said, key, reach) => splitOf(said, key, reach)
// echoesKey says a vendor string carries a run of the account's key,
// contiguous or folded. A record is judged alone first, then every record's
// answer together (echoesIn): a key split into pieces narrower than a window
// leaves no record carrying a run, but the pieces are the key.
// windowsFlat joins the key's six-character windows over its letters, digits,
// dots, underscores and dashes (no space: a fold is a run break). Kept beside
// the key, so the list a hook reads it against does not rebuild them.
const windowsFlat = (kn) => {
  const set = new Set()
  for (let i = 0; i + WINDOWS_OF <= kn.length; i++) set.add(kn.slice(i, i + WINDOWS_OF))
  return set
}
export const echoesKey = (text, key) => {
  const k = String(key ?? "")
  if (!k) return false
  // the log form folds a fullwidth letter and reads a JSON escape as the
  // character it stands for, so a key written that way still has its runs.
  // stripLog runs a global regex (see cleanText's note): on a multi-megabyte
  // vendor field it stalled a hook for seconds, so only the prefix a card
  // could show is read — a contiguous copy is still cut from the whole string
  // by cutKey where the caller asks.
  const said = String(text ?? "")
  const reach = said.length > MAX_SCRUB_CHARS ? said.slice(0, MAX_SCRUB_CHARS) : said
  return echoesFlat(stripLog(reach), k)
}
// echoesFlat is echoesKey for a text already in its log form.
const echoesFlat = (flat, key) => {
  if (flat.length < WINDOWS_OF) return false
  const { flatWindows } = keyReadings(key)
  for (let i = 0; i + WINDOWS_OF <= flat.length; i++) if (flatWindows.has(flat.slice(i, i + WINDOWS_OF))) return true
  return false
}
// shapeOnly says the shape rules would change a string: another provider's
// credential (`sk-…`, a Bearer token), a JWT of an earlier sign-in, a
// credential folded with a punctuation the key's cuts do not walk. A vendor
// field the shape rules change is not one this plugin passes on — for the
// paths that know the current key and can tell a cut from prose.
//
// The string is read through the same cap scrubShapes reads (MAX_SCRUB_CHARS):
// compared whole, any field longer than the cap looked changed by the
// truncation alone, and an 8 KB name of plain letters read as a credential.
export const shapeOnly = (said, key) => {
  if (!key) return false
  const text = String(said ?? "")
  const reach = text.length > MAX_SCRUB_CHARS ? text.slice(0, MAX_SCRUB_CHARS) : text
  return scrubShapes(reach, key) !== reach
}

export const echoesIn = (texts, key) => {
  const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? ""))
  // The shape pass is asked only of a string credentialish names — another
  // provider's key, a Bearer, a JWT, a run of hex, a name that calls itself a
  // token. Its far edge (any 24+ run carrying a digit and a letter) is how a
  // vendor writes a model id too ("a1b2c3d4e5f6a7b8c9d0e1f2"), and that is
  // why the pass needs the question asked first. An encoded copy of the key
  // is asked of every field: a gateway that echoes the token encoded leaves
  // nothing the fold walk or the shape rules see, and the field need not look
  // like a credential at all.
  return (
    list.some((t) => echoesKey(t, key) || encodedCarries(t, key) || (credentialish(t) && shapeOnly(t, key))) ||
    splitAcross(list, key)
  )
}

export const scrub = (said, token) => cut(scrubLine(said, String(token ?? "")), 400)
export const signMessage = (r, token) => scrub(saidBy(r), token)

export const testables = { splitFields, base32Of, percentOf, API, CATALOG_PATH, UA_DESKTOP, WINDOWS_OF, windowsOf, decodedCarriesKey, hexCarriesKey, cutProjected, cutEncoded, flatten, encodedRun, spelledCarriesKey, rateOf, signMessage, shapeOnly, echoesIn, splitAcross, spelledCarriesAcross, codeOf, tokenOf, unusableKey, usernameOf, payloadOf, expiresAt, expired, keptToken, modelOf, catalogOf, protocolOf, mergeModel, agentPointsOf, pointsOf, refusalWithin, pickOf, balanceOf, unwrapped, publishedConcurrency, humanSecs, safeTime, secsOf, checkinWaitSecs, saidBy, errorCodeOf, restricted, retryAfterOf, headerWaitOf, saidNo, signedIn, signStateOf, baseURL, runningActivities, freeModelOf, claimFreeModel, scrubLine, scrubShapes, cutKey, echoesKey, scrub, cut, request, readAnswer, appToken, configPath, shownPath, qrImageURL, cleanText, login, verifyIp, wechatQrOf, wechatStatusOf, WECHAT_QR_PATH, WECHAT_STATUS_PATH, refreshToken, LOGIN_PATH, REFRESH_PATH, magicKeys: MAGIC_KEYS, ALREADY_CLAIMED, MAX_MODELS, MAX_ANSWER_BYTES, MAX_SCRUB_CHARS, MAX_CONFIG_BYTES, readConfigText, nativeFetch: nativeFetch, chatFetch: chatFetch, timing: { TIMEOUT_MS, CHECKIN_BUDGET_MS, USAGE_BUDGET_MS, HOST_USAGE_DEADLINE_MS, HOST_CHECKIN_DEADLINE_MS } }

// nativeFetchOf names the transport the vendor's own requests go through.
// The plugin's Go proxy (native.mjs, proxyFetch) answers official hosts when
// it is running; a test that stubs fetch sets testables.nativeFetch to null
// for good (withFetch does). The import is awaited once, so the first request
// of a run already goes through it rather than through fetch behind the
// import's back.
var nativeFetch, nativeFetchPending
async function nativeFetchOf() {
  if (testables.nativeFetch !== undefined) return testables.nativeFetch
  nativeFetchPending ??= import("./native.mjs")
    .then((m) => (nativeFetch = m.proxyFetch))
    .catch(() => null)
  await nativeFetchPending
  return testables.nativeFetch !== undefined ? testables.nativeFetch : nativeFetch ?? null
}

// chatFetchOf answers the fetch a chat request is handed, or null when the
// plugin should let the host's own fetch carry it. native.mjs's chatFetch is
// the proxy streaming one; it falls back to fetch itself, so this returns it
// whenever the module loads at all. A test that stubs chatTransport (the
// loader's test) replaces it the same way nativeFetch is replaced.
var chatFetch, chatFetchPending
export async function chatFetchOf() {
  if (testables.chatFetch !== undefined) return testables.chatFetch
  chatFetchPending ??= import("./native.mjs")
    .then((m) => (chatFetch = m.chatFetch))
    .catch(() => null)
  await chatFetchPending
  return testables.chatFetch !== undefined ? testables.chatFetch : chatFetch ?? null
}
