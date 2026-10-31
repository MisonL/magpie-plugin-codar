// Regenerate catalog.mjs from Codar's own list. The embedded catalog is the
// list the provider has before the vendor is asked, and the one it keeps when
// GET /v1/codar/models cannot be reached — so it drifts as the vendor adds
// models or changes a model's context window or reply ceiling, and drifts
// silently: nothing at runtime can tell that the fallback is old. Run this
// when Codar adds models (or when a card shows a size the live gateway
// contradicts), read the diff, and commit it.
//
//   node scripts/catalog.mjs            # regenerate from the signed-in app
//   node scripts/catalog.mjs --check    # exit 1 if the file is out of date
//
// The token is read from the app's own config (provider.speedai.token under
// CODAR_HOME, else ~/.codar/config.json), the same one the sign-in reads, and
// is never printed. --check is for CI or a pre-release look: it fetches,
// compares, and says which records moved without writing anything.

import { readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const API = "https://api.claw.speedai.com"
const CATALOG_PATH = "/v1/codar/models"
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "catalog.mjs")
const check = process.argv.includes("--check")

const configPath = () => {
  const home = String(process.env.CODAR_HOME ?? "").trim()
  return join(home || join(homedir(), ".codar"), "config.json")
}

const token = (() => {
  let raw
  try {
    raw = readFileSync(configPath(), "utf8")
  } catch (e) {
    console.error(`读不了 ${configPath()}（${e?.code ?? e.message}）：先在这台机器上登录一次科搭`)
    process.exit(2)
  }
  const t = String(JSON.parse(raw)?.provider?.speedai?.token ?? "").trim()
  if (!t) {
    console.error(`${configPath()} 里没有 provider.speedai.token：先登录一次科搭`)
    process.exit(2)
  }
  return t
})()

// whole is a vendor count as the plugin reads one (index.mjs's tokensOf): a
// positive whole number, else 0 for "not stated". An Infinity or a fraction
// is not a size anyone can plan with.
const whole = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)

const res = await fetch(`${API}${CATALOG_PATH}`, { headers: { Authorization: `Bearer ${token}`, "User-Agent": "node" } })
if (!res.ok) {
  console.error(`GET ${CATALOG_PATH} → HTTP ${res.status}`)
  process.exit(2)
}
const body = await res.json()
const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.catalog?.data) ? body.catalog.data : null
if (!list) {
  console.error("应答里没有 data 数组——厂商换了形状，先核对 index.mjs 的 catalogOf")
  process.exit(2)
}

const rows = []
for (const m of list) {
  if (!m || typeof m !== "object" || Array.isArray(m)) continue
  const id = typeof m.id === "string" ? m.id.trim() : ""
  if (!id) continue
  rows.push({
    id,
    name: typeof m.display_name === "string" && m.display_name.trim() ? m.display_name.trim() : id,
    context: whole(m.context_window),
    maxOutput: whole(m.request_schema?.properties?.max_tokens?.maximum),
    input: Array.isArray(m.input_modalities) ? m.input_modalities : ["text"],
    output: Array.isArray(m.output_modalities) ? m.output_modalities : ["text"],
    protocol: m.protocol?.type === "anthropic_messages" ? "anthropic_messages" : "openai_chat_completions",
    reasoning: Boolean(m.reasoning),
  })
}
rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

const head = `// catalog is Codar's model list as its own client keeps it: the answer to
// GET /v1/codar/models, reduced to what magpie reads (id, name, context,
// maxOutput, modalities, protocol, reasoning) — the vendor's prices stay out
// of it, as the plugin reports none (see README). maxOutput is the reply
// ceiling the vendor's own request schema states (max_tokens.maximum), 0
// where it states none. Kept as the list the provider has before the vendor
// is asked (and when it cannot be reached). Regenerate it with
// \`node scripts/catalog.mjs\` when Codar adds models; \`provider.models\`
// refreshes it live.
export const CATALOG = [
`
const text = head + rows.map((r) => "  " + JSON.stringify(r, null, 2).replace(/\n/g, "\n  ")).join(",\n") + "\n]\n"

if (check) {
  // Compare the records, not the file's bytes: the header comment is prose
  // and may be reworded without the list going stale, while a model whose
  // context or ceiling moved is exactly what this is looking for.
  const parse = (s) => JSON.parse(s.slice(s.indexOf("["), s.lastIndexOf("]") + 1))
  const before = new Map(parse(readFileSync(OUT, "utf8")).map((r) => [r.id, r]))
  const after = new Map(rows.map((r) => [r.id, r]))
  let moved = 0
  for (const [id, r] of after) {
    const b = before.get(id)
    if (!b) (moved++, console.log(`added:   ${id}`))
    else if (JSON.stringify(b) !== JSON.stringify(r)) (moved++, console.log(`changed: ${id}  ${JSON.stringify(b)} → ${JSON.stringify(r)}`))
  }
  for (const id of before.keys()) if (!after.has(id)) (moved++, console.log(`removed: ${id}`))
  if (!moved) {
    console.log(`catalog.mjs is up to date (${rows.length} models)`)
    process.exit(0)
  }
  console.log(`catalog.mjs is out of date (${moved} record(s)): run \`node scripts/catalog.mjs\``)
  process.exit(1)
}

writeFileSync(OUT, text)
console.log(`wrote ${rows.length} models to catalog.mjs`)
