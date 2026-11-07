/**
 * Compiles devguard into single-file executables with `bun build --compile` (SPEC §3.1), named like the release
 * assets: `dist/devguard-<windows|linux|macos>-<x64|arm64>[.exe]`.
 *
 *   node scripts/build-exe.ts                 # both architectures of this machine's OS
 *   node scripts/build-exe.ts x64             # one architecture of this machine's OS
 *   node scripts/build-exe.ts macos-x64       # any OS and architecture Bun can cross-compile to
 *   node scripts/build-exe.ts --entry scripts/t2-probe.ts --name t2-probe x64
 *
 * Icon and version info exist only for Windows targets and need Windows APIs, so Bun only applies them when the
 * target matches the host; a cross-compiled Windows target is built without them and a warning is printed.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { releaseAssetName, releaseOs, type ReleaseArch, type ReleaseOs } from "../src/distribution.ts";
import { toSpawnSpec } from "../src/process/exec.ts";

export type Arch = ReleaseArch;
export const ARCHES: readonly Arch[] = ["x64", "arm64"];
export const OSES: readonly ReleaseOs[] = ["windows", "linux", "macos"];

export interface Target {
  os: ReleaseOs;
  arch: Arch;
}

/** Bun's name for each OS in `--target=bun-<os>-<arch>`. */
const BUN_OS: Record<ReleaseOs, string> = { windows: "windows", linux: "linux", macos: "darwin" };

/** Bun ≥ 1.2.23 keeps the embedded bundle in its own PE section, so the exe survives Authenticode signing. */
export const MIN_BUN = "1.2.23";

export interface PlanOptions {
  version: string;
  host: { platform: NodeJS.Platform; arch: string };
  targets: readonly Target[];
  entry?: string;
  name?: string;
}

export interface CompileStep {
  target: Target;
  outfile: string;
  args: string[];
  warnings: string[];
}

/** Windows file versions have four numeric parts. */
function windowsVersion(version: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`版本必須是 x.y.z，收到「${version}」`);
  return `${version}.0`;
}

export function compilePlan(opts: PlanOptions): CompileStep[] {
  const fileVersion = windowsVersion(opts.version);
  const entry = opts.entry ?? "src/cli.ts";
  const name = opts.name ?? "devguard";
  const host = `${releaseOs(opts.host.platform) ?? opts.host.platform}-${opts.host.arch}`;
  return opts.targets.map((target) => {
    const label = `${target.os}-${target.arch}`;
    const outfile = `dist/${releaseAssetName(target.os, target.arch, name)}`;
    const bunTarget = `--target=bun-${BUN_OS[target.os]}-${target.arch}`;
    const args = ["build", entry, "--compile", bunTarget, `--outfile=${outfile}`];
    if (target.os !== "windows") return { target, outfile, args, warnings: [] };
    if (label !== host) {
      const warning = `${label} 是交叉編譯（主機為 ${host}），Bun 無法設定圖示與版本資訊；請在 ${target.arch} 的 Windows 上建置`;
      return { target, outfile, args, warnings: [warning] };
    }
    args.push(
      "--windows-icon=assets/devguard.ico",
      `--windows-title=${name}`,
      "--windows-publisher=devguard",
      `--windows-version=${fileVersion}`,
      "--windows-description=Checks and fixes coding-standard setup",
      "--windows-copyright=devguard contributors",
    );
    return { target, outfile, args, warnings: [] };
  });
}

/**
 * The targets named on the command line, each `<arch>` (this machine's OS, `hostOs`) or `<os>-<arch>`; none means both
 * architectures of `hostOs`. Throws on an unknown name, or on a bare architecture where devguard has no release.
 */
