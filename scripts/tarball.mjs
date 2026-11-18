// The suite as a fresh npm tarball carries it: pack, unpack into a scratch
// directory, and run `node --test` inside the unpacked package. The
// `package.json` `files` list is the only thing that decides what ships, so a
// test that references a file outside it (as the style test once did with
// CONTRIBUTING.md) can pass in a checkout and fail only inside the tarball.
// This is that check, as a command a release run and CI both call.
//
// It runs the packed suite on Bun too: that is the runtime magpie actually
// loads plugins on, and no other job runs it against the packed artifact. A
// machine without Bun skips that half; `--require-bun` (what CI passes, where
// Bun is installed on purpose) makes a Bun that will not run an error instead
// of a silent skip.
//
//   node scripts/tarball.mjs                 # exit 0 when the packed suite passes
//   node scripts/tarball.mjs --require-bun   # …and Bun must run it too
//   node scripts/tarball.mjs --require-builds
//                                            # …and the install check must run
//                                            # (a tree without native/bin is an
//                                            # error; without it, a skip)
//
// The install check needs the source tree's builds (`native/bin`, from
// `npm run native:all`). Without them it is skipped and says so, unless
// `--require-builds` is passed — a release run (`prepublishOnly`) passes it,
// so a release cannot ship on a check that did not run. Inside a packed run
// of the suite (CODAR_TARBALL_GATE) there are no builds to stage and the
// packed suite is already running, so the install check is skipped there —
// unless `--require-builds` is passed too: a run that was told to check the
// install path answers "could not do it" (exit 2) rather than a skip.

import { execFileSync, spawn } from "node:child_process"
import { createServer } from "node:http"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { platformPackages, stagePackages, checkPackages } from "./native-packages.mjs"

