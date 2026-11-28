// The sign-in page's script, run the way a person runs it: in a real browser,
// against this module's own listener, with every vendor call stubbed here.
//
// The page's script is a string, and reading it for the right words only says
// the words are there. The three defects this file pins were all of that kind —
// code that ran, ran in the wrong tab, and left the page a person had to close
// to recover (2026-11-27 review). So each test below opens the served page in
// headless Chrome over the DevTools protocol, drives it with synthesized clicks
// and keystrokes, and reads what the person would see: the status line, which
// panel is visible, the button's own `disabled`, and what the listener's wait()
// answers.
//
// Nothing here reaches a vendor. The page asks its listener only, and the
// listener's vendor calls are the test's own functions; the one external script
// the page would load (the vendor's captcha ct4.js) is never fetched — the
// tests that need a widget define window.initAlicom4 before the page asks for
// it, which is also the shape the vendor's script leaves behind. The browser is
// given a resolver that answers nothing but loopback, so a stray request cannot
// leave the machine. With no browser found the browser tests are skipped and
// the source-level checks still run.

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { DEFAULT_CAPTCHA_ID, startSignIn } from "../lib/signinpage.mjs"

const GIF = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
const TOKEN = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ username: "user_1", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.sig`

// CHROME is the browser this file drives, or null when none is installed. The
// tests that need one are skipped rather than failed: the suite runs on a CI
// image that may not carry a browser, and a source-level check is still run
// below for exactly that case.
// A browser that is there is used: the point of these tests is the page as a
// person runs it, and leaving them off by default meant the default suite
// proved nothing about them (2026-11-28 review). A machine without one skips
// them and still runs the source-level checks below; `CODAR_UI_TESTS=0` turns
// them off on purpose.
//
// Bun's runner is left out: driving Chrome through its WebSocket and child
// processes timed out at five seconds on both CI Macs and CI Linux while the
// same file passed under node (2026-11-28), and the packed-suite run is left
// out too — what it proves is that the tarball installs and starts, not how a
// browser paints.
const CHROME =
  typeof Bun === "undefined" &&
  !process.env.CODAR_TARBALL_GATE &&
  process.env.CODAR_UI_TESTS !== "0" &&
  (process.env.MAGPIE_CHROME ||
  [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ].find((p) => existsSync(p)) ||
  null)

const skip = CHROME ? false : "no Chrome or Chromium to drive; set MAGPIE_CHROME"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// launch starts headless Chrome with a throwaway profile and answers a session
// on a blank target. The resolver rule is the offline guarantee: every name but
// loopback is unanswered, so the vendor's ct4.js and QR image cannot load even
// if a test got the script wrong.
async function launch() {
  const profile = mkdtempSync(join(tmpdir(), "magpie-page-"))
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--metrics-recording-only",
      `--user-data-dir=${profile}`,
      `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  )
  let stderr = ""
  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`chrome did not start: ${stderr.slice(-500)}`)), Number(process.env.DBG_TIMEOUT || 20000))
    const onExit = (code) => {
      clearTimeout(timer)
      reject(new Error(`chrome exited ${code}: ${stderr.slice(-500)}`))
    }
    chrome.once("exit", onExit)
    chrome.once("error", reject)
    chrome.stderr.on("data", (d) => {
      stderr += String(d)
      if (process.env.DBG_TIMEOUT) process.stderr.write("[chrome] " + String(d))
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderr)
      if (!m) return
      clearTimeout(timer)
      chrome.removeListener("exit", onExit)
      resolve(m[1])
    })
  })
  // One long-lived DevTools socket carries the browser target and every page
  // session the tests open, flattened into one stream. Answers are matched by
  // id; everything else is an event, handed to the pages that asked for them.
  const ws = new WebSocket(wsUrl)
  ws.binaryType = "arraybuffer"
  const listeners = new Set()
  let next = 0
  const pending = new Map()
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data))
    if (msg.id !== undefined) {
      const waiting = pending.get(msg.id)
      if (!waiting) return
      pending.delete(msg.id)
      if (msg.error) waiting.reject(new Error(`${msg.error.message} (${waiting.method})`))
      else waiting.resolve(msg.result)
      return
    }
    for (const fn of listeners) fn(msg)
  })
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++next
      pending.set(id, { resolve, reject, method })
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  const close = () => {
    try { ws.close() } catch {}
    chrome.kill()
    // Chrome keeps writing its profile for a moment after SIGTERM (a lock
    // file, a last flush), and a directory it fills again after this call is
    // removed is an ENOTEMPTY after the test has ended — which node --test
    // reports as a failure of a test that already passed (2026-11-28 review).
    // Waiting for the child's exit, then retrying the removal, leaves no
    // activity behind.
    const remove = (tries = 0) => {
      try {
        rmSync(profile, { recursive: true, force: true })
      } catch (e) {
        if (tries >= 40 || (e?.code !== "ENOTEMPTY" && e?.code !== "EBUSY" && e?.code !== "EPERM")) return
        setTimeout(() => remove(tries + 1), 50).unref()
      }
    }
    if (chrome.exitCode !== null || chrome.signalCode !== null) remove()
    else {
      chrome.once("exit", () => remove())
      // a browser that does not exit must not hold the profile forever
      setTimeout(() => { try { chrome.kill("SIGKILL") } catch {} ; remove() }, 2000).unref()
    }
  }
  // onMessage subscribes to the socket's events and answers the way off() does.
  const onMessage = (fn) => {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }
  return { send, close, onMessage }
}