export function parseTargets(names: readonly string[], hostOs: ReleaseOs | undefined): Target[] {
  const onHost = (arch: Arch): Target => {
    if (hostOs === undefined) throw new Error("這台機器的作業系統沒有對應的發佈目標，請寫成 <os>-<arch>");
    return { os: hostOs, arch };
  };
  if (names.length === 0) return ARCHES.map(onHost);
  return names.map((n) => {
    if (ARCHES.includes(n as Arch)) return onHost(n as Arch);
    const [os, arch, ...rest] = n.split("-");
    if (rest.length === 0 && OSES.includes(os as ReleaseOs) && ARCHES.includes(arch as Arch)) {
      return { os: os as ReleaseOs, arch: arch as Arch };
    }
    const known = [...ARCHES, ...OSES.flatMap((o) => ARCHES.map((a) => `${o}-${a}`))];
    throw new Error(`不認得的目標「${n}」，可用：${known.join("、")}`);
  });
}

/** True when `actual` (e.g. `1.4.3`) is at least `minimum`. */
export function meetsMinimum(actual: string, minimum: string): boolean {
  const a = actual.trim().split(/[.-]/).map(Number);
  const m = minimum.split(".").map(Number);
  for (let i = 0; i < m.length; i++) {
    const x = a[i] ?? 0;
    const y = m[i] ?? 0;
    if (Number.isNaN(x)) return false;
    if (x !== y) return x > y;
  }
  return true;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** Names Bun is started by, in order. `npm i -g bun` puts only a `bun.cmd` shim on PATH on Windows. */
export function bunCandidates(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["bun", "bun.cmd"] : ["bun"];
}

/** The outcome of `<candidate> --version`. */
export interface BunProbe {
  error?: Error;
  status: number | null;
  stdout: string;
}

export interface Bun {
  /** The name that started Bun, used again for every compile step. */
  file: string;
  version: string;
}

/** The first candidate whose `--version` succeeds; undefined when none does. */
export function findBun(candidates: readonly string[], probe: (file: string) => BunProbe): Bun | undefined {
  for (const file of candidates) {
    const r = probe(file);
    if (r.error === undefined && r.status === 0) return { file, version: r.stdout.trim() };
  }
  return undefined;
}

/** Runs Bun synchronously; a `.cmd` shim goes through cmd.exe, since it cannot be started directly. */
function runBun(file: string, args: string[], cwd: string, inherit: boolean) {
  const spec = toSpawnSpec({ file, args, cwd });
  return spawnSync(spec.file, spec.args, {
    cwd,
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
  });
}

function requireBun(root: string): Bun {
  const candidates = bunCandidates(process.platform);
  const bun = findBun(candidates, (file) => runBun(file, ["--version"], root, false));
  if (bun === undefined) {
    fail(`找不到 Bun（試過 ${candidates.join("、")}）。打包需要 Bun ≥ ${MIN_BUN}（https://bun.com）。`);
  }
  if (!meetsMinimum(bun.version, MIN_BUN)) fail(`Bun ${bun.version} 太舊，需要 ≥ ${MIN_BUN}。`);
  return bun;
}

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { entry: { type: "string" }, name: { type: "string" } },
  });
  let targets: Target[];
  try {
    targets = parseTargets(positionals, releaseOs(process.platform));
  } catch (e) {
    fail((e as Error).message);
  }

  const root = join(import.meta.dirname, "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  const plan = compilePlan({
    version: pkg.version,
    host: { platform: process.platform, arch: process.arch },
    targets,
    entry: values.entry,
    name: values.name,
  });

  const bun = requireBun(root);
  const via = bun.file === "bun" ? "" : `（${bun.file}）`;
  process.stdout.write(`Bun ${bun.version}${via}\n`);
  mkdirSync(join(root, "dist"), { recursive: true });
  for (const step of plan) {
    for (const w of step.warnings) process.stderr.write(`警告：${w}\n`);
    process.stdout.write(`> ${bun.file} ${step.args.join(" ")}\n`);
    const r = runBun(bun.file, step.args, root, true);
    if (r.status !== 0) fail(`${step.target.os}-${step.target.arch} 打包失敗`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
