// build-native.mjs builds codar-proxy for every platform the plugin ships to.
//
// The proxy has to come from the same Go toolchain as the Codar desktop
// sidecar for its TLS and HTTP/2 handshakes to be the sidecar's: the macOS and
// Linux sidecars are Go 1.24.3 builds with no DefaultGODEBUG, the Windows one
// is a Go 1.26.7 build whose go 1.24 directive leaves it with a go 1.24
// DefaultGODEBUG (read off its `go version -m`). A Go module's go directive
// decides which of the changed GODEBUG defaults (tlsmlkem, tlssha1,
// tlssecpmlkem, ...) are written into the binary, so native/go.mod stays at
// 1.24 for every target and the finished binaries are checked against the
// sidecar's own defaults.
//
// The binaries are not committed (`native/bin` is ignored). A release runs
// `npm run native:all` before staging, so each platform package carries its own
// build (since 0.3.0 the main tarball carries none); a checkout that never ran
// it has no binary, and the plugin falls back to its own fetch there — the suite
// and the tarball gate pass either way.
//
// Usage: node scripts/build-native.mjs [--all] [--check [--strict]]
//   (no flags)  build the targets this machine can build: its own platform,
//               plus every darwin target on macOS and every linux target on
//               linux (CGO is off, so cross-compiling within an OS is free)
//   --all       build every target
//   --check     report what the binary directory holds, build none
//   --strict    with --check, exit 1 unless every target is present, looks
//               like a build for its platform, and is newer than the proxy's
//               own source (the release gate: a published package must carry
//               all five, a truncated or empty file with the right name must
//               not pass for one, and a build made before the source it
//               names must not ship as that source's)
//
// Environment: GO, to name the go command (default "go"); GO_1_24 and GO_1_26
// to name the 1.24.3 and 1.26.7 toolchains (defaults "go1.24.3" and
// "go1.26.7", fetched by the go command itself when GOTOOLCHAIN=auto);
// CODAR_NATIVE_OUT, to name the directory the builds are written to and
// --check reads (default native/bin).

import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import { binaryFile } from "../native/binary-name.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..", "native")
// buildDir is where the builds live for every script that reads them — this
// one's --check, native-packages' staging and tarball.mjs's install check —
// and CODAR_NATIVE_OUT moves all of them at once. A check that validated one
// directory while the publish copied another is how a stale build could have
// reached a release line (found by the 2026-11-26 pre-release review).
export const buildDir = (pkgRoot = join(root, "..")) => (process.env.CODAR_NATIVE_OUT ? resolve(pkgRoot, process.env.CODAR_NATIVE_OUT) : join(pkgRoot, "native", "bin"))
const out = buildDir()

const go = process.env.GO || "go"
// The variable is named after the release line, not the patch: GO_1_24 names
// whatever 1.24.x is asked for (the documented spelling). Keying on the full
// "1.24.3" spelled a variable nobody could set.
export const toolchainVariable = (version) => `GO_${version.split(".").slice(0, 2).join("_")}`
export const toolchainFor = (version) => process.env[toolchainVariable(version)] || `go${version}`
const toolchain = toolchainFor

// windowsDefaults is the DefaultGODEBUG the Windows sidecar carries, read off
// Resources/bin/codar.exe in Codar-Setup-0.3.13.exe (`go version -m`). It is
// what go 1.24.0's directive produces when the build tool is Go 1.26.7, so the
// Windows build keeps a go 1.24 directive even though its toolchain is newer:
// tlssecpmlkem=0 alone changes the ClientHello (no X25519MLKEM768 group), and
// matching the sidecar matters more than matching its toolchain's default.
const windowsDefaults =
  "containermaxprocs=0,cryptocustomrand=1,decoratemappings=0,tlssecpmlkem=0,tlssha1=1,updatemaxprocs=0,urlstrictcolons=0,x509sha256skid=0"

