// native-packages.mjs: the platform packages the five proxy builds ship in.
//
// One package per build, not five builds in one package. The proxy is a static
// Go binary about 6 MB each, and every install of the old single package
// carried all five — 32.0 MB unpacked (npm 12.2.1, 0.2.4) — while one of them
// is ever run. Each platform's build now travels in its own package —
// magpie-plugin-codar-<os>-<cpu>, with os and cpu spelled the way npm and bun
// match them (see native/binary-name.mjs) — and the main package names all
// five in optionalDependencies, so a package manager installs the one that
// fits the machine and skips the rest. Measured 2026-11-15 on bun 1.4.4 and
// npm 12.2.1: from a tarball or from the registry, each installs exactly the
// matching package (bun before this was checked with @esbuild's own platform
// packages). Installing one here cannot be tested against the main package:
// a `file:` optionalDependencies entry is not filtered by platform at all, and
// bun installs every one of them.
//
// Nothing runs at install time: the main package finds the build by resolving
// the package it was given (lib/native.mjs binaryPath). That is the only shape
// that works for both package managers — bun blocks postinstall scripts of
// packages it does not trust (measured 2026-11-15), so a package that fetched
// or placed its build in an install script would silently have no proxy.
//
// This module is that packaging as functions: stage a platform package per
// target, check what has been staged, and say what the main package's manifest
// must carry for the packages to be reached.

import { spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { binaryFile } from "../native/binary-name.mjs"
import { artifactProblems, binaryName, buildDir, buildInfoOf, buildTargets, checkTargets, manifestProblems, newestSourceMtime } from "./build-native.mjs"

// npm spells a platform with the Node platform name and an architecture of
// x64/arm64 — never Go's amd64. npm refuses a cpu it does not recognize
// (`cpu:["amd64"]` is EBADPLATFORM, npm 12.2.1, measured 2026-11-15) while bun
// ignores the field, so the Go spelling installs for one package manager and
// fails for the other. See native/binary-name.mjs, which the runtime lookup
// uses to find these packages by the same names.
const packageCpu = (arch) => (arch === "amd64" ? "x64" : arch)
const packageName = (os, arch) => `magpie-plugin-codar-${os}-${packageCpu(arch)}`

// verifyArtifacts is the release door's own reading of each build: the Go
// record says which program it is, for which platform, by which toolchain and
// with which TLS defaults; the manifest says the bytes are the ones this tree
// built. Empty means every target answered. A machine without Go cannot be
// asked, and publishing without asking is what this closes.
const verifyArtifacts = (dir) => {
  const out = []
  for (const t of buildTargets) {
    const name = binaryName(t)
    const got = buildInfoOf(join(dir, name))
    if (got === null) return [`\`go\` is not on PATH; it is what reads a build's own record`]
    const wrong = artifactProblems(got, t)
    if (wrong.length) out.push(`${name} ${wrong.join("; ")}`)
    const unsure = manifestProblems(dir, t)
    if (unsure.length) out.push(`${name}: ${unsure.join("; ")}`)
  }
  return out
}

// Every target, in the order scripts/build-native.mjs builds them: the build
// table is the one authority for what exists, so this package layout cannot
// list a platform the build does not make. build-native.mjs must not import
// this module back — the table flows one way.
export const platformPackages = (targets = buildTargets) =>
  targets.map((t) => ({
    name: packageName(t.os, t.arch),
    os: t.os,
    cpu: packageCpu(t.arch),
    file: binaryFile(t.os, t.arch),
  }))

const readManifest = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

// stagePackages writes one package per target into out, each holding its build
// at bin/<file> with the executable bit an npm tarball will keep (a build that
// arrives without it cannot be spawned, which is how the 0.2.1 tarball failed
// its own gate), and answers what it wrote. A build missing from bin is an
// error: a package staged without one would install and then have no proxy.
export function stagePackages({ bin, out, version, targets = buildTargets }) {
  const staged = []
  for (const p of platformPackages(targets)) {
    const source = join(bin, p.file)
    if (!existsSync(source) || statSync(source).size < 4096) throw new Error(`${p.name}: no build at ${source}; run npm run native:all first`)
    const dir = join(out, p.name)
    const dest = join(dir, "bin", p.file)
    // a staging directory that outlived its release would otherwise ship its
    // stale files beside this build: npm packs what is there, not what was
    // just copied. The whole package directory is this release's to write.
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(join(dir, "bin"), { recursive: true })
    copyFileSync(source, dest)
    chmodSync(dest, 0o755)
    const manifest = {
      name: p.name,
      version,
      description: `The Codar desktop transport for magpie-plugin-codar on ${p.os}/${p.cpu}. Install magpie-plugin-codar; this package is chosen for you.`,
      license: "MIT",
      os: [p.os],
      cpu: [p.cpu],
      files: ["bin"],
    }
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2) + "\n")
    staged.push({ ...p, dir })
  }
  return staged
}