// The checkout this script lives in, not the caller's directory: `npm pack`
// packs the directory it runs in, and a release script is often run from
// elsewhere.
const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const requireBun = process.argv.includes("--require-bun")
const requireBuilds = process.argv.includes("--require-builds")
// npm and tar are .cmd shims on Windows, which execFileSync only finds
// through the shell. cmd.exe receives the arguments joined, not quoted, and a
// temp directory can carry a space (a Windows profile folder commonly does),
// so an argument that needs it is quoted here. node and bun are real
// executables and run without a shell, which keeps a missing Bun an ENOENT
// (a skip) rather than a shell 127 that looks like a failing program.
const shell = process.platform === "win32"
// Every character cmd.exe acts on, not only a space: an ampersand splits the
// line into two commands (a temp path is allowed to contain one), and the
// redirection and caret characters do the same. An embedded quote is doubled,
// which is how cmd reads one inside a quoted argument.
const NEEDS_QUOTE = /[\s"&|<>^()%]/
export const quoteArg = (arg, throughShell) => (throughShell && NEEDS_QUOTE.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg)

// shellSafe refuses an argument cmd.exe would expand: %NAME% is substituted
// even inside double quotes, and there is no quoting that turns it off. A
// temp directory carrying a percent is pathological; saying so (exit 2) is
// better than packing from the wrong path or reading the wrong tarball.
export const shellSafe = (args, throughShell) => {
  if (!throughShell) return
  const bad = args.find((a) => String(a).includes("%"))
  if (bad) throw usage(`a path containing % (${bad}) cannot be passed through cmd.exe safely; set TMPDIR to a path without %`)
}

// run is execFileSync with one failure message shape, and a plain sentence
// when the program itself is missing rather than failing.
export const run = (cmd, args, { throughShell = shell, ...opts } = {}) => {
  shellSafe(args, throughShell)
  try {
    return execFileSync(cmd, args.map((a) => quoteArg(a, throughShell)), { encoding: "utf8", shell: throughShell, ...opts })
  } catch (e) {
    // Through cmd.exe a missing program is not ENOENT: cmd prints "not
    // recognized" and exits 9009 (127 from a POSIX shell), and Node throws a
    // status error. Both mean "could not run here", not "the gate ran and
    // failed", so the exit code is 2 on either platform.
    const missing = e?.code === "ENOENT" || (throughShell && (e?.status === 9009 || e?.status === 127))
    // missingProgram is what the Bun half reads to tell "not installed" (a
    // skip, or exit 2 under --require-bun) from "ran and failed"; it was never
    // set, so a machine without Bun never skipped the Bun half at all.
    if (missing) { const miss = new Error(`${cmd} was not found in PATH; this check needs it`); miss.exitCode = 2; miss.missingProgram = true; throw miss }
    // A program that ran and failed (npm cannot pack, tar cannot unpack) is
    // also "nothing usable came of the run" — 2 — not "the packed suite
    // failed" — 1. execFileSync reports the child's status as .status, and
    // the top-level catch used to read only .exitCode, which it never sets:
    // every environment failure came out as 1, pointing at the artifact.
    const failed = new Error(`${cmd} ${args.join(" ")} failed (exit ${e?.status ?? "unknown"})`)
    failed.exitCode = 2
    throw failed
  }
}

// usage is an argument this check does not know: exit 2, the same answer the
// catalog generator gives, so a release script cannot mistake it for "the gate
// ran and failed" (1) or "it passed" (0). A misspelt --require-bun used to be
// ignored, and the Bun half was silently skipped on a release run.
const usage = (message) => { const e = new Error(message); e.exitCode = 2; return e }

// tarballOf finds the archive a pack left in dir. A pack that exits 0 and
// writes none is not "the packed suite failed" (1): there is nothing to run,
// so it is "ask again" (2), the same answer as a missing npm.
export const tarballOf = (dir) => {
  const tgz = readdirSync(dir).find((f) => f.endsWith(".tgz"))
  if (!tgz) throw usage(`npm pack wrote no tarball into ${dir}`)
  return tgz
}

// packedPackage packs the npm package in dir and answers the tarball's path.
// The caller's npm flags are stripped the same way the main gate strips them:
// `prepublishOnly` runs inside `npm publish`, which exports its own npm_config_*.
export const packedPackage = (dir, into) => {
  // --ignore-scripts: the gate runs inside `prepublishOnly`, and npm arms its
  // own lifecycle by forcing ignore-scripts off; a `file:` dependency listed in
  // the staged package's manifest is then run as a prepare script, a shell
  // child the synchronous pack waits on forever.
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^npm_config_/i.test(key)) delete env[key]
  // A directory of this pack's own: `into` collects several packages, and a
  // shared directory makes "the tarball it wrote" the first one there.
  mkdirSync(into, { recursive: true })
  const out = mkdtempSync(join(into, "pack-"))
  run("npm", ["pack", "--silent", "--ignore-scripts", "--pack-destination", out], { cwd: dir, stdio: "ignore", env })
  return join(out, tarballOf(out))
}

// requireNativeBin checks that a package ships no proxy builds. The builds
// travel in the platform packages now (scripts/native-packages.mjs), so the
// main package carrying native/bin again is the 32 MB mistake returning: two
// copies of five builds, which is exactly the size this replaced. Returns 0
// always; it is a check, not a count.
export const requireNativeBin = (unpacked) => {
  if (existsSync(join(unpacked, "native", "bin")) && readdirSync(join(unpacked, "native", "bin")).length) {
    throw new Error("the tarball carries native/bin: the builds ship as platform packages, and the main package must not repeat them")
  }
  return 0
}

// packagePathOf names the platform package a resolved build came from, as a
// package-relative path ("<package>/bin/<file>"), or null when it did not
// come from one: a fallback into the main package's own tree (a checkout's
// native/bin) is the old path, not what the install check is about. Both
// spellings of a separator are split on — the resolved path is written the
// way the machine writes paths, and a Windows one has backslashes, while the
// answer is compared against npm's own forward-slashed package names. The
// probe runs this function's source in its own process (it is pure).
export const packagePathOf = (found, here) => {
  const rel = found.startsWith(here + "/") || found.startsWith(here + "\\") ? found.slice(here.length + 1) : ""
  const parts = rel.split(/[\\/]/)
  return parts[0]?.startsWith("magpie-plugin-codar-") && parts.length >= 3 ? parts.slice(0, 3).join("/") : null
}