// Each target: the platform name the plugin's lookup uses (Node's, so
// "win32"), the build's goos/goarch, the toolchain the sidecar uses there, the
// go directive that toolchain's build needs, and the DefaultGODEBUG the
// finished binary must report — the sidecar's own, or none.
const targets = [
  { os: "darwin", goos: "darwin", arch: "arm64", go: "1.24.3", directive: "1.24.0", godebug: "" },
  { os: "darwin", goos: "darwin", arch: "amd64", go: "1.24.3", directive: "1.24.0", godebug: "" },
  { os: "linux", goos: "linux", arch: "arm64", go: "1.24.3", directive: "1.24.0", godebug: "" },
  { os: "linux", goos: "linux", arch: "amd64", go: "1.24.3", directive: "1.24.0", godebug: "" },
  { os: "win32", goos: "windows", arch: "amd64", go: "1.26.7", directive: "1.24.0", godebug: windowsDefaults },
]

export const binaryName = (t) => binaryFile(t.os, t.arch)
// buildTargets is the table itself, for the suite: which toolchain and which
// GODEBUG defaults each platform's sidecar was built with.
export const buildTargets = targets
const builtIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("codar-proxy-")) : [])
// buildArgs is what every shipped binary is built with. -trimpath keeps the
// build machine's paths out; -buildvcs=false keeps the VCS stamp out — it is
// on by default, it reads the checkout the build runs in rather than the
// source, and the 0.2.x builds carried vcs.revision=c90d4d9 (v0.1.2) with
// vcs.modified=true because they were made before the 0.2.0 tree. A stamp
// that disagrees with the source is worse than none for a review.
export const buildArgs = (output, hash = sourceHash()) => [
  "build", "-trimpath", "-buildvcs=false",
  // The fingerprint is the gate's evidence that these bytes came from these
  // sources: mtime says when a file was touched, and a copy touches it.
  "-ldflags", `-s -w -X main.sourceHash=${SOURCE_MARKER}${hash}`,
  "-o", output, "./cmd/codar-proxy",
]

// A real build of this program is several megabytes; anything under a page is
// a placeholder, a truncated copy or a text file that happens to have the name.
const minBinaryBytes = 4096

// executableMagic is what a build for each GOOS starts with: a PE image on
// Windows, ELF on Linux, and a little-endian 64-bit Mach-O on macOS (a fat
// archive is accepted too, though these builds are single-arch).
const executableMagic = {
  windows: [Buffer.from([0x4d, 0x5a])],
  linux: [Buffer.from([0x7f, 0x45, 0x4c, 0x46])],
  darwin: [Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.from([0xca, 0xfe, 0xba, 0xbe])],
}

// headerBytes covers the ELF and Mach-O headers plus a PE image's DOS header
// and the NT headers it points at (e_lfanew is usually 0x80).
const headerBytes = 8192

// archOf reads the machines a header names — a set, because a fat archive
// lists one per slice. The four magic bytes above say only "some ELF / PE /
// Mach-O", and both of a platform's builds start with the same ones, so a
// build renamed to the other architecture's file name passed the gate and
// shipped as a binary the plugin cannot exec. These fields differ.
const archOf = (head, goos) => {
  const name = (cpu, one, two) => (cpu === one ? "amd64" : cpu === two ? "arm64" : "")
  if (goos === "linux") {
    // ELF: EI_CLASS at 4 (2 = 64-bit), e_machine at 18, little-endian.
    if (head.length < 20 || head[4] !== 2) return new Set()
    return new Set([name(head.readUInt16LE(18), 0x3e, 0xb7)].filter(Boolean))
  }
  if (goos === "windows") {
    // PE: e_lfanew at 0x3c, then "PE\0\0" and the machine two fields in.
    if (head.length < 0x40) return new Set()
    const at = head.readUInt32LE(0x3c)
    if (at + 6 > head.length || head.toString("latin1", at, at + 4) !== "PE\0\0") return new Set()
    return new Set([name(head.readUInt16LE(at + 4), 0x8664, 0xaa64)].filter(Boolean))
  }
  // Mach-O. These builds are single-arch, but the gate reads a fat archive
  // too: its slices are listed big-endian in its header.
  const arches = new Set()
  if (head.length < 8) return arches
  if (head.readUInt32BE(0) === 0xcafebabe) {
    for (let i = 0, n = Math.min(head.readUInt32BE(4), 8); i < n; i++) {
      const at = 8 + i * 20
      if (at + 4 > head.length) break
      const arch = name(head.readUInt32BE(at), 0x01000007, 0x0100000c)
      if (arch) arches.add(arch)
    }
    return arches
  }
  const arch = name(head.readUInt32LE(4), 0x01000007, 0x0100000c)
  if (arch) arches.add(arch)
  return arches
}