// checkPackages reports each staged package as "present" or "broken" with a
// reason: the manifest names the package and the release's version, its os and
// cpu are npm's spelling of the target, and a non-empty executable build is
// there. The version is the argument rather than read off the main package, so
// a caller checking a different version sees every package drift at once.
export function checkPackages({ dir, version, targets = buildTargets, bin = null }) {
  return platformPackages(targets).map((p) => {
    const where = join(dir, p.name)
    const manifest = readManifest(join(where, "package.json"))
    if (!manifest) return { name: p.name, state: "broken", reason: "no package.json" }
    if (manifest.name !== p.name) return { name: p.name, state: "broken", reason: `its manifest names ${manifest.name}` }
    if (manifest.version !== version) return { name: p.name, state: "broken", reason: `version ${manifest.version}, the release is ${version}` }
    if (JSON.stringify(manifest.os) !== JSON.stringify([p.os]) || JSON.stringify(manifest.cpu) !== JSON.stringify([p.cpu])) {
      return { name: p.name, state: "broken", reason: `os/cpu ${JSON.stringify(manifest.os)}/${JSON.stringify(manifest.cpu)}, want ${JSON.stringify([p.os])}/${JSON.stringify([p.cpu])}` }
    }
    let stat
    try {
      stat = statSync(join(where, "bin", p.file))
    } catch {
      return { name: p.name, state: "broken", reason: `bin/${p.file} missing` }
    }
    if (stat.size < 4096) return { name: p.name, state: "broken", reason: `bin/${p.file} only ${stat.size} bytes` }
    if (process.platform !== "win32" && (stat.mode & 0o111) === 0) return { name: p.name, state: "broken", reason: `bin/${p.file} not executable` }
    // With the build directory in hand, the staged file must BE that build:
    // staging copies, so anything else is a package carrying bytes the strict
    // check never saw (a stale file left in the staging tree from an earlier
    // version, or a hand edit). Size and mode alone passed all of those
    // (2026-11-27 review).
    if (bin) {
      try {
        const want = readFileSync(join(bin, p.file))
        const got = readFileSync(join(where, "bin", p.file))
        if (Buffer.compare(want, got) !== 0) return { name: p.name, state: "broken", reason: `bin/${p.file} is not the build in ${bin}` }
      } catch (e) {
        return { name: p.name, state: "broken", reason: `bin/${p.file} could not be compared with the build: ${e.message}` }
      }
    }
    return { name: p.name, state: "present" }
  })
}

// mainPackageProblems lists what a main-package manifest gets wrong about the
// platform packages, in words: every package named, each at exactly the
// release's version (a range lets the two drift apart, and a package at
// another version is one nobody asked for), and none of the builds in the
// package itself — five builds shipped twice is the size this replaced.
export function mainPackageProblems(manifest, targets = buildTargets) {
  const problems = []
  const optional = manifest.optionalDependencies ?? {}
  for (const p of platformPackages(targets)) {
    const at = optional[p.name]
    if (at === undefined) problems.push(`${p.name} is not in optionalDependencies`)
    else if (at !== manifest.version) problems.push(`${p.name} is pinned to ${at}; an exact ${manifest.version} is what installs with the main package`)
  }
  const groups = manifest.bundleDependencies ?? manifest.bundledDependencies
  if (Array.isArray(groups) && groups.some((g) => platformPackages(targets).some((p) => p.name === g))) {
    problems.push("a platform package is bundled into the main package")
  }
  const files = manifest.files ?? []
  if (files.some((f) => String(f) === "native/bin")) {
    problems.push("files names native/bin: the builds are the platform packages' now, and five shipped twice is the size this replaced")
  }
  return problems
}

// ---- the command a release runs --------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, "..")
// staged is where a release writes the five packages before publishing them.
// Not `files`, not committed: a release stages it, publishes it, and leaves it
// (git ignores native/packages, as it ignores native/bin).
const staged = join(pkgRoot, "native", "packages")

// stageFromTree stages every package at the version the main package declares,
// and refuses when the main package's own manifest would not reach them.
export function stageFromTree({ out = staged } = {}) {
  const manifest = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"))
  const problems = mainPackageProblems(manifest)
  if (problems.length) throw new Error(`package.json: ${problems.join("; ")}`)
  return stagePackages({ bin: buildDir(pkgRoot), out, version: manifest.version })
}

