// signinpage.mjs is the browser page the 「科搭OAuth登录」 sign-in runs on.
//
// One entry point, two ways to sign in, the same two the vendor's own login
// dialog offers as tabs (扫码登录 / 手机号登录, measured on the web app
// 2026-11-13): the person switches between them on the page instead of
// choosing between buttons in magpie's list.
//
//   - SMS. The vendor's SMS code cannot be asked for by a program: POST
//     /v1/verification-code refuses a request without a solved Aliyun captcha
//     (measured 2026-11-11: {"code":400,"message":"请完成人机验证"}), and that
//     captcha is a challenge a person completes in a browser. The vendor's own
//     web app renders it with its own captchaId, loaded from its own ct4.js —
//     and that widget also runs on a page of ours (verified: a 127.0.0.1 page
//     inits it, shows the box, and getValidate() answers lot_number,
//     captcha_output, pass_token and gen_time).
//   - QR. POST /v1/wechat/login/qrcode answers {scene, qr_url} (no credential),
//     and the page polls POST /v1/wechat/login/status {scene} every two to three seconds
//     until the vendor says the sign-in is done, the code expired, the code was
//     scanned, or the account needs something first.
//
// Either way this module serves the page on 127.0.0.1, keeps the token it gets
// in memory, and hands it back to the caller. Every vendor call is made here,
// not by the page, so the sign-in leaves through the plugin's own transport and
// the token never reaches the page at all.
//
// The listener is bound to 127.0.0.1 and every request must carry the random
// path token, so another process on the machine cannot read the state, and a
// page elsewhere cannot post to it. It answers for ttlMs at most and is closed
// by the caller when the sign-in ends either way.

import { randomBytes } from "node:crypto"
import { createServer } from "node:http"

import { scrubShapes } from "./internal.mjs"

// MAX_BODY bounds one request from the page: the four captcha fields and a
// phone or code, or a scene, nothing more. A body past it is refused before it
// is read.
const MAX_BODY = 16 * 1024

// POLL_MS is how often the page asks this listener about a QR code, which is
// the vendor web app's own cadence (2000–3000 ms between status calls).
const POLL_MS = 2500

// DEFAULT_CAPTCHA_ID is the captchaId the vendor's own web app uses for its
// login page (index-iVWJypgu.js: `gS="bb7f810ecc9f6d21dcf72bcae120c8c5"`).
// It is the vendor's, not ours: the page asks the vendor's own widget.
export const DEFAULT_CAPTCHA_ID = "bb7f810ecc9f6d21dcf72bcae120c8c5"

const readJson = (req) =>
  new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on("data", (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("too large"), { code: "too_large" }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"))
      } catch (e) {
        reject(Object.assign(new Error("not json"), { code: "bad_json" }))
      }
    })
    req.on("error", reject)
  })

const send = (res, status, body, type = "application/json; charset=utf-8") => {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    // The four directives that depend on nothing the page loads: it is never
    // framed, its relative URLs cannot be re-based, its form is submitted by
    // script (nothing navigates), and it embeds no object. They close the
    // clickjacking and base-tag holes on an origin whose path is a capability.
    // script-src/connect-src/img-src are deliberately absent — the vendor's
    // captcha loads its own resources, and a policy guessed without them would
    // break the SMS path (README, "Where the sign-in page's link…").
    "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
    // the path token is the page's capability: a Referer carrying it must never
    // leave this origin, and the vendor's script makes requests of its own
    "Referrer-Policy": "no-referrer",
  })
  res.end(body)
}

// sameOrigin and isJson are the listener's own origin check. The path token is
// the real secret; these stop a browser that knows it from being pointed here
// from somewhere else. DNS rebinding is the concrete case: evil.com resolves to
// 127.0.0.1 and the request arrives with Host: evil.com. A text/plain POST is
// the other: a simple request no preflight stands before, so the JSON content
// type is required too.
const isJson = (req) => /^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))

const sameOrigin = (req, bound) => {
  if (bound && req.headers.host !== bound) return false
  const origin = req.headers.origin
  return !origin || !bound || origin === `http://${bound}`
}

// esc is copy interpolated into the page, as text or into an attribute. Most of
// it is this plugin's own words, but the IP-check step's hint names the
// account, and that name comes from the vendor's refusal body (or from what the
// person typed into the password prompt). Pasted in as HTML, a vendor echo
// would run as markup on an origin that holds this sign-in's path token — the
// page carries no CSP, and every POST to the listener names that path.
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])

// SIGN, FINISH and MISFIT are the three marks the page shows in place of an
// image: strokes drawn in the page's own colours, not the vendor's logo, which
// is not this page's to use.
const STROKE = `fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"`

const SIGN = `<svg viewBox="0 0 32 32" width="15" height="15" aria-hidden="true">
  <circle cx="16" cy="16" r="4.6" ${STROKE} stroke-width="2.4"/>
  <path d="M9.2 22.8a9.6 9.6 0 0 1 0-13.6M22.8 9.2a9.6 9.6 0 0 1 0 13.6" ${STROKE}/>
  <circle cx="16" cy="16" r="1.6" fill="currentColor"/>
</svg>`

const FINISH = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
  <path d="M5.5 12.5l4.3 4.3 8.7-9.1" ${STROKE} stroke-width="2.4" stroke-linejoin="round"/>
</svg>`

const MISFIT = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
  <path d="M7 7l10 10M17 7L7 17" ${STROKE} stroke-width="2.4"/>
</svg>`

// js is one literal for the page script. A bare identifier would be spliced in
// as a variable name — `captchaId: ${captchaId}` read the page's own (missing)
// `captchaId` and handed the vendor's widget an undefined one — so the value is
// quoted as a string, and a closing script tag in it could not end the block
// early.
const js = (v) => JSON.stringify(String(v)).replace(/</g, "\\u003c")
const num = (v, byDefault) => JSON.stringify(Number.isFinite(Number(v)) ? Number(v) : byDefault)