// SOURCE_MARKER prefixes the source fingerprint every build carries. It is a
// string constant inside the binary (ldflags -X), so it survives -s -w and can
// be read with the file alone — no Go, no execution, no platform of its own.
export const SOURCE_MARKER = "codar-proxy-source:"

// sourceHash is a fingerprint of the program's own sources: every .go file
// under native/cmd that is compiled in (_test.go is not), in walking order,
// path and bytes both. Two trees with the same hash produce the same binary; a
// build made from anything else does not carry it. go.mod is deliberately not
// one of them (the build loop rewrites it per target); what toolchain and CPU
// baseline the build actually used is `--buildinfo`'s question.
export const sourceHash = (root = join(here, "..")) => {
  const h = createHash("sha256")
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith(".go") && !entry.name.endsWith("_test.go")) files.push(path)
    }
  }
  walk(join(root, "native", "cmd"))
  // go.mod and go.sum are left out: the build loop rewrites go.mod per target
  // and restores it after the last one, so a hash taken during the build and
  // one taken after it disagree on a byte nothing about the program changed.
  // Which program this is at all is `--buildinfo`'s question, not this one's.
  for (const path of files) {
    h.update(path.slice(root.length).split(sep).join("/"))
    h.update("\0")
    h.update(readFileSync(path))
    h.update("\0")
  }
  return h.digest("hex")
}

// newestSourceMtime is when the proxy's own source last changed — the .go
// files under native/cmd that go into each build (`_test.go` excluded: it is
// not compiled in, so a test-only change cannot make a build stale). A build older than
// one of them was made from something else; the release line once shipped
// builds made before the source they named, and a header-shaped file cannot
// tell anyone that. go.mod is left out on purpose: the build loop rewrites it
// per target and restores it after the last build, so its mtime says nothing
// about the binaries. An answer of null — the tree unreadable, or no .go in
// it — is not a pass: every target is refused, because a gate that cannot
// date the source must not wave a build through.
export const newestSourceMtime = (srcDir = join(root, "cmd")) => {
  let newest = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      // _test.go is not compiled into the build: a test-only change cannot
      // make a binary stale (and would otherwise force five rebuilds)
      else if (entry.name.endsWith(".go") && !entry.name.endsWith("_test.go")) newest = Math.max(newest, statSync(path).mtimeMs)
    }
  }
  try {
    walk(srcDir)
  } catch {
    return null // the source cannot be read: nothing can be dated against it
  }
  return newest > 0 ? newest : null // no .go at all is not "no source change"
}

