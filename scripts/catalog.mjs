// Regenerate catalog.mjs from Codar's own list. The embedded catalog is the
// list the provider has before the vendor is asked, and the one it keeps when
// GET /v1/codar/models cannot be reached — so it drifts as the vendor adds
// models or changes a model's context window or reply ceiling, and drifts
// silently: nothing at runtime can tell that the fallback is old. Run this
// when Codar adds models (or when a card shows a size the live gateway
// contradicts), read the diff, and commit it.
//
//   node scripts/catalog.mjs            # regenerate from the signed-in app
//   node scripts/catalog.mjs --check    # say which records moved, write nothing
//
// Exit codes, so a caller can tell the two failures apart:
//   0  wrote the list, or the file already is what the vendor says
//   1  --check only: a record moved
//   2  could not read the vendor's answer (or our own files) — nothing was
//      written. This is not "out of date": it is "ask again", and a caller
//      that reads 1 as "regenerate" would regenerate from a failed read.
//
// The token is read from the app's own config (provider.speedai.token under
// CODAR_HOME, else ~/.codar/config.json), the same one the sign-in reads, and
// is never printed.
//
// The records are built by the plugin's own catalogOf, not by a second copy
// of its rules. A copy drifted the day it was written: the live path reads a
// number the vendor writes as a string, folds the control characters out of a
// name, and leaves out an id a request could not ask for — this file did none
// of that, so a regeneration could put a record in the fallback that the live
// path would never serve (and, for an id, one the plugin's own shape test
// rejects).