// The page is drawn in the design language of the Codar client's own login
// dialog and the official site, read off both with computed styles
// (2026-11-13): the client's white dialog on rgb(34,34,34) text in PingFang
// SC, its tabs with an indigo (rgb(99,102,241)) active tab, its 12px rounded
// fields on rgb(245,246,247) with rgb(223,226,232) borders and its focused
// field ringed in the indigo at 10% alpha; the site's near-black primary
// button (rgb(17,19,24), white label, 8px radius) and soft indigo glow
// (rgba(83,72,223,…)). The identity mark is this plugin's own — not the
// vendor's logo, which is not this page's to use.
const STYLE = `
  :root {
    --ink: #222222; --muted: #6b7280; --line: #dfe2e8; --field: #f5f6f7;
    --accent: #6366f1; --accent-soft: rgba(99, 102, 241, .1);
    --primary: #111318; --ok: #107c65; --err: #d92d20;
    --ok-deep: #0b5a4a; --err-deep: #9b1c15;
    --glow: rgba(83, 72, 223, .28) 0 16px 38px;
  }
  * { box-sizing: border-box }
  [hidden] { display: none !important }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
    background: radial-gradient(1200px 600px at 50% -10%, #eef0ff 0%, #f7f8fa 45%, #f2f3f5 100%);
    color: var(--ink);
    font: 14px/1.6 "PingFang SC", "PingFang TC", "PingFang HK", -apple-system, "system-ui", "Segoe UI", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main {
    width: 100%; max-width: 400px; padding: 32px 32px 28px; background: #fff;
    border: 1px solid rgba(17, 24, 39, .06); border-radius: 16px; box-shadow: var(--glow);
  }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 22px }
  .mark {
    width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center;
    background: linear-gradient(140deg, #1b1e2e 0%, #3b3f8f 70%, #6366f1 100%); color: #fff;
    box-shadow: 0 4px 12px rgba(59, 63, 143, .28);
  }
  .brand strong { font-size: 15px; font-weight: 600; letter-spacing: .2px }
  .brand span { color: var(--muted); font-size: 12px; margin-left: 2px }
  h1 { font-size: 20px; line-height: 1.4; margin: 0 0 6px; font-weight: 600 }
  p.hint { color: var(--muted); margin: 0 0 18px; font-size: 13px }
  .tabs { display: flex; gap: 24px; border-bottom: 1px solid var(--line); margin: 0 0 20px }
  .tabs button {
    position: relative; padding: 8px 0 10px; font: inherit; font-size: 14px; color: var(--ink);
    background: none; border: 0; cursor: pointer;
  }
  .tabs button[aria-selected="true"] { color: var(--accent); font-weight: 500 }
  .tabs button:focus-visible { outline: 0; box-shadow: 0 0 0 3px var(--accent-soft); border-radius: 6px }
  .tabs button[aria-selected="true"]::after {
    content: ""; position: absolute; left: 50%; bottom: -1px; width: 20px; height: 2px;
    margin-left: -10px; border-radius: 2px; background: var(--accent);
  }
  .panel { animation: rise .22s ease-out both }
  @keyframes rise { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: none } }
  @media (prefers-reduced-motion: reduce) { .panel, .qr img { animation: none; transition: none } }
  label { display: block; font-size: 12px; color: var(--muted); margin: 14px 0 6px }
  input {
    width: 100%; padding: 10px 12px; font: inherit; color: var(--ink);
    background: var(--field); border: 1px solid var(--line); border-radius: 8px; transition: border-color .15s, box-shadow .15s;
  }
  input::placeholder { color: #9ca3af }
  input:focus { outline: 0; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); background: #fff }
  input[readonly] { color: var(--muted) }
  button.action {
    font: inherit; font-size: 14px; padding: 0 18px; height: 40px; border-radius: 8px; cursor: pointer;
    border: 1px solid var(--line); background: rgba(255, 255, 255, .72); color: var(--ink); white-space: nowrap;
    transition: background .15s, border-color .15s, opacity .15s;
  }
  button.action:hover:not(:disabled) { border-color: #c9cdd6 }
  button.action.primary { width: 100%; background: var(--primary); border-color: var(--primary); color: #fff }
  button.action.primary:hover:not(:disabled) { background: #24272f }
  button.action:disabled { opacity: .45; cursor: default }
  .row { display: flex; gap: 8px; align-items: stretch; margin-top: 16px }
  .row input { flex: 1 }
  #status { margin-top: 16px; min-height: 20px; font-size: 13px; color: var(--muted) }
  #status.err { color: var(--err) }
  #status.ok { color: var(--ok) }
  #cap { margin-top: 12px }
  .qr { position: relative; width: 236px; margin: 4px auto 0; padding: 8px; border: 1px solid var(--line); border-radius: 12px; background: #fff; text-align: center }
  .qr img { width: 220px; height: 220px; display: block; image-rendering: pixelated; transition: opacity .25s, filter .25s }
  .qr.fresh { color: var(--muted); font-size: 13px; display: flex; align-items: center; justify-content: center; width: 236px; height: 236px }
  .qr.veil img { opacity: .16; filter: blur(2px) }
  .qr .veil-text {
    display: none; position: absolute; inset: 8px; grid-template-rows: 1fr auto 1fr; text-align: center;
    color: var(--ink); font-size: 13px;
  }
  .qr.veil .veil-text { display: grid }
  .qr.veil.again .veil-text { cursor: pointer }
  .qr .veil-text span { grid-row: 2; justify-self: center; padding: 6px 12px; border-radius: 8px; background: rgba(255, 255, 255, .9); box-shadow: 0 1px 4px rgba(17, 24, 39, .06) }
  .wechat { margin: 14px 0 0; text-align: center; color: var(--muted); font-size: 13px }
  form hr { border: 0; border-top: 1px solid var(--line); margin: 18px 0 0 }
  footer { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; display: flex; justify-content: space-between; gap: 12px }
  /* The end screen is the card's last panel, not a separate screen: the brand
  row and the footer stay and the sign-in's form makes way for it. It is the
  card's one centred layout — a finished sign-in has nothing left to fill in,
  so the mark, the heading and the sentence read as one block — on the form's
  own scale: a 46px round mark with a soft halo, the 20px/600 heading,
  a 14px sentence in ink, a 13px muted hint and a quiet status pill.
  On success the check draws itself in; with reduced motion the finished
  frame is shown instead. */
  main.ended > h1, main.ended > p.hint { display: none }
  .end { display: grid; justify-items: center; text-align: center; isolation: isolate; animation: rise .24s ease-out both }
  .end:focus { outline: 0 }
  .end .mark { position: relative; width: 46px; height: 46px; border-radius: 50%; margin: 6px 0 18px }
  .end .mark::after { content: ""; position: absolute; inset: -11px; z-index: -1; border-radius: 50%; opacity: .7; transform: scale(1.05); pointer-events: none; animation: halo 1.7s ease-out both }
  .end .mark.ok { background: linear-gradient(140deg, var(--ok-deep) 0%, var(--ok) 100%); box-shadow: 0 6px 18px rgba(16,124,101, .3) }
  .end .mark.ok::after { background: radial-gradient(circle, rgba(16,124,101, .2) 0%, rgba(16,124,101,0) 70%) }
  .end .mark.ok svg path { stroke-dasharray: 20; animation: tick .5s .15s ease-out both }
  .end .mark.bad { background: linear-gradient(140deg, var(--err-deep) 0%, var(--err) 100%); box-shadow: 0 6px 18px rgba(217,45,32, .26) }
  .end .mark.bad::after { background: radial-gradient(circle, rgba(217,45,32, .16) 0%, rgba(217,45,32,0) 70%) }
  .end h2 { font-size: 20px; line-height: 1.4; margin: 0 0 8px; font-weight: 600 }
  .end p { margin: 0 0 6px; overflow-wrap: anywhere }
  .end p.hint { color: var(--muted); font-size: 13px; margin: 0 }
  .end .tag { margin-top: 18px; display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 999px; font-size: 12px; color: var(--ok); background: rgba(16,124,101, .08) }
  .end .tag i { width: 6px; height: 6px; border-radius: 50%; background: currentColor }
  @keyframes tick { from { stroke-dashoffset: 20 } to { stroke-dashoffset: 0 } }
  @keyframes halo { from { transform: scale(.55); opacity: 0 } 45% { opacity: 1 } to { transform: scale(1.05); opacity: .7 } }
  @media (prefers-reduced-motion: reduce) { .end, .end .mark::after, .end .mark.ok svg path { animation: none } }
`