// inspectTarget reports one target's state in a directory: "present" when the
// file is a non-empty, executable, correctly-flavoured build; "missing" when
// it is not there; "broken" with a reason when it is there but cannot be what
// the plugin will exec. The name used to be the whole check, which let an
// empty file (or a `.gitignore`d placeholder) pass for a release.
export const inspectTarget = (dir, t, sourceMtime = 0, want = sourceHash()) => {
  const name = binaryName(t)
  const path = join(dir, name)
  let stat
  try {
    stat = statSync(path)
  } catch {
    return { name, state: "missing" }
  }
  if (!stat.isFile()) return { name, state: "broken", reason: "not a regular file" }
  if (stat.size < minBinaryBytes) return { name, state: "broken", reason: `only ${stat.size} bytes` }
  const head = Buffer.alloc(Math.min(headerBytes, stat.size))
  let read = 0
  let fd
  try {
    fd = openSync(path, "r")
    read = readSync(fd, head, 0, head.length, 0)
  } catch (e) {
    return { name, state: "broken", reason: `unreadable: ${e.message}` }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  const magics = executableMagic[t.goos] ?? []
  if (!magics.some((m) => head.subarray(0, m.length).equals(m))) {
    return { name, state: "broken", reason: `not a ${t.goos} executable (header ${head.subarray(0, 4).toString("hex")})` }
  }
  const arches = archOf(head.subarray(0, read), t.goos)
  if (!arches.has(t.arch)) {
    const named = [...arches].join("/")
    return { name, state: "broken", reason: named ? `built for ${named}, not ${t.arch}` : `header names no machine, so not ${t.arch}` }
  }
  // PE has no execute bit and Windows does not read one; on every other host
  // the build must still be runnable, or the plugin's spawn fails at use.
  if (t.goos !== "windows" && process.platform !== "win32" && (stat.mode & 0o111) === 0) {
    return { name, state: "broken", reason: "not executable" }
  }
  if (sourceMtime === null) {
    // an unreadable source is not a pass: the release line must never ship a
    // build whose freshness nothing could check
    return { name, state: "broken", reason: "the proxy's source cannot be read, so no build can be dated against it" }
  }
  if (sourceMtime > 0 && stat.mtimeMs < sourceMtime) {
    return { name, state: "broken", reason: "older than its source; run node scripts/build-native.mjs --all" }
  }
  // The fingerprint is what a copy cannot fake: `cp` refreshes the mtime, so a
  // stale binary from this same repo passed every other check. A build made
  // before this marker existed has none, and is refused like any other.
  if (want && !carriesSource(path, want)) {
    return { name, state: "broken", reason: "built from other sources than the tree has; run node scripts/build-native.mjs --all" }
  }
  return { name, state: "present" }
}

// checkTargets is the whole directory, in the table's order: what --check
// prints and --strict refuses.
// BUILD_PATH is the command path every build must carry in its own Go build
// record. A file with the right header, size and machine type can still be
// another program — an old copy from another module, or bytes that merely look
// like a binary — and the build record is the one thing that says which program
// it is. `go version -m` reads that record; nothing else in this repo does.
export const BUILD_PATH = "github.com/MisonL/magpie-plugin-codar/native/cmd/codar-proxy"

// buildInfoOf reads one file's build record. null means "no answer": Go is not
// installed (the tool that reads the record), and a release machine without it
// is told so rather than waved through. `go version -m` exits 1 on a file that
// is not a Go binary at all, which is the refusal this gate exists for.
export const buildInfoOf = (file, run = spawnSync) => {
  const out = run(process.env.GO || "go", ["version", "-m", file], { encoding: "utf8" })
  if (out?.error?.code === "ENOENT") return null
  const text = `${out?.stdout ?? ""}${out?.stderr ?? ""}`
  const lines = text.split("\n")
  const stated = lines.find((line) => line.startsWith("\tpath\t"))
  const field = (name) => lines.map((l) => new RegExp(`^\\tbuild\\t${name}=(.*)$`).exec(l)?.[1]).find((v) => v !== undefined) ?? ""
  return {
    ok: out?.status === 0 && stated?.trim() === `path\t${BUILD_PATH}`,
    said: stated?.trim() ?? text.trim().split("\n")[0] ?? "",
    // The record states the platform, the toolchain and the defaults the build
    // ran with: a file built for another platform, or by another Go, is the
    // proxy this repo builds and still not the artifact this target needs.
    goos: field("GOOS"),
    goarch: field("GOARCH"),
    godebug: field("DefaultGODEBUG"),
    toolchain: lines[0]?.trim() ?? "",
  }
}

// artifactProblems names what is wrong with one build for one target, using the
// record the binary carries. A shape check reads the header; this reads what
// the compiler wrote down: the platform it was built for, the toolchain (the
// sidecar's own, pinned per target) and the GODEBUG defaults that decide its
// TLS behaviour. Empty means the artifact answers for this target.
export const artifactProblems = (got, t) => {
  const problems = []
  if (!got) return ["no build record could be read"]
  if (!got.ok) return [`not this repo's proxy (${got.said || "no build record"})`]
  if (got.goos !== t.goos) problems.push(`built for ${got.goos || "no platform"}, not ${t.goos}`)
  if (got.goarch !== t.arch) problems.push(`built for ${got.goarch || "no arch"}, not ${t.arch}`)
  // `go version -m` prints "<file>: go1.24.3 X:…" on its first line; the
  // version is the go-prefixed token in it, and the table states it without
  // the prefix.
  const built = (got.toolchain.match(/go\d+(?:\.\d+)*/) ?? [""])[0]
  if (built && built !== `go${t.go}`) problems.push(`built by ${built}, not go${t.go}`)
  if ((got.godebug ?? "") !== (t.godebug ?? "")) {
    problems.push(`DefaultGODEBUG=${got.godebug || "(none)"}, want ${t.godebug || "(none)"}`)
  }
  return problems
}

// BUILD_MANIFEST is what the build wrote: for each file, the sha256 of the
// bytes it produced, beside the platform, toolchain and TLS defaults it was
// built with. The fingerprint inside a binary is a string the linker wrote, and
// a string can be appended to any file — the review of 2026-11-27 appended it
// to a binary from other sources and watched every gate pass. A digest of the
// bytes cannot be appended to: it either is the file's digest or it is not.
export const BUILD_MANIFEST = "builds.json"

export const sha256Of = (file) => {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex")
  } catch {
    return ""
  }
}