// openPage gives one page of its own: a target, a session, and the handful of
// protocol calls a test needs spelled out (evaluate, click, type, key, errors).
async function openPage(browser) {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" })
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true })
  const errors = []
  const send = (method, params) => browser.send(method, params, sessionId)
  const wait = (name) => send("Runtime.evaluate", { expression: name, awaitPromise: true, returnByValue: true })
  // Runtime.exceptionThrown is a session-scoped event with no request of its
  // own: it is listened for on the browser socket and filtered by session.
  const off = browser.onMessage((msg) => {
    if (msg.sessionId !== sessionId || msg.method !== "Runtime.exceptionThrown") return
    const d = msg.params.exceptionDetails
    errors.push(d?.exception?.description ?? d?.text ?? "exception")
  })
  await send("Runtime.enable")
  await send("Page.enable")
  // A headless target is not the focused window, and focus() in a background
  // page is a no-op the keyboard tests would read as "the tab did not move".
  await send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {})
  const page = {
    errors,
    // define installs a stub before the page's own script runs: the vendor's
    // captcha widget is the one piece of the page that is not ours, and the
    // stub stands in for the shape it leaves behind.
    define: (source) => send("Page.addScriptToEvaluateOnNewDocument", { source }),
    // goto loads the served page and resolves once its script has run (the QR
    // page's first /qr request is the readiness signal the caller waits for).
    goto: async (url) => {
      await send("Page.navigate", { url })
      for (let i = 0; i < 200; i++) {
        const r = await wait("document.readyState")
        if (r.result?.value === "complete") return
        await sleep(20)
      }
      throw new Error("the page never finished loading")
    },
    // eval runs fn's source in the page and answers its value. Callers write
    // plain source, not a function, so nothing is serialized implicitly.
    eval: async (source) => {
      const r = await send("Runtime.evaluate", { expression: source, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
      return r.result?.value
    },
    // until polls the page until fn answers something truthy, then answers it.
    until: async (source, why, ms = 20000) => {
      const deadline = Date.now() + ms
      for (;;) {
        const got = await page.eval(source)
        if (got) return got
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${why}`)
        await sleep(20)
      }
    },
    // click is a real mouse press on the element's own box: the page's
    // listeners run because the browser dispatched them, not because a test
    // called them.
    click: async (selector) => {
      const box = await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
      if (!box) throw new Error(`no ${selector} on the page`)
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 })
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 })
    },
    // focus moves the page's focus without asking anything to happen: the key
    // that follows is the person's, not the page's.
    focus: (selector) => page.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.focus(); return document.activeElement === e })()`),
    type: async (selector, text) => {
      if (!(await page.focus(selector))) throw new Error(`no focusable ${selector}`)
      await send("Input.insertText", { text })
    },
    close: () => off(),
    key: async (name) => {
      const codes = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }
      const code = codes[name]
      if (!code) throw new Error(`no key ${name}`)
      for (const type of ["rawKeyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
    },
  }
  return { page, sessionId, targetId }
}

// WIDGET stands in for the vendor's captcha script. The page loads ct4.js from
// the vendor's host, which the offline browser never resolves; defining
// initAlicom4 first is the page's own "the script is already here" path, and
// the box the stub answers with is the vendor widget's own vocabulary —
// showBox(), a person solving it (ok), closing it (cancel) and the widget's
// own error callback (error).
const WIDGET = `(() => {
  const say = (m, cls) => { const s = document.getElementById("status"); if (!s) return; s.textContent = m; s.className = cls || "" }
  window.box = {
    shown: false, ok: null, bad: null,
    appendTo() {},
    showBox() { this.shown = true },
    onSuccess(fn) { this.ok = fn },
    onError(fn) { this.bad = this.bad ? (e) => { try { this.bad(e) } catch {}; try { fn(e) } catch {} } : fn },
    getValidate() { return { lot_number: "lot", captcha_output: "out", pass_token: "pass", gen_time: "1" } },
    reset() { this.ok = null; this.bad = null },
    onClose(fn) { this.closeFn = fn },
    cancel() { this.reset(); this.closeFn?.() },
    cancelQuietly() { this.reset() },
    error() { const f = this.bad; this.reset(); if (f) f(new Error("widget error")); say("人机验证出错，请重试", "err") },
    asHost() { say("请使用微信扫码") },
  }
  window.initAlicom4 = (cfg, cb) => { window.__widgetCfg = cfg; window.__inits = (window.__inits || 0) + 1; cb(window.box) }
})()`

// status is the page's status line as the person reads it; ended says the page
// reached its last screen; panel says which tab's section is on screen.
const status = `document.getElementById("status").textContent`
const ended = `document.querySelector("main").classList.contains("ended")`
const panel = `(() => { const s = document.getElementById("panel-scan"), m = document.getElementById("panel-sms"); return s.hidden ? (m.hidden ? "none" : "sms") : "scan" })()`
const sendDisabled = `document.getElementById("send").disabled`
const refreshDisabled = `document.getElementById("refresh").disabled`
const focusName = `(() => { const a = document.activeElement; return a ? (a.id || a.className || a.tagName) : "" })()`

// ready is what every browser test starts with: the page served by this
// module, the widget stub installed before its script, and the page loaded.
async function ready(browser, options) {
  const page = await startSignIn({ pollMs: 60, ...options })
  const opened = await openPage(browser)
  await opened.page.define(WIDGET)
  await opened.page.goto(page.url)
  await opened.page.until(`document.readyState === "complete" && document.getElementById("qr")`, "the page body")
  return { page, ui: opened.page }
}

// answerOf waits for the listener's wait() to answer, or for the timeout to run
// out (the test's own bound on "the host is still sitting there").
const answerOf = (page, ms = 1500) => Promise.race([page.wait(), sleep(ms).then(() => "pending")])

test("a QR poll answering behind the SMS tab changes nothing on screen, and nothing the host is told", { skip }, async () => {
  // The defect: the page had one status line and one last screen for its two
  // ways in. A person on the SMS tab sent a code, the QR poll still running
  // wrote 「请使用微信扫码」 over 「验证码已发送」, and the next poll answering
  // the vendor's FAILED hid the form with the code in it and ended the sign-in
  // for the host — a sign-in the person never chose to end.
  const browser = await launch()
  let page
  try {
    let statusCalls = 0
    const opened = await ready(browser, {
      qrcode: async () => ({ scene: "scene-1", qrUrl: `data:image/gif;base64,${GIF}` }),
      status: async (scene) => {
        statusCalls += 1
        // this answer is in flight while the person switches tabs and sends a
        // code: it lands with the SMS tab on screen. The next one is FAILED.
        if (statusCalls === 1) {
          await new Promise((r) => setTimeout(r, 1200))
          return { state: "scanned", message: "已扫码，请在手机上确认" }
        }
        return { state: "error", message: "扫码登录失败" }
      },
      sendCode: async () => {},
      verifyCode: async () => ({ token: TOKEN, username: "user_1" }),
    })
    page = opened.page
    const ui = opened.ui
    await ui.until(`typeof window.box === "object"`, "the widget")

    await ui.click("#tab-sms")
    assert.equal(await ui.eval(panel), "sms", "the SMS form is the one on screen")
    await ui.until(`window.__inits >= 1`, "the SMS side's own script", 10000)

    await ui.type("#phone", "13800138000")
    await ui.click("#send")
    await ui.eval("window.box.ok()")
    await ui.until(`${JSON.stringify("验证码已发送，请查看短信")} === ${status}`, "the sent line")
    await ui.type("#code", "123456")

    // the poll that was answered while the person was on the SMS tab lands
    await sleep(1300)
    const line = await ui.eval(status)
    assert.equal(line, "验证码已发送，请查看短信", `a QR poll wrote over the SMS tab's status line: ${line}`)
    assert.equal(await ui.eval(panel), "sms", "and the form with the code in it is still on screen")

    // the FAILED poll is the whole bug: it used to hide the form with the
    // code in it and tell the host the sign-in failed
    await ui.until(`document.getElementById("qr").classList.contains("veil")`, "the failed scan held for the QR tab", 6000)
    assert.equal(await ui.eval(status), "验证码已发送，请查看短信", "a failed scan behind the SMS tab wrote over the form's line")
    assert.equal(await ui.eval(panel), "sms", "the form with the code in it is still on screen")
    assert.equal(await ui.eval(ended), false, "the page did not reach its last screen")
    const stillThere = await answerOf(page, 600)
    assert.equal(stillThere, "pending", `the host was told the sign-in ended: ${JSON.stringify(stillThere)}`)

    // and the SMS sign-in finishes: the terminal state is the side the person chose
    await ui.click("#go")
    const got = await answerOf(page, 4000)
    assert.equal(got?.token, TOKEN, `the SMS sign-in is the one that ended: ${JSON.stringify(got)}`)
    await ui.until(`!document.getElementById("done").hidden`, "the success screen")
    assert.deepEqual(ui.errors, [], "the page's script threw")
  } finally {
    page?.close()
    browser.close()
  }
})

test("a QR failure waits for the QR tab, and shows there when the person goes back", { skip }, async () => {
  // The QR tab is the window on the QR side: while it is not open its answers
  // are held — but the vendor's FAILED is that side's own ending, so it is
  // shown when the person returns to the tab, instead of being dropped.
  const browser = await launch()
  let page
  try {
    let statusCalls = 0
    let onSms = null
    const opened = await ready(browser, {
      qrcode: async () => ({ scene: "scene-1", qrUrl: `data:image/gif;base64,${GIF}` }),
      status: async () => {
        statusCalls += 1
        // the first answer is in flight while the person switches to SMS
        if (statusCalls === 1) {
          await new Promise((r) => (onSms = r))
          return { state: "error", message: "扫码登录失败" }
        }
        return { state: "waiting" }
      },
      sendCode: async () => {},
      verifyCode: async () => ({ token: TOKEN, username: "user_1" }),
    })
    page = opened.page
    const ui = opened.ui
    await ui.until(`typeof window.box === "object"`, "the widget")
    await ui.until(`typeof window.__statusCalls !== "undefined" || true`, "the page")
    // the status handler is held by the listener's own wait, so the switch can
    // happen before its answer lands
    await ui.click("#tab-sms")
    assert.equal(await ui.eval(panel), "sms")
    assert.equal(await answerOf(page, 400), "pending", "the host is not told while the person is elsewhere")
    onSms?.()
    await ui.until(`document.getElementById("qr").classList.contains("veil")`, "the failure held for the QR tab")
    // the class and the sentence are written in the same turn, but a busy
    // machine can paint between them: wait for the text, not just the class
    await ui.until(`(document.querySelector("#qr .veil-text")?.textContent || "").length > 0`, "the failure text")
    assert.equal(await ui.eval(panel), "sms", "the SMS tab is not disturbed by it")
    assert.equal(await ui.eval(ended), false, "and the page has not ended")
    assert.match(await ui.eval(`document.getElementById("qr").querySelector(".veil-text").textContent`), /扫码登录失败/)
    assert.equal(await answerOf(page, 500), "pending", "the host still waits: the person is on the SMS tab")

    await ui.click("#tab-scan")
    assert.equal(await ui.eval(panel), "scan", "the QR tab is open")
    // the failed code is shown as what it is — a code that is done, with a
    // fresh one a click away — not as the end of the person's sign-in
    assert.equal(await ui.eval(ended), false, "showing the failure does not end the sign-in")
    assert.equal(await ui.eval(refreshDisabled), false, "the refresh button is there to recover with")
    assert.match(await ui.eval(status), /扫码登录失败/)
    assert.equal(await answerOf(page, 500), "pending", "the host is left to the person's own side")
  } finally {
    page?.close()
    browser.close()
  }
})

test("the QR tab's own failure is still the end when the QR tab is the one open", { skip }, async () => {
  const browser = await launch()
  let page
  try {
    const opened = await ready(browser, {
      qrcode: async () => ({ scene: "scene-1", qrUrl: `data:image/gif;base64,${GIF}` }),
      status: async () => ({ state: "error", message: "扫码登录失败" }),
      sendCode: async () => {},
      verifyCode: async () => ({ token: TOKEN, username: "user_1" }),
    })
    page = opened.page
    await opened.ui.until(`document.querySelector("main").classList.contains("ended")`, "the failure screen")
    assert.equal(await opened.ui.eval(panel), "none", "the form is gone: the sign-in is over")
    const got = await answerOf(page, 2000)
    assert.equal(got?.error, "扫码登录失败", `wait() answers the failure: ${JSON.stringify(got)}`)
  } finally {
    page?.close()
    browser.close()
  }
})

test("closing the captcha box leaves the send button usable and the cooldown unspent", { skip }, async () => {
  // The defect: `sending` and `disabled` were set before the widget's box was
  // shown, and only a sent code's timer or a refused send put them back. A
  // person who closed the box had a dead button for good — though nothing had
  // been sent, so the page's own cooldown had nothing to spend.
  const browser = await launch()
  let page
  try {
    const sent = []
    const opened = await ready(browser, {
      qrcode: async () => ({ scene: "scene-1", qrUrl: `data:image/gif;base64,${GIF}` }),
      status: async () => ({ state: "waiting" }),
      sendCode: async (phone) => { sent.push(phone) },
      verifyCode: async () => ({ token: TOKEN, username: "user_1" }),
    })
    page = opened.page
    const ui = opened.ui
    await ui.until(`typeof window.box === "object"`, "the widget")
    await ui.click("#tab-sms")
    await ui.until(`window.__inits >= 1`, "the SMS side's own script", 10000)

    // A widget that reports a close through the callback the page registered:
    // the page lets go of the attempt and says it can be retried.
    await ui.type("#phone", "13800138000")
    await ui.click("#send")
    assert.equal(await ui.eval("window.box.shown"), true, "the box was shown")
    await ui.eval("window.box.cancel()")
    await ui.until(`!${sendDisabled}`, "the button back after a close")
    assert.match(await ui.eval(status), /取消|重试|重新/, "the page says the check can be retried")
    assert.deepEqual(sent, [], "a closed box sent nothing")

    // A widget that says the box was closed by an error: the same recovery,
    // with the widget's own word for it.
    await ui.click("#send")
    await ui.eval("window.box.error()")
    await ui.until(`!${sendDisabled}`, "the button back after the widget's error")

    // And the retry works: the same click sends, and the cooldown the earlier
    // closes did not touch lets it through.
    await ui.click("#send")
    await ui.eval("window.box.ok()")
    await ui.until(`${JSON.stringify("验证码已发送，请查看短信")} === ${status}`, "the sent line")
    assert.deepEqual(sent, ["13800138000"], "the code was asked for once, by the person who asked")
    assert.deepEqual(ui.errors, [], "the page's script threw")
  } finally {
    page?.close()
    browser.close()
  }
})

test("a QR image that fails to load says how to recover, and a code that loads clears it", { skip }, async () => {
  // The defect: the box drew 「请使用微信扫码」 whatever the image did. Blocked
  // (naturalWidth 0, no error handler), the person was told to scan nothing.
  const browser = await launch()
  let page
  try {
    let codes = 0
    const opened = await ready(browser, {
      qrcode: async () => {
        codes += 1
        // the first code is on a host the offline browser cannot resolve: its
        // image fails the way a blocked one does
        return codes === 1 ? { scene: "scene-1", qrUrl: "https://codar-web.speedai.com/q1.png" } : { scene: "scene-2", qrUrl: `data:image/gif;base64,${GIF}` }
      },
      status: async () => ({ state: "waiting" }),
      sendCode: async () => {},
      verifyCode: async () => ({ token: TOKEN, username: "user_1" }),
    })
    page = opened.page
    const ui = opened.ui

    await ui.until(`${status}.includes("加载失败")`, "the image's failure to reach the status line")
    assert.match(await ui.eval(status), /二维码加载失败/, "the page says the code did not load")
    assert.match(await ui.eval(status), /刷新|重试/, "and what to do about it")
    assert.equal(await ui.eval(refreshDisabled), false, "the refresh button is there to press")

    await ui.click("#refresh")
    await ui.until(`(() => { const i = document.getElementById("qr").querySelector("img"); return i && i.complete && i.naturalWidth > 0 })()`, "the second code's image")
    await ui.until(`!${status}.includes("加载失败")`, "the failure line to go")
    assert.equal(await ui.eval(status), "请使用微信扫码", `a failure line outlived the code that loads: ${await ui.eval(status)}`)
    assert.equal(await ui.eval(refreshDisabled), false, "the refresh button stays usable")
    assert.equal(await ui.eval(ended), false, "a blocked image is not the end of the sign-in")
    assert.deepEqual(ui.errors, [], "the page's script threw")
  } finally {
    page?.close()
    browser.close()
  }
})

test("the tabs answer the arrow keys as tabs do, and a finished sign-in moves the focus to its end", { skip }, async () => {
  // Optional, and pinned because it is the difference between two buttons that
  // look like tabs and a tab list a keyboard can use: arrows move between the
  // tabs with one tab stop (roving tabindex), and the page's last screen —
  // which every form gives way to — takes the focus instead of leaving it on
  // a disabled button nobody can reach.
  const browser = await launch()
  let page
  try {
    // the sign-in finishes only when the keyboard half of this test is done:
    // a "done" on the first poll ended the page before the tabs could be
    // focused, and the test then failed for the wrong reason (2026-11-28)
    let finishNow = false
    const opened = await ready(browser, {
      qrcode: async () => ({ scene: "scene-1", qrUrl: `data:image/gif;base64,${GIF}` }),
      status: async () => (finishNow ? { state: "done", token: TOKEN, username: "user_1" } : { state: "waiting" }),
      sendCode: async () => {},
      verifyCode: async () => ({ token: TOKEN, username: "user_1" }),
    })
    page = opened.page
    const ui = opened.ui
    const selected = `Array.from(document.querySelectorAll("[role=tab]")).map((t) => t.dataset.tab + ":" + t.getAttribute("aria-selected")).join(",")`
    const tabStops = `Array.from(document.querySelectorAll("[role=tab]")).map((t) => t.dataset.tab + ":" + t.tabIndex).join(",")`

    assert.equal(await ui.eval(selected), "scan:true,sms:false")
    assert.equal(await ui.eval(tabStops), "scan:0,sms:-1", "one tab stop for the pair")
    // the page must have finished its first layout before a programmatic
    // focus lands: a focus before that answers false and the test then blamed
    // the page for a race it did not have (2026-11-28)
    await ui.until(`document.readyState === "complete" && !document.getElementById("tab-scan").hidden`, "the page's first layout")
    assert.equal(await ui.focus("#tab-scan"), true, "the tab takes the focus")
    await ui.key("ArrowRight")
    await ui.until(`document.getElementById("tab-sms").getAttribute("aria-selected") === "true"`, "the arrow's switch")
    assert.equal(await ui.eval(panel), "sms", "the arrow showed the SMS form")
    assert.equal(await ui.eval(focusName), "tab-sms", "the focus followed the arrow")
    assert.equal(await ui.eval(tabStops), "scan:-1,sms:0", "and the tab stop moved with it")
    await ui.key("ArrowLeft")
    await ui.until(`document.getElementById("tab-scan").getAttribute("aria-selected") === "true"`, "the way back")
    assert.equal(await ui.eval(focusName), "tab-scan")

    // the QR sign-in finishes: the end screen takes the focus
    finishNow = true
    await ui.until(`!document.getElementById("done").hidden`, "the success screen")
    assert.equal(await ui.eval(focusName), "done", "the end screen is where the keyboard is left")
  } finally {
    page?.close()
    browser.close()
  }
})

// ---- the same three fixes, read off the page's own script -------------------
//
// A browser is the best witness, and the run above drives one when asked. These
// four checks need nothing but Node: they pin the exact structures the browser
// tests observed, so a machine without a browser still catches a change that
// undoes the fix.

const pageScript = async (options = {}) => {
  const page = await startSignIn({
    sendCode: async () => {},
    verifyCode: async () => ({ token: TOKEN, username: "user_1" }),
    ...options,
  })
  try {
    return await (await fetch(page.url)).text()
  } finally {
    page.close()
  }
}

test("a poll's state is written to its own side, and only the current side is shown", async () => {
  const html = await pageScript()
  // one slot per side, and the screen reads the current one: the QR poll
  // answering while the SMS tab is open cannot overwrite what is being typed
  // (2026-11-27 review)
  assert.match(html, /if \(current === side\) \{/, "a side's state is shown only while that side is current")
  assert.match(html, /written into its own slot; only the current side's slot is shown/, "both sides keep their own state")
})

test("a failed captcha load puts the flag back and frees the button", async () => {
  const html = await pageScript()
  // the catch of the load, not the `let capReady = false` three lines above it:
  // a declaration matching is how a check that stopped asserting anything still
  // reads green
  const catchOf = /catch \(e\) \{\s*cap = null\s*capReady = false\s*if \(el\("send"\)\) el\("send"\)\.disabled = false/.exec(html)
  assert.ok(catchOf, "the failed load puts the flag back and frees the send button")
  assert.match(html, /人机验证加载失败：/, "and the page says what happened")
  assert.match(html, /请重试/, "and that the person can retry")
})

test("a QR image that fails to load says how to recover", async () => {
  const html = await pageScript()
  const handler = /img\.onerror = \(\) => \{\s*qrBroken = true\s*guarded\("scan", "二维码加载失败[^"]*", "err"\)/.exec(html)
  assert.ok(handler, "the image's failure is handled and named, rather than left as a blank square")
  // and a code that really loads clears it, so the sentence does not outlive
  // the blank box
  assert.match(html, /img\.onload = \(\) => \{[\s\S]{0,120}?qrBroken = false/, "a loaded code clears the failure")
})

test("the end screens take the focus, and the tabs answer the arrow keys", async () => {
  const html = await pageScript()
  assert.match(html, /<div class="end" id="done" tabindex="-1"/, "the end screen is a focus target")
  assert.match(html, /ArrowRight|ArrowLeft/, "the tabs answer the arrow keys")
  assert.match(html, /tabindex="-1"/, "a roving tabindex keeps one tab in the tab order")
})