// PAGE is the page's markup and script. `mode` is "tabs" (the sign-in, two
// tabs) or "verify" — the vendor's IP-check form, which nothing in production
// opens any more (index.mjs never passes `verify`; the page's own driven tests
// use it to exercise /send and /verify without a password). `phone` is a
// number the vendor already showed; `hint` names the account. The page asks
// this listener for everything and never sees the token: the last thing it
// shows is that the sign-in finished.
const PAGE = ({ path, captchaId, pollMs, mode, title, hint, button, phone }) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <div class="brand"><div class="mark">${SIGN}</div><strong>科搭 Codar</strong><span>· magpie</span></div>
  <h1>${esc(title)}</h1>
  <p class="hint">${esc(hint)}</p>
${
  mode === "verify"
    ? `  <form id="sms">
    <label for="phone">手机号</label>
    <input id="phone" inputmode="numeric" autocomplete="tel" placeholder="11 位手机号"${phone ? ` value="${esc(phone)}" readonly` : ""}>
    <div id="cap"></div>
    <div class="row"><button id="send" class="action" type="button">发送验证码</button></div>
    <label for="code">短信验证码</label>
    <input id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="6 位验证码">
    <div class="row"><button id="go" class="action primary" type="submit">${esc(button)}</button></div>
  </form>`
    : `  <div class="tabs" role="tablist">
    <button type="button" role="tab" id="tab-scan" data-tab="scan" aria-selected="true" aria-controls="panel-scan" tabindex="0">扫码登录</button>
    <button type="button" role="tab" id="tab-sms" data-tab="sms" aria-selected="false" aria-controls="panel-sms" tabindex="-1">手机号登录</button>
  </div>
  <section class="panel" id="panel-scan" role="tabpanel" aria-labelledby="tab-scan">
    <div class="qr fresh" id="qr">正在获取二维码…<div class="veil-text"></div></div>
    <p class="wechat">请使用微信扫描二维码，并在手机上确认</p>
    <div class="row"><button id="refresh" class="action primary" type="button" disabled>刷新二维码</button></div>
  </section>
  <section class="panel" id="panel-sms" role="tabpanel" aria-labelledby="tab-sms" hidden>
    <form id="sms">
      <label for="phone">手机号</label>
      <input id="phone" inputmode="numeric" autocomplete="tel" placeholder="11 位手机号"${phone ? ` value="${esc(phone)}" readonly` : ""}>
      <div id="cap"></div>
      <div class="row"><button id="send" class="action" type="button">发送验证码</button></div>
      <label for="code">短信验证码</label>
      <input id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="6 位验证码">
      <div class="row"><button id="go" class="action primary" type="submit">${esc(button)}</button></div>
    </form>
  </section>`
}
  <div id="status" role="status"></div>
  <div class="end" id="done" tabindex="-1" hidden>
    <div class="mark ok">${FINISH}</div>
    <h2>登录成功</h2>
    <p>科搭的登录状态已交给 magpie。</p>
    <p class="hint">可以关闭此页面，回到 magpie 继续。</p>
    <span class="tag"><i></i>凭证只保存在本机</span>
  </div>
  <div class="end" id="bad" tabindex="-1" hidden>
    <div class="mark bad">${MISFIT}</div>
    <h2>无法完成登录</h2>
    <p id="bad-why">科搭没有接受这次登录。</p>
    <p class="hint">可以关闭此页面，回到 magpie 重新发起登录。</p>
  </div>
  <footer><span>magpie 插件 · 本机临时页面</span><span>所有凭证只在本页所在的插件里</span></footer>
</main>
<script>
const PATH = ${js(path)}
const MODE = ${js(mode)}
const POLL = ${num(pollMs, 2500)}
const el = (id) => document.getElementById(id)
// current is the side of the page the person is on. The two ways in share one
// status line, and each keeps its own words in this map rather than in the DOM:
// a QR poll answering while the SMS form is being filled in wrote 「请使用微信
// 扫码」 over the line the person was reading, and a failure behind the SMS tab
// used to take the form down with it (2026-11-27 review). A side's answers are
// written into its own slot; only the current side's slot is shown.
let current = ${js(mode === "verify" ? "sms" : "scan")}
let finished = false
// say writes the status line. A page that has finished keeps "登录成功" as its
// last word: a poll that loses a race with the success must not replace it.
const say = (m, cls, side = current) => {
  if (finished) return
  statusOf[side] = { text: m, cls: cls || "" }
  if (side !== current) return
  const s = el("status")
  if (!s) return
  s.textContent = m
  s.className = cls || ""
}
// statusOf is one slot per side, and show holds the line the current side last
// said. The page starts on the QR tab, whose box says "正在获取二维码…" before
// the script has said anything.
let statusOf = { scan: { text: "正在获取二维码…", cls: "" }, sms: { text: "", cls: "" } }
const show = () => {
  const s = el("status")
  if (!s || finished) return
  const at = statusOf[current]
  s.textContent = at.text
  s.className = at.cls
}
// end is the page's last screen: the sign-in finished, or the vendor stated a
// state it will not finish. Either way the form goes away and nothing more is
// asked, so the person is left with one sentence and a way out.
const end = (id) => {
  finished = true
  document.querySelector("main").classList.add("ended")
  if (el("status")) el("status").hidden = true
  for (const t of document.querySelectorAll(".tabs, .panel, form")) t.hidden = true
  for (const b of document.querySelectorAll("button")) b.disabled = true
  if (el("done")) el("done").hidden = id !== "done"
  if (el("bad")) el("bad").hidden = id !== "bad"
  // The last screen is all that is left to read, and the form it replaced had
  // the keyboard: every button under it is disabled now, so the focus would
  // have nowhere to go. It is put on the panel, which carries its heading.
  const panel = el(id)
  if (panel) {
    panel.scrollIntoView?.({ block: "nearest" })
    try { panel.focus?.({ preventScroll: true }) } catch {}
  }
}
const done = () => end("done")
const fail = (m) => {
  say(m, "err")
  if (el("bad-why") && m) el("bad-why").textContent = m
  end("bad")
}
// A listener that is gone stays gone: asking a closed port again only repeats
// the same failure, so the page says so once and ends.
const lost = (e) => {
  if (e && e.gone) fail(e.message)
}