// consumerInstall installs the packed main package into a fresh project the
// way a user does, and reports what the user gets. The release's platform
// packages are offered by a registry served from this process: the exact
// registry versions the main package names are not published while the gate
// runs, so the registry's metadata and tarballs are the packed ones, and the
// project's bunfig.toml/.npmrc point at it.
//
// A registry rather than overrides or `file:` specifiers, because a registry is
// the only install path where each manager's own platform filter decides
// (measured 2026-11-15, npm 12.2.1 / bun 1.4.4):
//   registry  npm resolves and filters by os/cpu; bun keeps the matching one
//   override  both unpack every override target handed to them, unfiltered
//   file:     the same, and npm additionally refuses a mismatched package
//             outright with EBADPLATFORM
// So here both managers must end up with exactly this machine's package, which
// is the check that optionalDependencies, the os/cpu fields and the runtime
// lookup agree. A bare unpack could never show that, and the release that
// shipped five builds in one package shipped for two minor versions because
// nothing installed it.
//
// probe.url, when given, is the URL the probe asks the started proxy for; the
// release gate leaves it out so the check never calls the vendor. It answers:
//   installed   the platform packages the manager installed
//   proxy       the build's path inside them as the plugin's binaryPath
//               resolves after installing the main package (or null)
//   started     whether the plugin started that build (its ready file arrived)
//   unavailable what proxyFetch says when there is no proxy (or undefined)
//   answer      the JSON the started proxy answered probe.url with
export const consumerInstall = async ({ dir, manager, main, platform, probe = {} }) => {
  mkdirSync(dir, { recursive: true })
  // Unpacked as it is and renamed, not with tar's -C transformation: that is
  // GNU tar's, and the tar a Windows runner has reads the argument as a member
  // name ("Not found in archive"), while the same flag in run() would be
  // mangled by cmd.exe quoting.
  const unpacked = join(dir, "package")
  const mainUnpacked = join(dir, "main-unpacked")
  execFileSync("tar", ["-xzf", main, "-C", dir])
  renameSync(unpacked, mainUnpacked)
  const manifest = JSON.parse(readFileSync(join(mainUnpacked, "package.json"), "utf8"))
  // The platform package each tarball holds, by the name in its own manifest.
  const published = {}
  for (const tgz of platform) {
    const p = JSON.parse(execFileSync("tar", ["-xzOf", tgz, "package/package.json"], { encoding: "utf8" }))
    published[p.name] = { manifest: p, tgz }
  }
  // Every platform package the main package names, as the release will have
  // published it. One it forgot is then not asked for, and the report shows it
  // was not installed: an install that quietly ignored the list cannot pass.
  // The tarball URL is absolute in the answer, as a registry's is — a package
  // manager given a relative one has nothing to resolve it against.
  const names = Object.keys(manifest.optionalDependencies ?? {}).filter((n) => published[n])
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname).slice(1)
    if (path.endsWith(".tgz")) {
      const p = published[path.slice(0, -4)]
      if (!p) return res.writeHead(404).end()
      // An explicit length: a streamed answer without one leaves a keep-alive
      // client waiting for the end of a body it was never told the size of.
      return res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": statSync(p.tgz).size }).end(readFileSync(p.tgz))
    }
    if (!names.includes(path)) return res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" }))
    const file = path
    const p = published[file].manifest
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({ name: p.name, "dist-tags": { latest: p.version }, versions: { [p.version]: { name: p.name, version: p.version, os: p.os, cpu: p.cpu, dist: { tarball: `http://${req.headers.host}/${file}.tgz` } } } }),
    )
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const registry = `http://127.0.0.1:${server.address().port}/`
  try {
    // Asynchronously, not run(): the registry above is this process's own
    // HTTP server, and a synchronous child blocks the event loop that has to
    // answer it — the install then waits for a registry that cannot speak and
    // the gate hangs with nothing to show for it.
    const said = await new Promise((resolve) => {
      const child = spawn(manager, ["add", main], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, npm_config_registry: registry } })
      let out = ""
      child.stdout.on("data", (d) => (out += d))
      child.stderr.on("data", (d) => (out += d))
      const timer = setTimeout(() => child.kill(), 120000)
      child.on("error", (e) => resolve({ status: null, out: `${out}${e.message}` }))
      child.on("exit", (code) => {
        clearTimeout(timer)
        resolve({ status: code, out })
      })
    })
    if (said.status !== 0) {
      const why = said.out.trim().split("\n").slice(-3).join(" ")
      const failed = new Error(`${manager} add ${main} failed in a scratch project (exit ${said.status ?? "signal"}): ${why}`)
      failed.exitCode = 1
      throw failed
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }

  const modules = join(dir, "node_modules")
  const installed = readdirSync(modules).filter((n) => n.startsWith("magpie-plugin-codar-"))
  const entry = pathToFileURL(join(modules, "magpie-plugin-codar", "lib", "native.mjs")).href
  const probeScript = join(dir, "probe.mjs")
  writeFileSync(
    probeScript,
    `const native = await import(${JSON.stringify(entry)})
// Both sides through realpath: on macOS /var is a symlink to /private/var, and
// a name compared as written would report a package the plugin did not open.
// A path that is not there (the checkout fallback in an install with no
// platform package) is kept as written rather than throwing the probe.
const { realpathSync } = await import("node:fs")
const real = (p) => { try { return realpathSync(p) } catch { return p } }
const here = real(${JSON.stringify(modules)})
const found = real(native.binaryPath())
// the helper that names the package is this file's, run here as source: it is
// pure, so the probe reports the same answer the gate compares against
const out = { proxy: (${packagePathOf.toString()})(found, here) }
out.started = Boolean(await native.proxy())
try {
  ${probe.url ? `const res = await native.proxyFetch(${JSON.stringify(probe.url)}); out.answer = JSON.parse(await res.text())` : ""}
} catch (e) {
  out.unavailable = e?.name === "NativeUnavailable" ? String(e.message).replace(/^codar native transport unavailable: /, "") : String(e?.stack ?? e)
}
await native.closeProxy()
console.log(JSON.stringify(out))
`,
  )
  const said = execFileSync(process.execPath, [probeScript], { cwd: dir, encoding: "utf8", env: { ...process.env, ...probe.env } })
  return { manager, installed, ...JSON.parse(said.trim().split("\n").at(-1)) }
}