// The command:
//   node scripts/native-packages.mjs            stage the five packages
//   node scripts/native-packages.mjs --check    report what has been staged
//                                               (exit 1 unless all five are
//                                               staged at the main version)
//   node scripts/native-packages.mjs --publish  stage, then publish each with
//                                               npm publish --access public
// A release publishes the platform packages before the main package: their
// exact versions are what its optionalDependencies name, and npm refuses a
// dependency it cannot find.
function main(argv) {
  const args = new Set(argv)
  const unknown = [...args].filter((a) => a !== "--check" && a !== "--publish")
  if (unknown.length) {
    console.error(`native-packages: unrecognized argument ${unknown.join(" ")} (try --check or --publish)`)
    return 2
  }
  const manifest = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"))
  // The manifest is part of what "ready to publish" means: a package.json
  // whose optionalDependencies no longer name a platform package installs
  // without the proxy, and the staged set being complete does not show that.
  const problems = mainPackageProblems(manifest)
  if (problems.length) {
    for (const p of problems) console.error(`package.json: ${p}`)
  }
  // The builds are gated for --check too: it is the command CONTRIBUTING says
  // to run before tagging, and a staged set of five packages built from stale
  // sources read as "ready" (2026-11-26 review). Refusing here is the same
  // answer `npm publish`'s own strict check gives one step later, just before
  // anything irreversible.
  const builds = checkTargets(buildDir(pkgRoot), newestSourceMtime())
  const brokenBuilds = builds.filter((r) => r.state !== "present")
  if (args.has("--check")) {
    for (const r of brokenBuilds) console.error(`native-packages: ${r.name} ${r.reason ?? "no build"}`)
    if (brokenBuilds.length) console.error("native-packages: run `npm run native:all` first")
    const rows = checkPackages({ dir: staged, version: manifest.version, bin: buildDir(pkgRoot) })
    for (const r of rows) console.log(r.state === "present" ? `present ${r.name}@${manifest.version}` : `broken ${r.name}: ${r.reason}`)
    return problems.length || brokenBuilds.length || rows.some((r) => r.state !== "present") ? 1 : 0
  }
  if (problems.length) return 1
  // The builds are gated before anything is staged: --publish is the one step
  // whose result cannot be replaced or withdrawn (npm refuses to overwrite a
  // version), and it used to check only that a file of the right name was big
  // enough — a build for the wrong machine, or one older than the source it
  // names, would have been staged and published five times over before
  // `npm publish`'s own strict check refused the main package.
  if (brokenBuilds.length) {
    console.error(`native-packages: ${brokenBuilds.map((r) => `${r.name} ${r.reason ?? "no build"}`).join("; ")}; run \`npm run native:all\` first`)
    return 1
  }
  // An upload cannot be withdrawn, and the checks above read a file's shape
  // and its source string: the review of 2026-11-27 showed five 6 KB files of
  // magic bytes and a marker passing every one of them, because the record and
  // the digest were somebody else's step. They are this step's now.
  const unverified = verifyArtifacts(buildDir(pkgRoot))
  if (unverified.length) {
    console.error(`native-packages: ${unverified.join("; ")}`)
    return unverified.some((why) => /\bgo\b is not on PATH/.test(why)) ? 2 : 1
  }
  const wrote = stageFromTree()
  for (const p of wrote) console.log(`staged ${p.name}@${manifest.version} -> ${p.dir}`)
  if (!args.has("--publish")) return 0
  const rows = checkPackages({ dir: staged, version: manifest.version, bin: buildDir(pkgRoot) })
  const bad = rows.filter((r) => r.state !== "present")
  if (bad.length) {
    console.error(`native-packages: ${bad.map((r) => `${r.name} ${r.reason}`).join("; ")}`)
    return 1
  }
  // Before the first upload: a version any of these already has cannot be
  // replaced, and a run that stops half way leaves the rest of the version
  // behind it. Asking first turns that into one message with nothing published.
  const already = took(wrote, manifest.version)
  if (already.length) {
    console.error(`native-packages: ${already.join(", ")} already published at ${manifest.version}; nothing was published. Bump the version instead of reusing it.`)
    return 1
  }
  for (const p of wrote) {
    // --access public: a scoped name defaults to private, and these are
    // unscoped, but the flag is what npm documents for a first publish.
    // npm is npm.cmd on Windows, and a bare spawn does not look for .cmd
    // extensions at all: the publish loop would fail on its first package with
    // no name in the message. The shell path passes the command as one string,
    // for the same reason the tarball gate does.
    const argv = ["publish", "--access", "public"]
    const shell = process.platform === "win32"
    const out = shell
      ? spawnSync(["npm", ...argv].map((a) => (String(a).includes(" ") ? `"${a}"` : a)).join(" "), { cwd: p.dir, stdio: "inherit", shell: true })
      : spawnSync("npm", argv, { cwd: p.dir, stdio: "inherit" })
    if (out.status !== 0) {
      // A publish can fail after the registry took it — npm reports an error
      // it met while writing, and the packument lags the write by a moment.
      // Asking again is what tells "it is there, the client was wrong" (carry
      // on with the next package) from "nothing landed" (stop, bump).
      if (landed(p.name, manifest.version)) {
        console.log(`published ${p.name}@${manifest.version} (the client exited ${out.status}, the registry has it)`)
        continue
      }
      console.error(`native-packages: publishing ${p.name} failed (exit ${out.status}); the packages before it are published, and this version cannot be completed — bump the version for the rest`)
      return 1
    }
  }
  return 0
}

