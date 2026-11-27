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
//   2  could not read the vendor's answer or our own files, could not write
//      catalog.mjs, or was given an argument it does not know — nothing
//      usable came of the run. This is not "out of date": it is "ask again",
//      and a caller that reads 1 as "regenerate" would regenerate from a
//      failed read.
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

import { readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))

// OUT_PATH is the list this writes: beside the plugin, not under scripts/.
export const OUT_PATH = join(HERE, "..", "lib", "catalog.mjs")

// The file's own header, then the array. Kept verbatim so regenerating a file
// that is already current produces no diff at all.
const HEAD = `// catalog is Codar's model list as its own client keeps it: the answer to
// GET /v1/codar/models, reduced to what magpie reads (id, name, context,
// maxOutput, input, output, protocol, reasoning, rate). rate is the vendor's
// own credit multiple (rate_badge, "0.20x"), shown by magpie beside the
// model; the vendor's prices in CNY stay out of it, as magpie's cost column is
// US dollars (see README). maxOutput is the reply ceiling the vendor's own
// request schema states (max_tokens.maximum), 0 where it states none. Kept as
// the list the provider has before the vendor is asked (and when it cannot be
// reached). Regenerate it with \`node scripts/catalog.mjs\` when Codar adds
// models; \`provider.models\` refreshes it live.
export const CATALOG = [
`
const KEY = "export const CATALOG ="

// FIELD_ORDER is the shape a record is written in. Written from the fields
// rather than stringified as it came, so the file's key order is this file's
// decision and stays put across a regeneration — `--check` compares values,
// but a stable order keeps the committed diff about the models.
const FIELD_ORDER = ["id", "name", "context", "maxOutput", "input", "output", "protocol", "reasoning", "rate"]

const whyOf = (e) => (e instanceof Error ? e.message : String(e ?? ""))
// quiet says an error message with the home directory shortened: a file-system
// error quotes the absolute path it failed on, and this script's messages go
// into terminal scrollback and CI logs (internal.mjs's shownPath shortens the
// paths this script names itself; this covers the ones an exception brings).
const quiet = (e) => whyOf(e).split(homedir()).join("~")
// safeWhy is an exception's message with any credential-shaped text cut and
// the home directory shortened, for the messages that print one (a parse
// error quotes the text it choked on).
const safeWhy = (said) => said.replace(/eyJ[A-Za-z0-9_-]{8,}(?:[.][A-Za-z0-9_-]{4,}){0,2}/g, "…")
// controlCharsShown is every control character, written as a space where a
// printed record shows one: the fold a JSON escape stood for becomes a
// separator the shape rules already know.
const controlCharsShown = /[\u0000-\u001f\u007f-\u009f]/g

// plugin is loaded once, when it is first needed: a top-level import is what
// this file must not depend on. A published package ships scripts/catalog.mjs
// with internal.mjs beside it, but a run from a checkout where the plugin is
// not resolvable should get the exit code and the sentence, not a
// module-loader stack before main() can say anything.
let plugin = null
const pluginOf = async () => {
  if (!plugin) plugin = (await import(new URL("../lib/internal.mjs", import.meta.url).href)).testables
  return plugin
}
// guard is the plugin's own fallback fetch (lib/guarded.mjs), loaded the same
// lazy way: the fallback must not follow a redirect off the vendor any more
// than the plugin's request() may.
let guard = null
const guardOf = async () => {
  if (!guard) guard = (await import(new URL("../lib/guarded.mjs", import.meta.url).href)).guardedFetch
  return guard
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

// asWritten is a record the way the file holds it: rate is written only when
// the vendor states one (0 is "not listed"), so a model the vendor badges
// today and stops badging tomorrow reads as changed, not as a 0 written into
// the file.
const asWritten = (r) => Object.fromEntries(FIELD_ORDER.filter((k) => !(k === "rate" && !r[k])).map((k) => [k, r[k]]))
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
  // Every element has to be a record: a list that parses but holds a null
  // used to reach diff() and throw out of the run with exit 1 — the code that
  // means "a record moved, regenerate" — over a file this script cannot read.
  if (list.some((r) => !r || typeof r !== "object" || Array.isArray(r) || typeof r.id !== "string")) throw new Error("a record in the list is not a model record")
  // A field this script does not write is a hand edit — or an old run's
  // debug field carrying whatever the vendor said — and `--check` comparing
  // only the fields it knows would call the file up to date with it in place.
  if (list.some((r) => Object.keys(r).some((k) => !FIELD_ORDER.includes(k)))) throw new Error("a record carries a field this catalog does not have")
  // A rate written as 0 or a non-number is not a rate this script writes.
  if (list.some((r) => "rate" in r && !(typeof r.rate === "number" && Number.isFinite(r.rate) && r.rate > 0))) throw new Error("a record's rate is not a positive number")
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
    // compared as the file would hold them: a model with no rate is equal to
    // a record with no rate key, not to one carrying 0.
    else if (FIELD_ORDER.some((k) => JSON.stringify(asWritten(b)[k]) !== JSON.stringify(asWritten(r)[k])))
      moved.push(`changed: ${id}  ${JSON.stringify(asWritten(b))} → ${JSON.stringify(asWritten(r))}`)
  }
  for (const id of was.keys()) if (!now.has(id)) moved.push(`removed: ${id}`)
  return moved
}