import { readFileSync, realpathSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const API = "https://api.claw.speedai.com"
const CATALOG_PATH = "/v1/codar/models"
const HERE = dirname(fileURLToPath(import.meta.url))

// OUT_PATH is the list this writes: beside the plugin, not under scripts/.
export const OUT_PATH = join(HERE, "..", "catalog.mjs")

// The file's own header, then the array. Kept verbatim so regenerating a file
// that is already current produces no diff at all.
const HEAD = `// catalog is Codar's model list as its own client keeps it: the answer to
// GET /v1/codar/models, reduced to what magpie reads (id, name, context,
// maxOutput, input, output, protocol, reasoning) — the vendor's prices stay out
// of it, as the plugin reports none (see README). maxOutput is the reply
// ceiling the vendor's own request schema states (max_tokens.maximum), 0
// where it states none. Kept as the list the provider has before the vendor
// is asked (and when it cannot be reached). Regenerate it with
// \`node scripts/catalog.mjs\` when Codar adds models; \`provider.models\`
// refreshes it live.
export const CATALOG = [
`
const KEY = "export const CATALOG ="

// FIELD_ORDER is the shape a record is written in. Written from the fields
// rather than stringified as it came, so the file's key order is this file's
// decision and stays put across a regeneration — `--check` compares values,
// but a stable order keeps the committed diff about the models.
const FIELD_ORDER = ["id", "name", "context", "maxOutput", "input", "output", "protocol", "reasoning"]

const whyOf = (e) => (e instanceof Error ? e.message : String(e ?? ""))

// plugin is loaded once, when it is first needed: the top-level import is what
// this file must not depend on. A published package ships scripts/catalog.mjs
// with internal.mjs beside it, but a run from a checkout where the plugin is not
// resolvable — or a Node that refuses a bare dynamic import of a file beside
// the script — should get the exit code and the sentence, not a module-loader
// stack before main() can say anything.
let plugin = null
const pluginOf = async () => {
  if (!plugin) plugin = (await import(new URL("../internal.mjs", import.meta.url).href)).testables
  return plugin
}

// configPathOf is where the app keeps its own config, the same place the
// plugin's read-from-this-machine sign-in looks (internal.mjs's configPath).
// The value is taken as the app's sidecar takes it: verbatim, not trimmed
// (`CODAR_HOME="  /tmp/x  "` answers `  /tmp/x  /config.json`), with an
// empty value meaning "not set" — a trim here would read a file the app never
// wrote, and would read a different one from the plugin.
export const configPathOf = (env = process.env) => {
  const home = String(env?.CODAR_HOME ?? "")
  return join(home || join(homedir(), ".codar"), "config.json")
}

// recordsOf is a vendor answer as this file's records: the plugin's own
// catalogOf, then one record per id with a later one winning — exactly what
// the runtime's `Object.fromEntries` over the same list leaves in the model
// map. Then the ids that name a property of every object are dropped, as the
// runtime drops them (internal.mjs's noMagicKeys): a record named `__proto__` is
// never served, so a file that carried one would be a fallback the live path
// does not have. null means the answer named no list we could read
// (catalogOf's own "unreadable", not "empty").
export const recordsOf = async (body) => {
  const { catalogOf, magicKeys } = await pluginOf()
  const list = catalogOf(body)
  if (!list) return null
  return [...new Map(list.filter((r) => !magicKeys.has(r.id)).map((r) => [r.id, r])).values()]
}

// sortRows orders by id, so a vendor that reorders its list does not show up
// as a diff. Insertion order is otherwise the vendor's.
export const sortRows = (rows) => [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

const asWritten = (r) => Object.fromEntries(FIELD_ORDER.map((k) => [k, r[k]]))
const line = (r) => "  " + JSON.stringify(asWritten(r), null, 2).replace(/\n/g, "\n  ")

// render is the whole file, header and all.
export const render = (rows) => `${HEAD}${rows.map(line).join(",\n")}\n]\n`

// parseCatalog reads a file back. The literal is ours, so this reads the
// array after the export: a file we did not write is a file we cannot
// compare, and the caller says so rather than guessing.
export const parseCatalog = (text) => {
  const at = String(text).indexOf(KEY)
  if (at < 0) throw new Error("no `export const CATALOG = [` to read")
  const list = JSON.parse(String(text).slice(at + KEY.length).trim())
  if (!Array.isArray(list)) throw new Error("the export is not a list")
  return list
}

// diff is the check's answer: which records moved, compared field by field.
// Field by field and not by the file's bytes: a reordered key or a reworded
// header comment is prose, while a model whose context or ceiling moved is
// exactly what this looks for.
export const diff = (before, after) => {
  const was = new Map(before.map((r) => [r.id, r]))
  const now = new Map(after.map((r) => [r.id, r]))
  const moved = []
  for (const [id, r] of now) {
    const b = was.get(id)
    if (!b) moved.push(`added:   ${id}`)
    else if (FIELD_ORDER.some((k) => JSON.stringify(b[k]) !== JSON.stringify(r[k])))
      moved.push(`changed: ${id}  ${JSON.stringify(asWritten(b))} → ${JSON.stringify(asWritten(r))}`)
  }
  for (const id of was.keys()) if (!now.has(id)) moved.push(`removed: ${id}`)
  return moved
}

// main is the whole run, with its outside world passed in so a test can drive
// it without a network, a signed-in app, or the repository's own catalog.mjs.
// It returns the exit code rather than exiting.
export const main = async ({ argv = process.argv, env = process.env, out = OUT_PATH, fetchImpl = fetch, log = console } = {}) => {
  const check = argv.includes("--check")
  const fail = (message) => {
    log.error(message)
    return 2
  }

  let raw
  try {
    raw = readFileSync(configPathOf(env), "utf8")
  } catch (e) {
    return fail(`读不了 ${configPathOf(env)}（${e?.code ?? e.message}）：先在这台机器上登录一次科搭`)
  }
  let token = ""
  try {
    token = String(JSON.parse(raw)?.provider?.speedai?.token ?? "").trim()
  } catch {
    return fail(`${configPathOf(env)} 不是 JSON：先在这台机器上登录一次科搭`)
  }
  if (!token) return fail(`${configPathOf(env)} 里没有 provider.speedai.token：先登录一次科搭`)

  let rules
  try {
    rules = await pluginOf()
  } catch (e) {
    // internal.mjs itself could not be loaded (no plugin beside this script, or
    // its own catalog.mjs missing): without the plugin's rules there is no
    // token to check and no record to build, so this is a read failure —
    // never "out of date".
    return fail(`读不了插件的目录规则（${whyOf(e)}）：确认 internal.mjs 和 catalog.mjs 都在这份脚本旁边`)
  }
  // The sign-in's own gate (internal.mjs's tokenOf): a token with a newline, a
  // NUL or anything else that is not visible ASCII cannot go in a header, and
  // fetch refuses one by quoting the whole header — the token — in its error,
  // which this script would then print. Refused here, before it is sent.
  const sent = rules.tokenOf({ type: "api", key: token })
  if (!sent) return fail(`${configPathOf(env)} 里的令牌含空格、换行或非 ASCII 字符，发不出去：打开一次科搭重新登录`)

  let body
  try {
    const res = await fetchImpl(`${API}${CATALOG_PATH}`, { headers: { Authorization: `Bearer ${sent}`, "User-Agent": "node" } })
    if (!res.ok) return fail(`GET ${CATALOG_PATH} → HTTP ${res.status}`)
    // 用插件自己的有上限读法（internal.mjs 的 readAnswer）：它边读流边计数，
    // 超过 MAX_ANSWER_BYTES 就放弃。res.json() 会把整份应答先收进内存，无论
    // 多大——和插件在钩子里踩过的坑是同一个。开头的 BOM 也照 request() 去掉：
    // JSON.parse 遇到它会把整份应答判成不是 JSON。
    const { text } = await rules.readAnswer(res)
    body = JSON.parse(text.replace(/^\uFEFF/, ""))
  } catch (e) {
    // a thrown fetch and an unparseable body are the same failure: the vendor
    // did not answer with a list, so there is nothing here to compare. The
    // token is cut from what is said, in case an error names it anyway.
    // 按形状切，不只按这把令牌精确切：服务器可能把令牌折行、插空格，或只回显
    // payload 段地引回来，精确子串匹配挡不住（见 internal.mjs 的 jwtShape）。
    return fail(`GET ${CATALOG_PATH} 没读成（${rules.scrubLine(whyOf(e), sent)}）：这是取数的失败，不是目录过时`)
  }

  const rows = await recordsOf(body)
  if (!rows) return fail("应答里没有一份读得出的模型列表：厂商可能换了形状（先核对 internal.mjs 的 catalogOf），也可能是一次故障")
  // The file is the fallback for the plugin, not one account's answer, and it
  // is committed. An answer that names no models is not allowed to empty it.
  if (!rows.length) return fail("厂商这次答了 0 个模型：这份目录是所有人的回退，不拿一次的答案把它清空（确认后手动改 catalog.mjs）")

  const sorted = sortRows(rows)

  if (!check) {
    try {
      writeFileSync(out, render(sorted))
    } catch (e) {
      return fail(`写不了 ${out}（${whyOf(e)}）`)
    }
    log.log(`wrote ${sorted.length} models to catalog.mjs`)
    return 0
  }

  let before
  try {
    before = parseCatalog(readFileSync(out, "utf8"))
  } catch (e) {
    return fail(`读不了 ${out}（${whyOf(e)}）：目录文件本身有问题，不是它过时`)
  }

  const moved = diff(before, sorted)
  if (!moved.length) {
    log.log(`catalog.mjs is up to date (${sorted.length} models)`)
    return 0
  }
  for (const m of moved) log.log(m)
  log.log(`catalog.mjs is out of date (${moved.length} record(s)): run \`node scripts/catalog.mjs\``)
  return 1
}

// only when run as the script: imported by the test suite, this must not
// reach for a token or exit. Compared by real path on both sides: a checkout
// reached through a symlink (macOS's /tmp is one) gives argv[1] and
// import.meta.url two spellings of the same file, and a plain string compare
// read that as "imported" — the script then did nothing and exited 0.
const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (isMain) process.exitCode = await main()
