// Checks the install path on a machine the suite cannot use: tarballs packed
// from native/bin, installed by npm into a scratch project, then the installed
// plugin's own binaryPath opened and run. The packed-install test in
// test/native.test.mjs is skipped on Windows (npm is a .cmd shim there and the
// check's own local registry cannot be reached through it), so without this the
// Windows install — optionalDependencies, the tarball's file list, npm's shim
// handling — was checked nowhere.
//
// It does not need a registry: npm installs the two local tarballs directly,
// which is the part the suite's registry-based check cannot do on Windows.
//
// Usage: node scripts/check-packed-install.mjs   (exit 0 = installed and ran)
//        CODAR_NATIVE_OUT names where the builds are, as everywhere else.
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const require = createRequire(import.meta.url)
const pkgRoot = join(require.resolve("../package.json"), "..")

const fail = (code, message) => {
  console.error(`check-packed-install: ${message}`)
  process.exit(code)
}

const { buildDir } = await import("./build-native.mjs")
const bin = buildDir(pkgRoot)
if (!existsSync(bin)) fail(2, `no builds in ${bin}; this check needs them (run \`npm run native:all\` first)`)

const { packageName } = await import("../native/binary-name.mjs")
const { packedPackage } = await import("./tarball.mjs")
const platform = packageName(process.platform, process.arch)
const platformDir = join(pkgRoot, "native", "packages", platform)
// native/packages is generated, not checked in: a fresh clone (and CI) has
// none. Staging writes them from the same builds this check packs.
if (!existsSync(join(platformDir, "package.json"))) {
  const { stageFromTree } = await import("./native-packages.mjs")
  try {
    stageFromTree()
  } catch (e) {
    fail(2, `the platform packages could not be staged from ${bin}: ${e.message}`)
  }
  if (!existsSync(join(platformDir, "package.json"))) fail(2, `no package directory for ${platform} after staging`)
}

const work = mkdtempSync(join(tmpdir(), "codar-packed-install-"))
try {
  const tarballs = [packedPackage(pkgRoot, work), packedPackage(platformDir, work)]
  const project = join(work, "project")
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "codar-install-check", private: true, version: "0.0.0" }, null, 2))

  // npm.cmd on Windows: one command string through the shell, as the tarball
  // gate's own run() does, or the spawn cannot find it at all.
  const npmArgs = ["install", "--no-audit", "--no-fund", "--ignore-scripts", ...tarballs]
  const shell = process.platform === "win32"
  const out = shell
    ? spawnSync(["npm", ...npmArgs.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a))].join(" "), { cwd: project, encoding: "utf8", shell: true })
    : spawnSync("npm", npmArgs, { cwd: project, encoding: "utf8" })
  if (out.status !== 0) fail(1, `npm could not install the packed pair (exit ${out.status}): ${out.stderr || out.stdout}`)

  const installedMain = join(project, "node_modules", "magpie-plugin-codar")
  const installedPlatform = join(project, "node_modules", platform)
  if (!existsSync(join(installedMain, "package.json"))) fail(1, "the main package was not installed")
  if (!existsSync(join(installedPlatform, "package.json"))) fail(1, `${platform} was not installed beside it`)

  // The plugin's own answer, from the installed copy: this is what the host
  // calls to find the proxy, and it must land inside the platform package
  // rather than in the checkout that packed it.
  const native = await import(pathToFileURL(join(installedMain, "lib", "native.mjs")).href)
  const file = native.binaryPath()
  // Both sides through realpath: the temp root is a symlink on macOS, and the
  // plugin answers the resolved path.
  const real = (p) => { try { return realpathSync(p) } catch { return p } }
  if (!file || !real(file).startsWith(real(installedPlatform))) fail(1, `binaryPath() answered ${file}, outside ${installedPlatform}`)
  const stat = existsSync(file) ? readFileSync(file).length : 0
  if (stat < 1_000_000) fail(1, `the installed proxy is ${stat} bytes`)

  // It runs: -version prints the source fingerprint the release scripts embed.
  // A build that cannot start at all (wrong machine, truncated, not executable)
  // fails here rather than at the person's first chat.
  const ran = spawnSync(file, ["-version"], { encoding: "utf8", timeout: 30_000 })
  const said = `${ran.stdout ?? ""}${ran.stderr ?? ""}`
  if (ran.status !== 0) fail(1, `the installed proxy did not run (exit ${ran.status}): ${said.trim()}`)
  if (!/codar-proxy-source:[0-9a-f]{64}/.test(said)) fail(1, `the installed proxy printed no source fingerprint: ${said.trim()}`)
  console.log(`check-packed-install: ${platform} installed and ran (${said.trim()})`)
} finally {
  // Windows keeps a handle on a file its child just closed; retry, and never
  // let cleanup decide the result.
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {}
}