const post = async (p, body) => {
  let r
  try {
    r = await fetch(PATH + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) })
  } catch {
    // No answer at all: the listener is closed, and every later call would
    // fail the same way. These two endings are what the page shows.
    throw Object.assign(new Error("登录页面已失效，请重新发起登录"), { gone: true })
  }
  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    // 410 is the listener's own word for "this page ended at the vendor": the
    // page ends the same way as an unreachable listener.
    const err = new Error(data.error || ("HTTP " + r.status))
    if (r.status === 410) err.gone = true
    throw err
  }
  return data
}

/* ---------- the SMS tab (or the whole page, for the IP check) ---------- */
// loadCaptcha runs the vendor's own captcha. The script comes from the
// vendor's own https host — the address the vendor's web app loads it from —
// and cannot be pinned: its content changes whenever the vendor deploys, and
// an integrity hash would turn that into a silent sign-in outage. What it can
// see here is bounded by what the page holds: the path token of this
// listener (which only drives the vendor calls the page already makes) and
// the phone number typed into the form; the account token never enters the
// page (every vendor call is made by the plugin, see the header).
const loadCaptcha = () => new Promise((resolve, reject) => {
  if (typeof window.initAlicom4 === "function") return resolve()
  const s = document.createElement("script")
  s.src = "https://codar-web.speedai.com/ct4.js"
  s.onload = () => (typeof window.initAlicom4 === "function" ? resolve() : reject(new Error("验证码脚本不完整")))
  s.onerror = () => reject(new Error("验证码脚本加载失败"))
  document.head.appendChild(s)
})

let cap = null
let capReady = false
let sending = false
// sendWait is the box the person is in the middle of. A check that takes too
// long, or a box that was closed without the widget saying so, would otherwise
// leave sending set for good — with the button dead under it.
let sendWait = null

// rest puts the send button back to the one state that lets a person ask for a
// code again: nothing in flight, the button labelled and enabled, and the box
// the person was in let go. Every way out of a send that is not a sent code —
// the box closed, the check refused by the widget, the init failing, the
// request failing later — comes here, so no one of them can leave the button
// disabled with no timer coming to re-enable it (2026-11-27 review). Nothing
// has been sent when they do, so the listener's cooldown is not spent either.
const rest = (side) => {
  if (!el("send")) return
  clearTimeout(sendWait)
  sendWait = null
  sending = false
  el("send").disabled = false
  el("send").textContent = "发送验证码"
  // The box on screen belonged to the person's attempt, and that attempt is
  // over: hiding it is what closes it, and the next click appends a fresh one
  // (#cap is emptied by ensureCaptcha before a retry).
  try { cap?.hideBox?.() } catch {}
}
// retry is the sentence a person can act on after the page let go of a check.
const retry = (said, side) => {
  say(said + "，可重新点击「发送验证码」", "err", side)
}

// ensureCaptcha starts the vendor's widget the first time its tab is shown.
// The widget is loaded only there: switching to the QR tab must not be held up
// by a captcha script the person is not looking at. A failed load is not a
// dead end: capReady goes back so opening the tab again asks for the script
// again — a vendor hiccup, an offline moment, and the page's only SMS path
// would otherwise stay disabled until the page was closed and reopened.
//
// The retry clears the box first: a widget that is asked for again appends
// its own markup to #cap, and the one that failed would sit under it.
const ensureCaptcha = async () => {
  if (capReady) return
  capReady = true
  const holder = el("cap")
  if (holder) holder.innerHTML = ""
  try {
    await loadCaptcha()
    await new Promise((resolve, reject) => {
      window.initAlicom4({ captchaId: ${js(captchaId)}, language: "zh", product: "bind", protocol: "https://", https: true, onError: reject }, (c) => {
        cap = c
        c.appendTo("#cap")
        c.onError((e) => reject(e instanceof Error ? e : new Error(String(e))))
        resolve(c)
      })
    })
  } catch (e) {
    cap = null
    capReady = false
    if (el("send")) el("send").disabled = false
    rest("sms")
    retry("人机验证加载失败：" + (e && e.message ? e.message : e) + "，请重试", "sms")
  }
}

const phoneOf = () => el("phone").value.trim()

el("send").onclick = () => {
  // A captcha that failed to load left cap null; the click is a retry for
  // it, and nothing else on the verify page would ever ask again.
  if (sending) return
  if (!cap) { ensureCaptcha(); return }
  const phone = phoneOf()
  if (!/^1[3-9]\\d{9}$/.test(phone)) { say("请输入正确的手机号", "err"); return }
  sending = true
  el("send").disabled = true
  say("请完成人机验证…")
  let done = false
  // A check the person walks away from has no other way out: the widget may
  // close its box silently (the vendor's own widget does), and until a vendor
  // answer comes back the button was lost for good. A bounded timeout puts it
  // back and says what to do; a solve that comes in before then cancels it.
  const pending = setTimeout(() => {
    if (done) return
    done = true
    rest("sms")
    retry("人机验证超时", "sms")
  }, 120000)
  // The widget's close/cancel callback is a fallback: the vendor's own widget
  // can call it when the person dismisses the box; the timeout above is the
  // one that covers a widget that never says anything.
  try { cap.onClose?.(() => { if (done) return; done = true; rest("sms"); retry("人机验证已取消", "sms") }) } catch {}
  try { cap.onError?.((e) => { if (done) return; done = true; rest("sms"); retry("人机验证出错", "sms") }) } catch {}
  cap.showBox()
  cap.onSuccess(async () => {
    if (done) return
    done = true
    clearTimeout(pending)
    try {
      const v = cap.getValidate()
      await post("/send", { phone, captcha: { lot_number: v.lot_number, captcha_output: v.captcha_output, pass_token: v.pass_token, gen_time: v.gen_time } })
      say("验证码已发送，请查看短信", "ok")
      let left = 60
      const timer = setInterval(() => {
        left -= 1
        el("send").textContent = left > 0 ? left + " 秒后重发" : "发送验证码"
        if (left <= 0) { clearInterval(timer); el("send").disabled = false; sending = false }
      }, 1000)
      cap.reset()
    } catch (e) {
      if (e && e.gone) { lost(e); return }
      rest("sms")
      say("验证码发送失败：" + e.message, "err", "sms")
      cap.reset()
    }
  })
}