// main is the whole run, with its outside world passed in so a test can drive
// it without a network, a signed-in app, or the repository's own catalog.mjs.
// It returns the exit code rather than exiting.
export const main = async ({ argv = process.argv, env = process.env, out = OUT_PATH, fetchImpl = fetch, nativeFetch = null, timeoutMs = 15000, log = console } = {}) => {
  const fail = (message) => {
    log.error(message)
    return 2
  }
  // Only --check is an option. Anything else — a typo like --chek — stops the
  // run instead of quietly doing the default write: the default writes
  // catalog.mjs, and a read-only check that was meant is not a regeneration.
  const options = argv.slice(2)
  const unknown = options.filter((a) => a !== "--check")
  if (unknown.length) return fail(`unrecognized argument: ${unknown.join(" ")} (only --check is accepted)`)
  const check = options.includes("--check")

  let rules
  try {
    rules = await pluginOf()
  } catch (e) {
    // internal.mjs itself could not be loaded (no plugin beside this script, or
    // its own catalog.mjs missing): without the plugin's rules there is no
    // token to check and no record to build, so this is a read failure --
    // never "out of date".
    return fail(`cannot read the plugin's catalog rules (${quiet(e)}): make sure lib/internal.mjs and lib/catalog.mjs are both in the package`)
  }
  // the path as the sign-in dialog says it: under the home directory the
  // account name is not written out (internal.mjs's shownPath). This script's
  // messages end up in terminal scrollback and CI logs just as a dialog does.
  // a path can carry a credential-shaped segment too (CODAR_HOME is read
  // verbatim); the shape rules blank it like any other line this script says
  const shown = rules.scrubShapes(rules.shownPath(configPathOf(env)), "")
  // every path this script prints goes through the same shortening: a release
  // run's scrollback and CI logs carry the account name otherwise
  const shownOut = rules.scrubShapes(rules.shownPath(out), "")

  let raw
  try {
    // the plugin's own bounded read: a FIFO would block, and a runaway file
    // would be pulled into this process whole — the config is the app's, but
    // a damaged one must fail the same way in both readers.
    raw = rules.readConfigText(configPathOf(env))
  } catch (e) {
    // a missing file and an unreadable one are different fixes: "sign in once"
    // does not repair a permission problem
    if (e?.code === "ENOENT") return fail(`cannot read ${shown} (${e?.code}): sign in once on this machine first`)
    if (e?.code === "EFBIG") return fail(`${shown} is larger than ${rules.MAX_CONFIG_BYTES / 1024 / 1024} MiB: this is not Codar's config; sign in once on this machine first`)
    if (e?.code === "EFTYPE") return fail(`${shown} is not a regular file: this is not Codar's config; sign in once on this machine first`)
    if (e?.code === "EAGAIN") return fail(`${shown} changed while it was being read: run this again`)
    return fail(`cannot read ${shown} (${e?.code ?? e.message}): check the file permissions; this is not an out-of-date catalog`)
  }
  let token = ""
  try {
    // a config written on Windows may carry a BOM, and JSON.parse refuses the
    // whole file over it -- the same reason the network answer is stripped.
    token = String(JSON.parse(raw.replace(/^\uFEFF/, ""))?.provider?.speedai?.token ?? "").trim()
  } catch {
    return fail(`${shown} is not JSON: sign in once on this machine first`)
  }
  if (!token) return fail(`${shown} has no provider.speedai.token: sign in once on this machine first`)

  // The sign-in's own gate (internal.mjs's tokenOf): a token with a newline, a
  // NUL or anything else that is not visible ASCII cannot go in a header, and
  // fetch refuses one by quoting the whole header -- the token -- in its error,
  // which this script would then print. Refused here, before it is sent.
  const sent = rules.tokenOf({ type: "api", key: token })
  if (!sent) return fail(`the token in ${shown} has spaces, newlines or non-ASCII characters and cannot be sent: open Codar and sign in again`)
  // a token that names no account or has run out cannot fetch a list either;
  // said here, before the request, as the sign-in itself says it.
  if (!rules.usernameOf(sent)) return fail(`the token in ${shown} has no account name: open Codar and sign in again`)
  if (rules.expired(sent)) return fail(`the token in ${shown} has expired: open Codar to let it renew, then try again`)

  let body
  try {
    // a vendor that accepts the connection and never answers must not hang
    // the script. 15 s is this CLI's own budget (timeoutMs, so a test can
    // prove the signal is what aborts it); the body race below uses the same
    // budget, so a vendor that sends headers and then stalls holds the run for
    // two budgets at most. The plugin's hooks keep TIMEOUT_MS (8 s) because
    // magpie's deadlines are theirs, which a one-shot script does not share.
    // The address and the User-Agent are the plugin's own (internal.mjs's API,
    // CATALOG_PATH and UA_DESKTOP), not a second copy: when the vendor moves the
    // gateway or the plugin changes how it identifies itself, the generator must
    // follow in the same commit, not keep asking an old host.
    const ask = (nativeFetch ?? (async () => { throw Object.assign(new Error("no native transport"), { name: "NativeUnavailable" }) }))(
      `${rules.API}${rules.CATALOG_PATH}`,
      { headers: { Authorization: `Bearer ${sent}`, "Content-Type": "application/json", "User-Agent": rules.UA_DESKTOP }, signal: AbortSignal.timeout(timeoutMs) },
    )
    // The desktop transport first, when this run has one: the gateway answers a
    // Go client the way it answers the Codar app, and a maintainer's plain fetch
    // is the fingerprint the plugin exists to avoid. No binary, a host the proxy
    // will not forward, a proxy that could not start: the ordinary fetch, as the
    // plugin's own request() falls back — the guarded one, which reads a
    // redirect off the vendor's origin as the answer instead of following it.
    const res = await ask.catch(async (e) => {
      if (e?.name !== "NativeUnavailable") throw e
      const guarded = await guardOf()
      return guarded(`${rules.API}${rules.CATALOG_PATH}`, { headers: { Authorization: `Bearer ${sent}`, "User-Agent": rules.UA_DESKTOP }, signal: AbortSignal.timeout(timeoutMs) }, { transport: fetchImpl })
    })
    // The signal only stops the response headers from hanging. A vendor that
    // sends headers and then goes quiet would still hold the run for ever
    // while readAnswer waits on the body, so the body is raced against the
    // same budget. The timer is cleared on both paths, so a finished run does
    // not keep the process alive.
    let timer
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => {
        res.body?.cancel?.().catch(() => {})
        reject(new Error(`no complete answer from the vendor within ${timeoutMs / 1000} s`))
      }, timeoutMs)
    })
    // The status is checked before the body is read: a refusal's body is not
    // an answer we would use, and on a runtime whose body stream throws for a
    // non-2xx status (the browser/Electron shape) reading it first turned a
    // plain "HTTP 500" into "could not be read ... this is a failed fetch".
    // A refusal's body is cancelled rather than drained.
    if (!res.ok) {
      clearTimeout(timer)
      res.body?.cancel?.().catch(() => {})
      return fail(`GET ${rules.CATALOG_PATH} → HTTP ${res.status}`)
    }
    let text
    try {
      ;({ text } = await Promise.race([rules.readAnswer(res), expired]))
    } finally {
      clearTimeout(timer)
    }
    // Use the plugin's own bounded read (internal.mjs's readAnswer): it counts
    // as it consumes the stream and gives up past MAX_ANSWER_BYTES. res.json()
    // holds the whole answer in memory first, however large — the same trap the
    // plugin hit in its hooks. A leading BOM is stripped as request() does:
    // JSON.parse rejects the whole answer as not JSON when it carries one.
    body = JSON.parse(text.replace(/^\uFEFF/, ""))
  } catch (e) {
    // a thrown fetch and an unparseable body are the same failure: the vendor
    // did not answer with a list, so there is nothing here to compare. The
    // token is cut from what is said, in case an error names it anyway.
    // Cut by shape, not only by exact substring of this token: a server may
    // fold the token across lines, insert spaces, or quote back only its
    // payload segment, which an exact substring match cannot catch (see
    // internal.mjs's jwtShape).
    // The plugin's own size guard says its refusal in the user's language (the
    // card is Chinese); this script's terminal is English like the rest of the
    // project's prose, so the one message it can inherit is restated here.
    const why = e?.code === "answer_too_large"
      ? `the vendor's answer was larger than the plugin's ${rules.MAX_ANSWER_BYTES / 1024 / 1024} MB cap`
      : rules.scrubLine(whyOf(e), sent)
    return fail(`GET ${rules.CATALOG_PATH} could not be read (${why}): this is a failed fetch, not an out-of-date catalog`)
  }

  // The vendor's fields are written into a committed file and printed by
  // --check, so a credential echoed back in one of them is cut here, by the
  // key it is (shape rules would mangle a legitimate long id): a hostile or
  // compromised gateway must not put the account's token into the repository.
  // The cut is the plugin's own (cutKey): a gateway that wraps the token
  // every 20 characters, or folds a control into it, leaves no contiguous
  // copy for `split` to find, and the remainder is still a working key.
  // every string the answer carried, in the order it was read: the encoded
  // echo is judged over the whole answer (see encodedHit below), and this
  // keeps the original before cutEncoded has had its way with it.
  const read = []
  const withoutToken = (v, depth = 0) => {
    if (typeof v === "string") {
      read.push(v)
      return rules.cutKey(v, sent)
    }
    if (!v || typeof v !== "object") return v
    // A branch nested past this is not a model record. Cut it whole rather
    // than hand it on raw: returning `v` untouched at the cap is the one
    // path a credential could travel (a hostile catalog can nest it).
    if (depth > 64) return "…"
    if (Array.isArray(v)) return v.map((x) => withoutToken(x, depth + 1))
    // Keys are scrubbed too, not only values: an object key the vendor echoes
    // back ({"<token>": "text"} inside a modalities array, say) is written
    // into the committed catalog exactly as a value would be.
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [rules.cutKey(k, sent), withoutToken(x, depth + 1)]))
  }
  const scrubbed = withoutToken(body)
  const made = await recordsOf(scrubbed)
  if (!made) return fail("no readable model list in the answer: the vendor may have changed the shape (check internal.mjs's catalogOf first), or this may be a transient failure")
  // An id the cut had to change is an id no request could ask for: the live
  // path (catalogOf, given the key) drops such a record, and a fallback that
  // carried "model-…" would be a record the live list does not have, under an
  // id the gateway never named. catalogOf is called here without the key (the
  // cut is done above), so its own "an id that changed is dropped" check never
  // fires. The renamed ids are exactly those carrying the ellipsis cutKey
  // writes; a record whose id holds one is left out, so both paths build the
  // same list. Names may legitimately carry "…" (a vendor's own truncation),
  // so only the id is judged.
  // And a string the shape rules would change — another provider's key
  // (`sk-…`, a Bearer token), a JWT of an earlier sign-in — is not one the
  // fallback carries: catalogOf ran without the key on this path (the cut
  // was done above), so its own shape gate could not fire.
  // (read as JSON.parse reads the file: a literal \n between the characters
  // of a folded token is one line to the shape rules then)
  // A string is judged as the file's parser reads it and as it was read (an
  // escape a folded token hides behind), for the key and for shapes; an id
  // the token cut changed is not an id; and every record's strings are then
  // read together — pieces narrower than a window, each with a label of its
  // own, leave no run in any record but the pieces in order are the key
  // (internal.mjs's splitAcross). A drop is counted, so a file left with
  // nothing can say which of the two emptied it.
  const asRead = (said) => JSON.parse(JSON.stringify([String(said ?? "")]))[0]
  const idCut = (r) => String(r.id).includes("…") || cutOf(r.id)
  const nameCut = (r) => r.name !== "…" && cutOf(r.name)
  function cutOf(said) {
    const text = String(said ?? "")
    return rules.echoesIn([asRead(text), text], sent)
  }
  const kept = made.filter((r) => !idCut(r) && !nameCut(r))
  // the pieces read both in file order and in the order the vendor wrote
  // them: a split follows whichever order it was built in.
  const stringsOf = (rows, field) => rows.flatMap((r) => [asRead(r[field] ?? ""), String(r[field] ?? "")])
  // An encoded split (`%XX` or base32 pieces) only reads as the token once
  // the pieces are put back together and decoded, and a `%XX` triple the
  // joining spaces fall into still lines up with them taken out
  // (spelledCarriesAcross reads every one of those spellings).
  // A split can also alternate between the two fields, one piece an id and
  // the next a name: the vendor order and the file order are both read whole,
  // id and name of a record in turn, when neither field alone spells the token.
  const alternated = (rows) => rows.flatMap((r) => [asRead(r.id ?? ""), asRead(r.name ?? "")])
  const together =
    ["id", "name"].some((field) => {
      const said = stringsOf(made, field)
      return rules.splitAcross(said, sent) || rules.spelledCarriesAcross(said.join(""), sent) || rules.splitFields(said, sent)
    }) ||
    [alternated(made), alternated([...made].sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0)))].some(
      (pairs) => rules.splitAcross(pairs, sent) || rules.splitFields(pairs, sent),
    )
  const renamed = made.length - kept.length
  const rows = together ? [] : kept
  // The file is the fallback for the plugin, not one account's answer, and it
  // is committed. An answer that names no models is not allowed to empty it.
  if (!rows.length && (renamed || together)) return fail("the vendor's answer carried part of the account token in a shape that could not be cut: nothing is written; check the gateway's answer")
  if (!rows.length) return fail("the vendor answered with 0 models this time: this catalog is everyone's fallback, so one answer must not empty it (edit catalog.mjs by hand once confirmed)")

  const sorted = sortRows(rows)

  const outText = render(sorted)
  // The last gate: no part of the token reaches the file in any shape. The
  // cut above is by the key, and a gateway can split the token across fields
  // or fold it with a character the fold walk does not know. Every 6-character
  // window of the token is looked for in the haystacks' flattened form, so a
  // 7-character piece (or a 6-character piece that lines up with a window)
  // is caught. A string that is pure base64 and decodes to a key-bearing run
  // is caught too. The four haystack shapes mirror those the projection-based
  // cut in internal.mjs catches for messages: each object's own strings joined
  // in key order, each property's strings joined across the whole answer, the
  // file's own insertion order (id-sorted) per record, and the names in id
  // order.
  const flat = (v) => rules.flatten(String(v)).replace(/[^A-Za-z0-9_-]/g, "")
  const windows = rules.windowsOf(sent)
  if (!windows.size) throw new Error("windowsOf returned no windows; the gate would pass every key")
  const hW = rules.WINDOWS_OF
  const haystacks = [flat(outText)]
  const collect = (v) => {
    if (typeof v === "string") haystacks.push(flat(v))
    else if (Array.isArray(v)) v.forEach(collect)
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { haystacks.push(flat(k)); collect(x) }
  }
  sorted.forEach(collect)
  // Encoded: every value in the order the file carries it (the id-sorted
  // records, field by field) joined into blocks of 16+ characters made only
  // of base64url signs. A token encoded and cut into pieces — one per record,
  // with punctuation between them, or one span with its characters spread —
  // decodes back to the token once the pieces are put together again, and
  // neither the window scan nor the cut sees it. Large answers are read up
  // to a cap: the catalog's own answers are kilobytes.
  // The strings are read twice: once as the vendor wrote them, in the
  // order it wrote them, joined into runs (a token encoded and cut into
  // pieces one per record, or a span spread with punctuation between its
  // characters, decodes back to the token); and once after the token cut,
  // where a run that still decodes to a key-bearing text was hidden from
  // cutKey and must stop the write.
  // Runs of letters and digits long enough to be a credential encoded: a fold
  // breaks an encoding into dozens of short runs, each too short for the
  // detector, and the sequence of them is the encoding again.
  const joined = (text) => {
    const runs = text.match(/[A-Za-z0-9+/_-]{12,}/g) ?? []
    const small = text.match(/(?:[A-Za-z0-9+/_-]+[\s:{},;|]{1,24})+[A-Za-z0-9+/_-]*/g) ?? []
    return [...runs, ...small.map((run) => run.replace(/[^A-Za-z0-9+/_-]/g, ""))]
  }
  const encodedHit = () => {
    const failed = (text) => {
      const blob = text.slice(0, 256 * 1024)
      // the whole answer, read the ways it may be spelled (percent-encoded
      // bytes, base32, a JSON escape) before it is cut into runs
      if (rules.spelledCarriesKey(blob, sent)) return true
      return joined(blob).some((run) => rules.decodedCarriesKey(run, sent) || rules.hexCarriesKey(run, sent) || rules.encodedRun(run, sent))
    }
    if (failed(read.join(""))) return true
    let cut = ""
    for (const r of sorted) for (const v of Object.values(r)) cut += typeof v === "string" ? v : ""
    return failed(cut)
  }
  // A split can also put every piece in a different field, each shorter than
  // one window: neither cutKey nor a per-field scan sees it, but the pieces
  // are the token in order. Four reassemblies cover the shapes:
  // each object's own strings joined in key order, each property name's
  // strings joined across the whole answer, and — in the order the committed
  // file actually carries them — each record's strings joined in file field
  // order, and the records' names joined in id order. The last two are the
  // reader's order: the file is written id-sorted, so a split whose pieces
  // follow that order reassembles from the file itself whatever order the
  // vendor's array was in (a reversed array used to walk the byName join
  // backwards). The raw (scrubbed) answer is traversed for the vendor-order
  // joins because that is the order a split follows there.
  const byName = new Map()
  const walk = (v) => {
    if (!v || typeof v !== "object") return
    if (!Array.isArray(v)) {
      const own = []
      for (const [k, x] of Object.entries(v)) {
        if (typeof x !== "string") continue
        own.push(x)
        byName.set(k, (byName.get(k) ?? "") + x)
      }
      if (own.length) haystacks.push(flat(own.join("")))
    }
    for (const x of Object.values(v)) walk(x)
  }
  walk(scrubbed)
  for (const joined of byName.values()) haystacks.push(flat(joined))
  const inFileOrder = (r) => FIELD_ORDER.map((k) => (typeof r[k] === "string" ? r[k] : "")).join("")
  haystacks.push(flat(sorted.map(inFileOrder).join("")))
  haystacks.push(flat(sorted.map((r) => (typeof r.name === "string" ? r.name : "")).join("")))
  const leaks = haystacks.some((h) => {
    for (let i = 0; i + hW <= h.length; i++) if (windows.has(h.slice(i, i + hW))) return true
    return false
  })
  if (leaks)
    return fail("the vendor's answer carried part of the account token in a shape that could not be cut: nothing is written; check the gateway's answer")
  // Base64: a name that is pure base64 and decodes to a key-bearing run is
  // the encoded token. catalogOf blanks it only when it is given the key; the
  // generator's recordsOf calls it without one, so the answer is a name the
  // file would carry verbatim while the gate (reading the literal text) sees
  // no run of the key. A decoded hit is a leak like any other.
  const decoded = (r) => rules.decodedCarriesKey(r?.name, sent)
  if (sorted.some(decoded) || encodedHit())
    return fail("the vendor's answer carried part of the account token in a shape that could not be cut: nothing is written; check the gateway's answer")

  // A record whose context the vendor did not state is not written. Every
  // model the vendor lists today states a context window, so a zero means the
  // field moved (renamed, or answered as null) — and writing it would ship a
  // fallback whose model has no window at all, where the committed file has
  // the last real figure. readAnswer refused a body it could not finish; this
  // refuses an answer it could finish but cannot read, the same "ask again".
  // The ids are named to make the answer diagnosable, but only ids that the
  // credential shapes leave alone: this diagnostic prints before anything is
  // written, and a token split the gate could not reassemble may still sit in
  // one of them.
  const shownId = (id) => {
    const kept = rules.scrubShapes(id, sent)
    return kept === id ? id : "…"
  }
  const windowless = sorted.filter((r) => !(r.context > 0)).map((r) => r.id)
  if (windowless.length) return fail(`the vendor gave no context_window for ${windowless.slice(0, 3).map(shownId).join(", ")} this time: the field looks changed, not the catalog out of date; check internal.mjs's catalogOf, nothing is written`)

  if (!check) {
    // Written beside the file and renamed into place: a write that fails
    // partway (ENOSPC, EFBIG, an interrupted run) used to leave catalog.mjs
    // truncated — a committed file the plugin imports and the suite parses.
    // The name carries the pid and random bytes, and `wx` refuses a path that
    // already exists: a predictable `<out>.<pid>.tmp` let another process in
    // the same directory pre-create it as a symlink, so the write landed in
    // that file and the rename put the symlink at catalog.mjs's name.
    const tmp = `${out}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
    try {
      writeFileSync(tmp, outText, { flag: "wx" })
      renameSync(tmp, out)
    } catch (e) {
      try {
        unlinkSync(tmp)
      } catch {}
      return fail(`cannot write ${shownOut} (${quiet(e)})`)
    }
    log.log(`wrote ${sorted.length} models to catalog.mjs`)
    return 0
  }

  let before
  try {
    before = parseCatalog(readFileSync(out, "utf8"))
  } catch (e) {
    // A parse error can quote the input it choked on (a JWT prefix with no
    // quotes around it, say): the message is scrubbed like every other line
    // this script prints, by shape and without the current token.
    return fail(rules.scrubShapes(`cannot read ${shownOut} (${safeWhy(quiet(e))}): the catalog file itself is broken, not out of date`, sent))
  }

  // A record's values as the file's own parser reads them: every character a
  // JSON escape stands for written back out (a token folded with \u0000 or
  // \b between its characters is one line to the shape rules then, as it is
  // to JSON.parse). The controls become spaces, so the fold is what the
  // shape pass's INVISIBLE_BETWEEN rule knows.
  const asParsed = (r) => Object.fromEntries(FIELD_ORDER.map((k) => [k, typeof r[k] === "string" ? JSON.parse(JSON.stringify([r[k]]))[0].replace(controlCharsShown, " ") : r[k]]))
  const beforeShown = before.map(asParsed)
  const moved = diff(beforeShown, sorted)
  if (!moved.length) {
    log.log(`catalog.mjs is up to date (${sorted.length} models)`)
    return 0
  }
  // The lines are the check's answer, and they are the pieces too: each
  // record's id and name are printed whole, one line after another, and a
  // token split across records reassembles from them. Read the file's own
  // values as one list before printing any line; a split (encoded or not,
  // `%XX` triples cut by the line boundaries included) is not printed at all.
  // A value the shape rules cut on its own is printed scrubbed ("…"), not
  // put back together with its neighbours.
  // A value that carries the token whole is printed scrubbed ("…") and is no
  // part of a reassembly; a value the shape rules merely shorten (a long run
  // of one letter is a shape, not this token) still prints its opening, and a
  // piece of a split is one of those.
  const printable = (v) => {
    const text = String(v ?? "")
    return !rules.echoesKey(text, sent) && !rules.spelledCarriesAcross(text, sent)
  }
  // the lines are read in file order, and a reader can also put them back in
  // the order their ids number (m0, m1, m10 by number, not by letters): both
  // orders are read before anything is printed.
  // the order a reader can restore: by the number their ids carry, and by a
  // number written beside the piece in the other field (a split that labels
  // its pieces "ordinary-3", "filler-4" numbers its own order there).
  const natural = [...beforeShown].sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }))
  const orders = [beforeShown, natural]
  // A split can also alternate between a record's id and its name: each pair
  // in turn is read whole too.
  const paired = (rows) => rows.flatMap((r) => [String(r.id ?? ""), String(r.name ?? "")]).filter(printable)
  // A split in any order: what no order can hide is the pieces' own
  // three-character runs. Each value's runs that are the spelling's runs are
  // collected (no offset guessed — a short run repeats), and three or more
  // values covering most of the spelling are the split, whatever numbering
  // the fields carry. The percent reading is taken twice, with the `%` marks
  // and without them (the characters percentDecode reads as one); the runs
  // that cross a piece's boundary are lost to every split, so "most" is
  // measured with that loss in mind.
  const spellings = [sent.replace(/[^A-Za-z0-9._-]/g, ""), rules.base32Of(sent), rules.percentOf(sent)]
  const readings = (spelling) => (spelling.startsWith("%") ? [[spelling, false], [spelling.replace(/%/g, ""), true]] : [[spelling, false]])
  const spellingRuns = (spelling) => {
    const set = new Set()
    for (let i = 0; i + 3 <= spelling.length; i++) set.add(spelling.slice(i, i + 3))
    return set
  }
  const coversSplit = (values) => {
    for (const original of spellings) {
      for (const [spelling, bare] of readings(original)) {
        const runs = spellingRuns(spelling)
        const seen = new Set()
        let contributors = 0
        for (const value of values) {
          const text = bare ? String(value ?? "").replace(/%/g, "") : String(value ?? "")
          let own = false
          for (let i = 0; i + 3 <= text.length; i++) {
            const run = text.slice(i, i + 3)
            if (!runs.has(run)) continue
            own = true
            seen.add(run)
          }
          if (own) contributors++
        }
        if (contributors < 3) continue
        if (seen.size >= runs.size * 0.6) return true
      }
    }
    return false
  }
  const spill = orders.some(
    (rows) =>
      ["id", "name"].some((field) => {
        const said = rows.map((r) => String(r[field] ?? "")).filter(printable)
        return said.length > 1 && (rules.splitAcross(said, sent) || rules.spelledCarriesAcross(said.join(""), sent) || rules.splitFields(said, sent))
      }) ||
      coversSplit(paired(rows)),
  )
  if (spill) return fail(`the catalog file carries part of the account token in a shape that could not be cut: nothing is printed; regenerate it only from a trusted answer`)
  // The old file's values are printed as JSON.parse read them (a catalog
  // regenerated before the token cut existed, or one a hand edit put a
  // credential into, would otherwise put it in the terminal and in CI logs).
  // The line is scrubbed by shape, not only by the current token: a stale JWT
  // from an earlier sign-in is not this token, and its characters folded with
  // a separator are put back together by cutKey/credentialSpan only when no
  // key is passed — passing this one made the shape-only path unreachable.
  for (const m of moved) log.log(rules.scrubShapes(rules.scrubShapes(m, ""), sent))
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
if (isMain) {
  try {
    // The desktop transport is part of this package but not a dependency of
    // this run: a tree holding scripts/catalog.mjs without native.mjs (a
    // partial copy, an older checkout) still generates, on plain fetch. A
    // failure to load it must not pre-empt main's own diagnosis of what is
    // missing.
    const { proxyFetch } = await import("../lib/native.mjs").catch(() => ({ proxyFetch: null }))
    process.exitCode = await main({ nativeFetch: proxyFetch })
  } catch (e) {
    // An uncaught throw is a read failure, never "the catalog moved": 1 tells
    // a caller to regenerate, 2 tells it to ask again. The message is the
    // shortened form, not a stack that quotes this machine's paths.
    console.error(quiet(e))
    process.exitCode = 2
  }
}