// requiredFiles is every packed file the suite loads: the test files import
// the plugin, the generator script, both tests' helpers and the docs the
// style test reads; the Go sources are what the native job's `go test` reads
// in the checkout and what a reader of the tarball needs to rebuild. A file
// dropped from `files` fails here with this message rather than deep inside
// the suite as "node --test failed". Exported so the suite can keep it the
// same size as `files` (LICENSE aside: nothing installs it).
export const requiredFiles = [
  "index.mjs",
  "lib/internal.mjs",
  "lib/signinpage.mjs",
  "lib/native.mjs",
  "lib/guarded.mjs",
  "native/binary-name.mjs",
  "lib/catalog.mjs",
  "scripts/catalog.mjs",
  "scripts/tarball.mjs",
  "scripts/build-native.mjs",
  "scripts/native-packages.mjs",
  "native/go.mod",
  "native/cmd/codar-proxy/main.go",
  "native/cmd/codar-proxy/main_test.go",
  "test/plugin.test.mjs",
  "test/style.test.mjs",
  "test/native.test.mjs",
  "test/guarded.test.mjs",
  "README.md",
  "CHANGELOG.md",
]

const main = async () => {
  const options = process.argv.slice(2)
  const unknown = options.filter((a) => a !== "--require-bun" && a !== "--require-builds")
  if (unknown.length) throw usage(`unrecognized argument ${unknown.join(" ")} (only --require-bun and --require-builds are accepted)`)
  let root
  try {
    root = mkdtempSync(join(tmpdir(), "codar-tarball-"))
  } catch (e) {
    // Nowhere to work is this check failing to run, not the artifact: 2.
    const cannot = new Error(`tarball gate: no scratch directory (${e.message}); set TMPDIR to a writable path`)
    cannot.exitCode = 2
    throw cannot
  }
  try {
    // `prepublishOnly` runs this script inside `npm publish`, and npm exports
    // its own flags as npm_config_*: under `npm publish --dry-run` the nested
    // pack inherited `npm_config_dry_run` and wrote nothing, failing the gate
    // over a tarball npm had no intention of making. The gate packs for real
    // whatever the caller's npm was asked to do.
    const env = { ...process.env }
    // case-insensitive: Windows env vars can be NPM_CONFIG_DRY_RUN
    for (const key of Object.keys(env)) {
      if (/^npm_config_/i.test(key)) delete env[key]
    }
    run("npm", ["pack", "--silent", "--pack-destination", root], { cwd: pkgRoot, stdio: "ignore", env })
    // The file name comes from the directory, not from npm's output: a quiet
    // npm prints nothing, and a Windows npm prints CRLF.
    const tgz = tarballOf(root)
    run("tar", ["-xzf", join(root, tgz), "-C", root], { stdio: "inherit" })
    const pkg = join(root, "package")
    // Every file the packed suite loads, from the list above.
    for (const file of requiredFiles) {
      if (!existsSync(join(pkg, file))) throw new Error(`the tarball is missing ${file}, which the suite needs`)
    }
    // The main package must not carry the builds: each is its own platform
    // package, and five builds shipped twice is the 32 MB this replaced.
    requireNativeBin(pkg)
    console.log("native/bin: absent from the main package (the builds are platform packages)")
    // With the source tree's builds, the whole install path is checked: the
    // five packages stage from them, a package manager installs the main
    // package from the tarball above against those packages as a registry, and
    // the installed plugin must open and start this machine's build. Without
    // builds the check says so and moves on, as the suite does. Inside a packed
    // run of the suite there is nothing to stage (a checkout's builds are not
    // in the package) and nothing cheap to install twice, so it is skipped
    // there — the gate one level up has already done it.
    const bin = join(pkgRoot, "native", "bin")
    // The packed marker says the suite is running inside this check's own
    // tarball, where a checkout's builds are not and the gate one level up has
    // already done the install. It is not a licence to skip a check the caller
    // asked for by name: with --require-builds, a run that cannot do it says so
    // (2) instead of reporting a skip as a pass.
    const packedRun = process.env.CODAR_TARBALL_GATE === "1" && !requireBuilds
    if (packedRun) console.log("install: skipped, this is a packed run of the suite (see CODAR_TARBALL_GATE)")
    else if (existsSync(bin) && readdirSync(bin).length) {
      const version = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version
      const staged = join(root, "packages")
      let wrote
      try {
        wrote = stagePackages({ bin, out: staged, version })
      } catch (e) {
        // A bin directory holding something that is not a build (a stray
        // .DS_Store, a half-made copy) is a tree this check cannot run on,
        // not a broken artifact: 2, as a missing tool is.
        const cannot = usage(e.message)
        cannot.exitCode = 2
        throw cannot
      }
      const broken = checkPackages({ dir: staged, version }).filter((r) => r.state !== "present")
      if (broken.length) throw new Error(`a staged platform package is unusable: ${broken.map((r) => `${r.name} ${r.reason}`).join("; ")}`)
      const platform = wrote.map((p) => packedPackage(p.dir, join(root, "platform-tgz")))
      // Both runtimes magpie loads plugins on, not whichever happens to be
      // first: bun and npm each resolve optionalDependencies and the os/cpu
      // filter by their own rules, and the check exists to see that each of
      // them lands this machine's package and can start it.
      const managers = ["bun", "npm"].filter((cmd) => {
        try {
          execFileSync(cmd, ["--version"], { stdio: "ignore" })
          return true
        } catch {
          return false
        }
      })
      if (!managers.length) throw usage("neither bun nor npm is on PATH; the install check needs one")
      // This machine's own package, by the same naming rule the staged set was.
      const mine = platformPackages().find((p) => p.os === process.platform && p.cpu === process.arch)
      // A machine the build table does not name (a platform npm can run on and
      // the release does not build for) has no install path to check here: that
      // is this check not running, not a broken artifact, so it is exit 2.
      if (!mine) throw usage(`this machine (${process.platform}/${process.arch}) has no build in the platform table, so the install check cannot run here`)
      for (const manager of managers) {
        const report = await consumerInstall({ dir: join(root, `consumer-${manager}`), manager, main: join(root, tgz), platform })
        if (report.installed.length !== 1 || report.installed[0] !== mine.name) {
          throw new Error(`${manager} installed ${report.installed.join(", ") || "no platform package"}; this machine's is ${mine.name}`)
        }
        if (report.proxy !== `${mine.name}/bin/${mine.file}`) throw new Error(`the installed plugin opened ${report.proxy ?? "no platform package"} under ${manager}`)
        if (!report.started) throw new Error(`the installed plugin did not start ${mine.name}'s build under ${manager}`)
        console.log(`install: ${manager} installed ${mine.name} and the plugin started it`)
      }
    } else if (requireBuilds) {
      // No builds on a release run: there is no install path to check, and a
      // pass would say there was. `prepublishOnly` passes --require-builds.
      throw usage(`no builds in ${bin}: the install check needs them (run \`npm run native:all\` first)`)
    } else {
      console.log("install: skipped, no builds in this tree (--require-builds makes this an error)")
    }
    const suite = (cmd, args) => {
      try {
        // CODAR_TARBALL_GATE tells the suite it is running inside this check:
        // the test of the gate itself skips there, or the suite would run the
        // gate again from inside the tarball, each level packing another one.
        execFileSync(cmd, args, { cwd: pkg, stdio: "inherit", env: { ...process.env, CODAR_TARBALL_GATE: "1", CODAR_PLUGIN_DISABLE_NATIVE: "1" } })
      } catch (e) {
        if (e?.code === "ENOENT") {
          const missing = new Error(`${cmd} was not found in PATH; this check needs it`)
          missing.missingProgram = true
          throw missing
        }
        throw new Error(`${cmd} ${args.join(" ")} failed inside the packed tarball`)
      }
    }
    console.log("node --test (inside the packed tarball)")
    suite("node", ["--test"])
    console.log("bun test (inside the packed tarball)")
    try {
      suite("bun", ["test"])
    } catch (e) {
      // Only a Bun that is not installed is a skip on a developer's machine;
      // a Bun that ran and failed is a failure everywhere. --require-bun
      // (what CI passes) makes even the missing one an error.
      if (requireBun && e.missingProgram) {
        // "It could not run here" is not "the packed suite failed": 2 tells a
        // caller to fix the machine, 1 tells it the artifact is bad.
        const cannot = usage(e.message)
        cannot.exitCode = 2
        throw cannot
      }
      if (requireBun || !e.missingProgram) throw e
      console.log(`${e.message} — skipped (pass --require-bun to make this an error)`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isMain) {
  try {
    await main()
  } catch (e) {
    console.error(e?.message ?? e)
    // The artifact being bad is 1 (a suite that ran and failed, a tarball that
    // is wrong); an error without an assigned code is this check failing to
    // run — a temp directory it cannot write, a tool that is not there — and
    // that is 2, as a missing npm is. run() and usage() set their own, and the
    // messages that name the artifact set 1 explicitly.
    process.exitCode = e?.exitCode ?? 1
  }
}