export const readManifest = (dir = out) => {
  try {
    const said = JSON.parse(readFileSync(join(dir, BUILD_MANIFEST), "utf8"))
    return said && typeof said === "object" && typeof said.builds === "object" && said.builds !== null ? said : null
  } catch {
    return null
  }
}

// recordBuild appends one file to the manifest, starting a new one when the
// sources changed (an entry for another tree's bytes is worse than none).
export const recordBuild = (dir, name, entry, hash = sourceHash()) => {
  const held = readManifest(dir)
  const builds = held && held.sourceHash === hash ? { ...held.builds } : {}
  builds[name] = entry
  writeFileSync(join(dir, BUILD_MANIFEST), `${JSON.stringify({ sourceHash: hash, builds }, null, 2)}\n`)
}

// manifestProblems names why a directory's manifest cannot vouch for one
// target, or [] when it can: the manifest is this tree's, it knows this file,
// and the bytes on disk are the ones it recorded.
export const manifestProblems = (dir, t, hash = sourceHash()) => {
  const held = readManifest(dir)
  if (!held) return [`no ${BUILD_MANIFEST} in ${dir}; run node scripts/build-native.mjs --all`]
  if (held.sourceHash !== hash) return [`its ${BUILD_MANIFEST} is for other sources; run node scripts/build-native.mjs --all`]
  const name = binaryName(t)
  const entry = held.builds[name]
  if (!entry || typeof entry !== "object") return [`${name} is not in its ${BUILD_MANIFEST}; run node scripts/build-native.mjs --all`]
  const now = sha256Of(join(dir, name))
  if (!now || now !== entry.sha256) return [`${name} is not the bytes this tree built (the manifest says ${String(entry.sha256).slice(0, 12)}…); run node scripts/build-native.mjs --all`]
  if (entry.goos !== t.goos || entry.goarch !== t.arch) return [`${name} is recorded as ${entry.goos ?? "?"}/${entry.goarch ?? "?"}, not ${t.goos}/${t.arch}`]
  return []
}

// carriesSource says whether a file carries this tree's fingerprint. It is the
// whole evidence a copy cannot fake: the string is inside the binary, written
// by the linker from the sources that were compiled.
export const carriesSource = (file, hash = sourceHash()) => {
  try {
    return readFileSync(file).includes(Buffer.from(`${SOURCE_MARKER}${hash}`))
  } catch {
    return false
  }
}

export const checkTargets = (dir = out, sourceMtime = newestSourceMtime()) =>
  targets.map((t) => inspectTarget(dir, t, sourceMtime)) // null sourceMtime fails every row