el("sms").onsubmit = async (ev) => {
  ev.preventDefault()
  const phone = phoneOf()
  const code = el("code").value.trim()
  if (!/^1[3-9]\\d{9}$/.test(phone)) { say("请输入正确的手机号", "err"); return }
  if (!/^\\d{4,8}$/.test(code)) { say("请输入短信验证码", "err"); return }
  el("go").disabled = true
  say("正在登录…")
  try {
    await post("/verify", { phone, code })
    done()
  } catch (e) {
    if (e && e.gone) { lost(e); return }
    if (!(e && e.gone)) el("go").disabled = false
    say((MODE === "verify" ? "验证失败：" : "登录失败：") + e.message, "err")
  }
}

if (MODE === "verify") ensureCaptcha()

/* ---------- the QR tab ---------- */
let scene = null
let qrTimer = null
let started = false
// gen numbers the polling chain. Redrawing (a refresh click, an expired code)
// starts a new chain and orphans the old one, so an in-flight poll that returns
// later cannot schedule a second chain beside it.
let gen = 0
// pendingScan is the QR side's last answer, held while the SMS tab is open.
// veil is the code box's words; message is the status line; kind is "fail"
// for a vendor state the page would end on, "wait" for one it only shows.
let pendingScan = null
// qrBroken is the code on screen having no pixels: an image whose load failed.
// The status line says so and stays that way while the polls answer "waiting"
// — the vendor has a code to offer, but this page cannot show it (2026-11-27
// review).
let qrBroken = false
// guarded writes one side's answer where it belongs: the current side's status
// line, or the other side's slot and, for the QR side, the code's own veil.
const guarded = (side, message, cls, veilText, kind = "wait") => {
  if (finished) return false
  if (current === side) {
    say(message, cls, side)
    return true
  }
  // A terminal state about a side the person has left is kept for that side,
  // not dropped and not shown on the one the person is using. It is the
  // vendor's last word about this code, and it is shown when the person comes
  // back to the tab it belongs to.
  if (side === "scan" && !pendingScan) {
    pendingScan = { veil: veilText ?? message ?? "", message, kind }
    veil(pendingScan.veil, false)
  }
  return false
}

const showQr = (url) => {
  const box = el("qr")
  box.className = "qr"
  qrBroken = false
  box.textContent = ""
  const img = document.createElement("img")
  img.alt = "微信登录二维码"
  // A blocked or broken image has no pixels to scan: the image's own error is
  // the page's only word about it (naturalWidth is 0, and nothing else fires).
  // The status keeps its actionable sentence until a code really loads —
  // otherwise the person is told to scan a blank box (2026-11-27 review).
  img.onerror = () => {
    qrBroken = true
    guarded("scan", "二维码加载失败，点刷新重试", "err")
  }
  img.onload = () => {
    if (!(img.naturalWidth > 0)) return
    qrBroken = false
    guarded("scan", "请使用微信扫码", "")
  }
  img.src = url
  box.appendChild(img)
  const veil = document.createElement("div")
  veil.className = "veil-text"
  box.appendChild(veil)
}

// veil dims a code the vendor says is past use and puts a sentence over it:
// "click to get a new one" when the person has to ask for a redraw, blank while
// one is on its way. A dimmed code stays clickable so the redraw is never a
// hidden button.
const veil = (text, again) => {
  const box = el("qr")
  if (!box) return
  if (!text) { box.className = "qr"; return }
  const v = box.querySelector(".veil-text")
  if (v) { v.textContent = ""; const s = document.createElement("span"); s.textContent = text; v.appendChild(s) }
  box.className = "qr veil" + (again ? " again" : "")
  box.onclick = again ? () => drawQr() : null
}

const drawQr = async (why) => {
  if (!el("qr")) return
  const mine = ++gen
  clearTimeout(qrTimer)
  if (finished) return
  pendingScan = null
  el("refresh").disabled = true
  say(why || "正在获取二维码…", "", "scan")
  try {
    const got = await post("/qr")
    if (mine !== gen || finished) return
    scene = got.scene
    showQr(got.qr_url)
    el("refresh").disabled = false
    // The image says this itself on load: a code that failed to load must not
    // be announced as one the person can scan.
    qrTimer = setTimeout(() => pollQr(mine), POLL)
  } catch (e) {
    if (mine !== gen || finished) return
    // A failure with a code on screen is the vendor's answer about this sign-in
    // (「当前二维码需要绑定手机号」): the code under the sentence is no longer
    // one to scan, so it is dimmed and the redraw comes from the person.
    if (e && e.gone) { lost(e); return }
    if (el("qr") && el("qr").querySelector("img")) veil("二维码获取失败，点击重试", true)
    if (!guarded("scan", "二维码获取失败：" + e.message, "err", "二维码获取失败，点击重试")) pendingScan = null
    el("refresh").disabled = false
  }
}

const pollQr = async (mine) => {
  if (finished || !scene || mine !== gen) return
  try {
    const got = await post("/status", { scene, tab: current })
    // A success is the answer whatever chain asked: the person should not be
    // told to keep scanning because they pressed refresh a moment before it
    // landed. It is a terminal state the QR side reached, so it ends the
    // sign-in whichever tab is showing — the person's own side won.
    if (got.state === "done") { gen++; done(); return }
    if (mine !== gen) return
    if (got.state === "expired") {
      // The fresh code is asked for on its own: drawQr dims this one at once,
      // so the code that no longer works is never shown as if it did.
      veil("二维码已过期，正在刷新…", false)
      drawQr("二维码已过期，正在刷新…")
      return
    }
    if (got.state === "error") {
      // A FAILED scan on the tab the person left is not a reason to hide the
      // form they are filling in: the vendor's answer is kept for that tab,
      // and the host is only told when the person is on the side that failed
      // (the listener's final answer is decided by the person's own side).
      const said = got.message || "登录失败"
      if (!guarded("scan", said, "err", said, "fail")) return
      fail(said)
      return
    }
    if (got.state === "scanned") {
      if (guarded("scan", "已扫码，请在手机上确认", "", "已扫码，请在手机上确认")) veil("已扫码，请在手机上确认", false)
    } else if (!qrBroken) {
      // A code whose image failed is not one to scan: the image's own sentence
      // is what stays on the line until a code loads.
      const said = got.message || "请使用微信扫码"
      if (guarded("scan", said, "", "")) veil("", false)
    } else if (current !== "scan") {
      guarded("scan", "二维码加载失败，点刷新重试", "err", "")
    }
  } catch (e) {
    if (mine !== gen) return
    if (e && e.gone) { lost(e); return }
    guarded("scan", "状态查询失败：" + e.message, "err", "")
  }
  if (mine !== gen || finished) return
  qrTimer = setTimeout(() => pollQr(mine), POLL)
}