// landed asks whether a version is really in the registry after a publish
// said it failed. A registry answers a moment behind the write, so the answer
// is asked for a few times with a pause between; an unreachable registry is
// no evidence either way and does not count as a pass.
export const landed = (name, version, { tookFn = took, attempts = 4, pauseMs = 1500 } = {}) => {
  for (let i = 0; i < attempts; i++) {
    try {
      if (tookFn([{ name }], version).length) return true
    } catch {
      // keep asking: a preflight that cannot reach the registry proves nothing
    }
    if (i + 1 < attempts) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pauseMs)
  }
  return false
}

// took names the packages in wrote that the registry already has at version.
// It reads the packument over HTTPS rather than shelling out to `npm view`:
// npm is npm.cmd on Windows, where spawnSync finds it only through a shell,
// and the version the registry was asked about came back wrong that way. A
// packument is the registry's own answer, the same one `npm view` reads.
export function took(wrote, version, { registry = process.env.npm_config_registry || "https://registry.npmjs.org" } = {}) {
  const taken = []
  const base = registry.replace(/\/$/, "")
  for (const p of wrote) {
    // The child has its own clock and redirect cap; this one bounds even a
    // child that never reaches them (a loader error, a runtime that hangs).
    // A preflight that cannot get an answer must stop the publish it stands
    // in front of, not pass it with "a version nobody could ask about".
    const got = spawnSync(process.execPath, ["-e", readPackument, `${base}/${p.name}`, p.name], { encoding: "utf8", timeout: 30000 })
    if (got.error || got.status !== 0) {
      throw new Error(`${p.name}: the registry at ${base} could not be asked (${got.error?.message ?? `the child exited ${got.status}`}); nothing was published`)
    }
    let doc
    try {
      doc = JSON.parse(String(got.stdout ?? "").trim().split("\n").at(-1))
    } catch {
      doc = undefined
    }
    if (!doc) throw new Error(`${p.name}: the registry at ${base} did not answer with a version list; nothing was published`)
    if (doc.error && doc.error !== 404) throw new Error(`${p.name}: the registry answered ${doc.error}`)
    // versions is an array of the published versions, as the child printed it.
    if (Array.isArray(doc?.versions) && doc.versions.includes(version)) taken.push(p.name)
  }
  return taken
}

// readPackument runs in a child process as a script: a small program rather
// than a chain of synchronous calls, so the archive is decompressed off the
// main thread's stack. It prints {versions: [...]} or {error: status|message}.
// A redirect chain has a limit and every request a clock: a registry that
// points at itself is not an answer, and a preflight that never returned
// would hold the publish it stands in front of.
const readPackument = `
const [url, name] = process.argv.slice(1)
const get = (u, hops) => new Promise((resolve, reject) => {
  if (hops > 5) return reject(new Error("the registry redirected more than 5 times"))
  const req = require(u.startsWith("https:") ? "node:https" : "node:http").get(u, (res) => {
    if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
      res.resume()
      const next = res.headers.location
      if (!next) return resolve({ status: res.statusCode })
      try { return resolve(get(new URL(next, u).href, hops + 1)) } catch (e) { return reject(e) }
    }
    const chunks = []
    res.on("data", (c) => chunks.push(c))
    res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
  })
  req.setTimeout(10000, () => req.destroy(new Error("the registry did not answer within 10 s")))
  req.on("error", reject)
})
get(url, 0).then(({ status, body }) => {
  if (status !== 200) return console.log(JSON.stringify({ error: status }))
  const doc = JSON.parse((body ?? Buffer.alloc(0)).toString("utf8"))
  console.log(JSON.stringify({ versions: Object.keys(doc.versions || {}) }))
}).catch((e) => console.log(JSON.stringify({ error: String(e && e.message || e) })))
`

const isMain = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isMain) {
  // A start that cannot run — a package.json that is not JSON, a staged
  // tree it cannot read — is one line in the release run's log, as
  // build-native answers one: the message says what broke. Node's raw
  // stack buried that line under frames.
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (e) {
    console.error(`native-packages: ${e?.message ?? e}`)
    process.exitCode = 1
  }
}