// missingTargets is the builds a directory does not have, by file name: what
// --check reports, and what --strict refuses.
export const missingTargets = (dir = out) => checkTargets(dir).filter((r) => r.state !== "present").map((r) => r.name)

// only when run as the script: the suite imports binaryName to check that a
// build is named the file the lookup opens, and importing must not start a
// toolchain download or exit the test process. Compared by real path on both
// sides, as scripts/catalog.mjs does.
const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

function build(argv) {
  const args = new Set(argv)
  // An argument this script does not know is exit 2, the same answer the
  // tarball gate and the catalog generator give: a misspelt --strict used to
  // be ignored, and a release-time check silently ran without it.
  const unknown = [...args].filter((a) => a !== "--all" && a !== "--check" && a !== "--strict" && a !== "--buildinfo")
  if (unknown.length) {
    console.error(`build-native: unrecognized argument ${unknown.join(" ")} (try --all, --check, --strict or --buildinfo)`)
    return 2
  }
  // --buildinfo is its own pass and its own flag: it needs a Go toolchain to
  // read the record, which --check (a file's shape) does not, and a machine
  // that has the builds but not Go should learn that rather than fail silently.
  if (args.has("--buildinfo")) {
    let bad = 0
    let sawGo = true
    for (const t of targets) {
      const file = join(out, binaryName(t))
      if (!existsSync(file)) {
        // A file this pass cannot read is not a pass: the answer it is asked
        // for ("is this artifact the proxy this tree builds?") is "no".
        bad++
        console.error(`build-native: ${binaryName(t)} is not there to be identified`)
        continue
      }
      const got = buildInfoOf(file)
      if (got === null) {
        sawGo = false
        console.error("build-native: `go` is not on PATH; it is what reads a build's own record")
        return 2
      }
      if (!got.ok) {
        bad++
        console.error(`build-native: ${binaryName(t)} is not this repo's proxy (${got.said || "no build record"})`)
        continue
      }
      // The record also says which platform, which toolchain and which TLS
      // defaults the build ran with. A file copied from another target — or
      // built by a developer's newer Go — is this repo's proxy and still not
      // this target's artifact; the build path asserts the same three things
      // (2026-11-27 review), and this is the pass that reads the artifact as
      // it is shipped.
      const wrong = artifactProblems(got, t)
      if (wrong.length) {
        bad++
        console.error(`build-native: ${binaryName(t)} ${wrong.join("; ")}`)
        continue
      }
      if (!carriesSource(file)) {
        bad++
        console.error(`build-native: ${binaryName(t)} is this repo's proxy but not this tree's build; run node scripts/build-native.mjs --all`)
        continue
      }
      // The fingerprint above is a string; the manifest is the bytes. A file
      // from other sources with this tree's marker appended passes the string
      // and fails the digest (2026-11-27 review).
      const unsure = manifestProblems(out, t)
      if (unsure.length) {
        bad++
        console.error(`build-native: ${binaryName(t)}: ${unsure.join("; ")}`)
        continue
      }
      console.log(`identified ${binaryName(t)}`)
    }
    if (!sawGo) return 2
    if (bad) {
      console.error(`build-native: ${bad} build(s) are not the proxy this repo builds; run node scripts/build-native.mjs --all`)
      return 1
    }
    return 0
  }
  if (args.has("--check")) {
    const rows = checkTargets(out)
    for (const r of rows) {
      console.log(r.state === "present" ? `present ${r.name}` : r.state === "missing" ? `missing ${r.name}` : `broken ${r.name}: ${r.reason}`)
    }
    const bad = rows.filter((r) => r.state !== "present")
    if (bad.length) {
      const missing = bad.filter((r) => r.state === "missing").length
      // --strict used to be the only refusing spelling: `--check` alone printed
      // five missing targets and exited 0, so a release step that dropped the
      // flag waved the release through (2026-11-27 review). The flag still
      // selects the wording, not the answer.
      console.error(
        `build-native: ${bad.length} target(s) unusable (${missing} missing)${args.has("--strict") ? "" : " — this is --check, and it is a refusal too; --strict is accepted for compatibility"}; run node scripts/build-native.mjs --all`,
      )
      return 1
    }
    return 0
  }

  const all = args.has("--all")
  const mine = process.platform === "darwin" || process.platform === "linux" || process.platform === "win32" ? process.platform : ""
  const chosen = all ? targets : targets.filter((t) => t.os === mine)
  if (!chosen.length) {
    console.error(`build-native: no target for ${process.platform}; use --all`)
    return 1
  }

  mkdirSync(out, { recursive: true })
  for (const t of chosen) {
    // The go directive is the module's, so a target that needs another one
    // gets its own copy of go.mod, put back afterwards.
    const original = join(root, "go.mod")
    const originalText = readFileSync(original, "utf8")
    const current = /^go (.*)$/m.exec(originalText)?.[1]
    const patched = current !== t.directive
    if (patched) writeFileSync(original, originalText.replace(/^go .*$/m, `go ${t.directive}`))
    try {
      const name = binaryName(t)
            // GOEXPERIMENT is pinned to "none": a value inherited from the
      // releaser's own `go env` is not this program's, and it either breaks
      // the pinned toolchain (Go 1.24.3 does not know `greenteagc`, which a
      // newer local go env file may set) or changes the binary behind the
      // build's back. "none" is the plain build of each pinned toolchain;
      // CODAR_GOEXPERIMENT names a different one deliberately. The Windows
      // sidecar's own experiment list is not readable from the binary here,
      // so this is the neutral choice rather than a measured one.
      const experiment = process.env.CODAR_GOEXPERIMENT ?? "none"
      const env = { ...process.env, CGO_ENABLED: "0", GOOS: t.goos, GOARCH: t.arch, GOTOOLCHAIN: toolchain(t.go), GOEXPERIMENT: experiment }
      // -buildvcs=false: VCS stamping is on by default and reads the
      // checkout the build runs in, not the source the binary is built from.
      // The 0.2.x builds carried vcs.revision=c90d4d9 (v0.1.2) because they
      // were made before the 0.2.0 tree, and the version they name is wrong
      // whenever the working tree is dirty; a stamp that disagrees with the
      // source is worse than none for a review.
      const result = spawnSync(go, buildArgs(join(out, name)), { cwd: root, env, stdio: "inherit" })
      if (result.status !== 0) throw new Error(`${go} build failed for ${t.os}/${t.arch} (exit ${result.status ?? result.signal})`)
      const info = execFileSync(go, ["version", "-m", join(out, name)], { env, encoding: "utf8" })
      const got = info.match(/DefaultGODEBUG=(\S+)/)?.[1] ?? ""
      const toolchainUsed = info.split("\n")[0].trim()
      console.log(`${name}: ${toolchainUsed}${got ? ` DefaultGODEBUG=${got}` : " (no DefaultGODEBUG)"}`)
      if (got !== t.godebug) {
        // The defaults decide the ClientHello (tlssecpmlkem, tlssha1) and a
        // few wire details; a build that does not carry the sidecar's own is
        // not the sidecar's client, so it is refused rather than shipped.
        throw new Error(`${name} carries DefaultGODEBUG=${got || "(none)"}, want ${t.godebug || "(none)"}: the go directive is wrong for this platform's sidecar`)
      }
      // What was built, as bytes: the manifest is what a gate downstream can
      // compare against without a Go toolchain, and what an appended
      // fingerprint cannot satisfy (see BUILD_MANIFEST).
      recordBuild(out, name, { sha256: sha256Of(join(out, name)), goos: t.goos, goarch: t.arch, go: (toolchainUsed.match(/go\d+(?:\.\d+)*/) ?? [""])[0], godebug: got })
    } finally {
      if (patched) writeFileSync(original, originalText)
    }
  }
  console.log(`built ${chosen.length} target(s) into ${out} (${builtIn(out).length} present)`)
  return 0
}

if (isMain) {
  try {
    process.exitCode = build(process.argv.slice(2))
  } catch (e) {
    console.error(`build-native: ${e.message}`)
    process.exitCode = 1
  }
}