// startQr begins the QR sign-in the first time its tab is shown. A tab that
// was left before the code arrived keeps drawing: the code is good whether or
// not the person is looking at it, and a switched-back tab must not have to
// wait for a second one.
const startQr = () => {
  if (started) return
  started = true
  drawQr()
}

if (el("refresh")) el("refresh").onclick = () => drawQr()

/* ---------- the tabs ---------- */
const switchTab = (which, focus) => {
  if (finished) return
  current = which
  // The listener decides what a vendor answer means by the side the person is
  // on, and a QR poll can be in flight while the tab changes: a request of its
  // own says which tab it is, and a long poll that started on the other tab is
  // read against this one when it finally answers.
  post("/tab", { tab: which }).catch(() => {})
  for (const t of document.querySelectorAll("[role=tab]")) {
    const on = t.dataset.tab === which
    t.setAttribute("aria-selected", String(on))
    // Roving tabindex: one stop for the pair, and the arrow keys move with
    // the focus. Both buttons were in the tab order, so a keyboard walked
    // through two stops that were supposed to be one tab list.
    t.tabIndex = on ? 0 : -1
  }
  el("panel-scan").hidden = which !== "scan"
  el("panel-sms").hidden = which !== "sms"
  show() // restore this side's own status line
  if (focus) el("tab-" + which)?.focus?.()
  if (which === "sms") ensureCaptcha()
  else {
    startQr()
    // The vendor's last word about this code was kept while the person was
    // on the other tab: show it on the tab it belongs to now. It stays a
    // page-level failure only when the person is on the side that failed.
    if (pendingScan) {
      const at = pendingScan
      pendingScan = null
      // A vendor state the QR side would have ended on is shown here as what
      // it is: this code is done, and a fresh one is one click away. Ending
      // the page would take the SMS tab's own way in down with it, and the
      // person did not choose the QR side for this sign-in.
      const dead = at.kind === "fail"
      veil(at.veil || at.message, dead)
      say(at.message, dead ? "err" : "", "scan")
    }
  }
}
const tabs = Array.from(document.querySelectorAll("[role=tab]"))
for (const t of tabs) {
  t.onclick = () => switchTab(t.dataset.tab)
  t.onkeydown = (ev) => {
    const at = tabs.indexOf(t)
    const to = ev.key === "ArrowRight" ? (at + 1) % tabs.length : ev.key === "ArrowLeft" ? (at - 1 + tabs.length) % tabs.length : -1
    if (to < 0) return
    ev.preventDefault()
    switchTab(tabs[to].dataset.tab, true)
  }
}
if (MODE === "tabs") startQr()
</script>
</body>
</html>`

// SIGNIN is the copy the page shows by default: the phone-and-SMS and QR
// sign-ins the 「科搭OAuth登录」 method opens.
const SIGNIN = { title: "登录科搭 Codar", hint: "登录后回到 magpie 即可使用科搭的模型。", button: "登录", phone: "" }

// startSignIn serves the page and answers it.
//
// The SMS side: sendCode(phone, captcha) and verifyCode(phone, code) make the
// vendor calls and answer the token (verifyCode) or nothing (sendCode). The QR
// side: qrcode() asks the vendor for a scene and its image ({scene, qrUrl});
// status(scene) asks what became of it ({state, token?, username?, phone?,
// message?}), where state is one of "waiting" | "scanned" | "expired" | "done"
// | "error", already read from the vendor's own words by the caller, so this
// module never guesses at them. Both throw an Error whose message the page
// shows.
//
// `verify` turns the page into the vendor's IP-check step: { sendCode,
// verifyCode, hint, phone } with the same two calls (each already bound to the
// temp token and the account it belongs to). `copy` renames the page's title
// and button. The result: {url, wait(signal), close()}.
export function startSignIn({
  sendCode,
  verifyCode,
  qrcode,
  status,
  verify,
  captchaId = DEFAULT_CAPTCHA_ID,
  ttlMs = 10 * 60 * 1000,
  pollMs = POLL_MS,
  copy = {},
  // The page's 60-second resend countdown is the first line against a leaked
  // link; these are the listener's own, so a script on the path cannot spend
  // the account's SMS quota or guess a code faster than a person could. The
  // submit limit counts refusals too, so a wrong code costs an attempt.
  sendCooldownMs = 60 * 1000,
  maxSubmits = 5,
  // The QR side's own budgets. The page always waits for one answer before
  // asking the next, so a person never reaches these; they are for a script
  // that found the listener's URL: /status holds one of the vendor's
  // long-polls per call, and /qr asks for a fresh code every time. One live
  // call per route at a time, and a total for the listener's whole life (the
  // polls a patient person makes in ten minutes are a few hundred at most —
  // the default leaves that alone).
  maxQrCalls = 400,
  maxStatusCalls = 600,
  // clean cuts what this page already knows out of a sentence before the page
  // shows it: the phone number that was sent, the code that was typed, the
  // temp token a handover carries. The shape rules alone cannot see a refusal
  // that quotes the number back, and the page is not a reader any of them may
  // reach. A caller that has nothing to add leaves the shape rules be.
  clean = (said) => scrubShapes(said, ""),
  now = () => Date.now(),
} = {}) {
  const said = { ...SIGNIN, ...copy }
  const mode = verify ? "verify" : "tabs"
  const secret = randomBytes(16).toString("hex")
  const base = `/s/${secret}`
  const state = { stage: "waiting", error: "", token: "", username: "" }
  let settle = () => {}
  const done = new Promise((resolve) => {
    settle = resolve
  })
  // bound is "127.0.0.1:<port>", filled in once the listener is up: the page is
  // handed that same origin, so anything else is not this page talking.
  let bound = ""

  // Per-page send cooldown and submit budget, held here rather than in the
  // page: a resend and a wrong code both reach the vendor, and the page's own
  // timer is not what a script has to honour. Resetting on the cooldown's
  // expiry is wall-clock, so a page left open overnight can send once more.
  let lastSentAt = -Infinity
  let submits = 0

  // tab is the side of the page the person is on, as the page reports it. A QR
  // answer is read against it: the vendor's FAILED on the QR side is not the
  // end of a sign-in the person is doing on the SMS side, and a long poll that
  // started before the switch is read against the tab they are on when it
  // answers (2026-11-27 review). It starts on the QR tab, which is the page's
  // own opening state.
  let tab = "scan"
  const tabOf = (body) => {
    const said = String(body?.tab ?? "")
    if (said === "scan" || said === "sms") tab = said
    return tab
  }

  // ended is aborted when the page closes. A vendor call started for this
  // page is the page's own work: once nobody is looking at it, it is
  // abandoned rather than waited on to its timeout (a QR poll holds 35
  // seconds, and a closed page has no reader for its answer).
  const ended = new AbortController()
  const cooldownLeft = () => lastSentAt === -Infinity ? 0 : Math.max(0, lastSentAt + sendCooldownMs - now())

  // finish is the one success path, whichever tab got there first: the token
  // stays here, the caller is woken, and nothing more is answered as success.
  const finish = (got) => {
    state.token = String(got?.token ?? "")
    state.username = String(got?.username ?? "")
    state.stage = "done"
    settle()
  }

  const pageHtml = () =>
    PAGE({
      path: base,
      captchaId,
      pollMs,
      mode,
      title: said.title,
      hint: verify ? verify.hint : said.hint,
      button: said.button,
      phone: verify ? verify.phone : said.phone,
    })

  // route answers one request from the page: "/send", "/verify", "/qr" and
  // "/status" are this module's; everything else is a 404. The origin check and
  // the JSON content type are the listener's, and are not repeated here — the
  // server below applies them before it comes this far.
  const route = async (rest, req, body) => {
    const reply = (status, text, type) => ({ status, text: String(text), type })
    if (!(rest === "/send" || rest === "/verify" || (!verify && (rest === "/qr" || rest === "/status" || rest === "/tab")))) return reply(404, "not found", "text/plain; charset=utf-8")
    if (!isJson(req)) return reply(415, JSON.stringify({ error: "请求格式不被允许" }))
    if (state.stage === "done") return reply(409, JSON.stringify({ error: "已经登录" }))
    try {
      return reply(200, JSON.stringify(await answer(rest, body)))
    } catch (e) {
      // a call abandoned because the page closed says nothing to anyone: no
      // page is left to read it, and the closed state is not an error the
      // sign-in ended with
      if (ended.signal.aborted) return reply(499, JSON.stringify({ error: "登录页已关闭" }))
      // A vendor sentence can quote what was sent or what it holds; the shape
      // rules cut a credential out of it whatever it is, as the status word's
      // sentence already is. The page is not a reader the token may reach.
      state.error = clean(e instanceof Error ? e.message : String(e), body)
      return reply(typeof e?.reply === "number" ? e.reply : 400, JSON.stringify({ error: state.error }))
    }
  }

  // answer is the work behind a recognised route, answered as the object the
  // page reads back. The QR routes are guarded here, not only in the page's
  // own script: one live vendor call per route at a time, and a total for
  // this listener's life. A person's page never meets either — it waits for
  // each answer before asking again — and a script on the leaked URL meets
  // both: it cannot hold two long-polls open, and it cannot churn the
  // vendor's code endpoint past the budget. A refused call never reaches the
  // vendor, so it spends nothing.
  const live = { qr: 0, status: 0 }
  const spent = { qr: 0, status: 0 }
  const budget = (rest) => {
    const k = rest.slice(1)
    if (live[k] > 0) throw Object.assign(new Error("上一次请求尚未完成，请稍候"), { reply: 429 })
    const cap = k === "qr" ? maxQrCalls : maxStatusCalls
    if (spent[k] >= cap) throw Object.assign(new Error("请求次数过多，请重新打开登录页"), { reply: 429 })
    live[k] += 1
    return () => { live[k] -= 1; spent[k] += 1 }
  }
  // currentScene is the code this page is showing. A status answer is only
  // about the current one: a long poll started before the person pressed
  // refresh can come back "done" for the account they left behind, and
  // finishing it would hand the host a token for the wrong account
  // (2026-11-28 review).
  let currentScene = ""
  const answer = async (rest, body) => {
    // The page's own word about which side it is showing. It costs nothing and
    // asks the vendor nothing; it is what lets the QR side's failure wait for
    // the QR tab instead of ending a sign-in being done by SMS.
    if (rest === "/tab") return { tab: tabOf(body) }
    if (rest === "/qr") {
      const spentQr = budget(rest)
      let got
      try {
        got = await qrcode(ended.signal)
      } finally {
        spentQr()
      }
      // 502 is the caller's: this module only names the failure
      if (!got?.scene || !got?.qrUrl) throw Object.assign(new Error("二维码数据不完整"), { reply: 502 })
      currentScene = got.scene
      return { scene: got.scene, qr_url: got.qrUrl }
    }
    if (rest === "/status") {
      // The tab this poll was made on, not the last one the page announced:
      // /tab is fire-and-forget, and a status already in flight when the
      // person switched to the SMS form would otherwise be judged against the
      // scan side they left (2026-11-28 review).
      if (body?.tab) tab = tabOf(body)
      const scene = String(body?.scene ?? "").trim()
      if (!scene) throw new Error("缺少 scene")
      // A poll for a code the page has already replaced answers nothing: it
      // must not end this sign-in, and it must not spend the vendor's budget
      // either. The budget is taken only after this check, so a stale poll
      // costs nothing (2026-11-28 review: the old order spent it, and the
      // "expired/404" path of a replaced code could then be read as this
      // page's own answer).
      if (currentScene && scene !== currentScene) return { state: "waiting" }
      // a poll that arrives before this page ever drew a code names the one
      // it will draw: nothing has been replaced yet
      currentScene = currentScene || scene
      const spentStatus = budget(rest)
      let got
      try {
        got = await status(scene, ended.signal)
      } finally {
        spentStatus()
      }
      if (got?.state === "done" && state.stage !== "done") finish(got)
      // A state the vendor will not finish (phone binding required, an IP
      // check, a failed scan) is the end of this sign-in: the page stops
      // asking, and wait() must answer too. Left unsettled, the host sat on
      // the page for the listener's whole TTL. (A "done" with no token still
      // ends it in the caller's read of the vendor's words: an answer cannot be
      // both.)
      // The vendor's refusal ends this sign-in only when the person is on the
      // side it is about. A FAILED scan behind the SMS tab is not a reason to
      // answer the host "failed" over a code they are about to type: the page
      // keeps it for the QR tab, and what the person is doing there decides
      // (2026-11-27 review). A request that says nothing about its tab is read
      // as the QR side, which is what it was before the page had two.
      else if (got?.state === "error" && state.stage !== "done" && tab === "scan") {
        state.stage = "error"
        // A vendor sentence can quote what was sent; the shape rules cut a
        // credential out of it whatever it is, and the page and the host both
        // show what is kept here.
        state.error = typeof got.message === "string" ? scrubShapes(got.message, "") : ""
        settle()
      }
      // nothing but the state and a sentence ever leaves this listener
      return { state: got?.state ?? "waiting", message: got?.message ? String(got.message) : "" }
    }
    const phone = String(body?.phone ?? "").trim()
    if (!/^1[3-9]\d{9}$/.test(phone)) throw new Error("请输入正确的手机号")
    if (rest === "/send") {
      const left = cooldownLeft()
      if (left > 0) throw Object.assign(new Error(`请 ${Math.ceil(left / 1000)} 秒后再发送验证码`), { reply: 429 })
      const c = body?.captcha ?? {}
      const captcha = {
        lot_number: String(c.lot_number ?? ""),
        captcha_output: String(c.captcha_output ?? ""),
        pass_token: String(c.pass_token ?? ""),
        gen_time: String(c.gen_time ?? ""),
      }
      if (!captcha.lot_number || !captcha.captcha_output || !captcha.pass_token || !captcha.gen_time) throw new Error("人机验证没有完成")
      // The cooldown is taken before the vendor is asked, not after: a check
      // that runs before an await lets every concurrent /send through, and a
      // script holds the page's solved captcha, so it can fire as many as it
      // likes. A send the vendor refuses gives the cooldown back unless a
      // later one has already taken it.
      const sentAt = now()
      lastSentAt = sentAt
      try {
        await sendCode(phone, captcha, ended.signal)
      } catch (e) {
        if (lastSentAt === sentAt) lastSentAt = -Infinity
        throw e
      }
      if (state.stage !== "done") state.stage = "sent"
      return { ok: true }
    }
    // The submit budget is spent before the vendor is asked, refusals
    // included: a page with five wrong codes in it ends here rather than
    // letting a script walk the vendor's code space.
    if (submits >= maxSubmits) throw Object.assign(new Error("验证码尝试次数过多，请重新打开登录页"), { reply: 429 })
    submits += 1
    const code = String(body?.code ?? "").trim()
    if (!/^\d{4,8}$/.test(code)) throw new Error("请输入短信验证码")
    const got = await verifyCode(phone, code, ended.signal)
    // The token on record is the sign-in that finished first, and the page
    // stops asking once one has: a second call over a finished sign-in is a
    // lost race, not a new sign-in to replace it with.
    if (state.stage !== "done") finish(got)
    return { ok: true }
  }

  const server = createServer(async (req, res) => {
    // Everything this listener does can throw on input it did not choose: the
    // URL parser refuses a request target like `http://[`, and an async
    // listener that rejects is an unhandled rejection — Node and Bun both end
    // the whole process on it, which any local process could trigger while
    // the page was open. A throw with no answer yet becomes this request's
    // answer, and one after the head went out ends the connection.
    try {
      if (!sameOrigin(req, bound)) return send(res, 403, JSON.stringify({ error: "来源不被允许" }))
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      if (!url.pathname.startsWith(base)) return send(res, 404, "not found", "text/plain; charset=utf-8")
      const rest = url.pathname.slice(base.length) || "/"
      if (req.method === "GET" && (rest === "/" || rest === "/index.html")) return send(res, 200, pageHtml(), "text/html; charset=utf-8")
      if (req.method !== "POST") return send(res, 404, "not found", "text/plain; charset=utf-8")
      let body = {}
      if (isJson(req)) {
        try {
          body = await readJson(req)
        } catch {
          return send(res, 400, JSON.stringify({ error: "请求内容无法识别" }))
        }
      }
      const got = await route(rest, req, body)
      return send(res, got.status, got.text, got.type)
    } catch (e) {
      if (res.headersSent || res.writableEnded) {
        try { res.destroy() } catch {}
        return
      }
      const status = typeof e?.reply === "number" ? e.reply : 400
      try { send(res, status, JSON.stringify({ error: "请求内容无法识别" })) } catch { try { res.destroy() } catch {} }
    }
  })

  return new Promise((resolve, reject) => {
    // timer is declared before anything that can reach close(): a listen that
    // fails (the port taken, no loopback) answers with an error, and a close
    // reading a timer declared later would throw instead of ending cleanly.
    let timer = null
    let closing = false
    // closed is what wait() reads after close(): a page that ended without a
    // sign-in must not answer a token it happened to hold when the TTL ran
    // out or the caller cancelled — the host would save a sign-in the person
    // never finished (2026-11-28 review).
    let closed = false
    const close = () => {
      if (closing) return
      closing = true
      closed = true
      if (timer) clearTimeout(timer)
      ended.abort()
      state.token = null
      state.username = null
      server.close()
      // close() stops new connections; one already reading a body would keep
      // the runtime's socket until its own timeout, and the host would wait
      // for a page nobody can answer. Node has closeAllConnections; Bun has
      // no such call, and its close() ends the listener either way.
      server.closeAllConnections?.()
      settle()
    }
    server.once("error", (e) => {
      close()
      reject(e)
    })
    // The listener is unref'd for the same reason the timer is: a page nobody
    // closed (a test, a CLI sign-in whose caller went away) must not hold the
    // process open for the page's whole life. The server still accepts while
    // anything else keeps the loop alive — magpie always does — and close()
    // ends it either way (2026-11-27 review).
    server.unref?.()
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      bound = `127.0.0.1:${port}`
      const url = `http://${bound}${base}/`
      // timer is unref'd so a page nobody closed never holds the process open.
      timer = setTimeout(close, ttlMs)
      timer.unref?.()
      // wait answers the token once the page finished a sign-in, null when the
      // sign-in was closed/aborted before that, and {error} when the vendor
      // stated a state it will not finish.
      const wait = async (signal) => {
        if (signal?.aborted) {
          close()
          return null
        }
        await new Promise((res2) => {
          const onAbort = () => {
            close()
            res2()
          }
          signal?.addEventListener?.("abort", onAbort, { once: true })
          done.then(() => {
            signal?.removeEventListener?.("abort", onAbort)
            res2()
          })
        })
        if (closed) return null
        if (state.stage === "error") return { error: state.error || "登录失败" }
        return state.stage === "done" && state.token ? { token: state.token, username: state.username } : null
      }
      resolve({ url, wait, close, state })
    })
  })
}
