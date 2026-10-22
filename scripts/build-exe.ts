/**
 * Compiles devguard into single-file Windows executables with `bun build --compile` (SPEC §3.1).
 *
 *   node scripts/build-exe.ts                 # windows-x64 and windows-arm64
 *   node scripts/build-exe.ts x64             # one target
 *   node scripts/build-exe.ts --entry scripts/t2-probe.ts --name t2-probe x64
 *
 * Icon and version info need Windows APIs, so Bun only applies them when the target matches the host;
 * cross-compiled targets are built without them and a warning is printed.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export type Arch = "x64" | "arm64";
export const ARCHES: readonly Arch[] = ["x64", "arm64"];

/** Bun ≥ 1.2.23 keeps the embedded bundle in its own PE section, so the exe survives Authenticode signing. */
export const MIN_BUN = "1.2.23";

export interface PlanOptions {
  version: string;
  hostArch: string;
  targets: readonly Arch[];
  entry?: string;
  name?: string;
}

export interface CompileStep {
  target: Arch;
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
  return opts.targets.map((target) => {
    const outfile = `dist/${name}-windows-${target}.exe`;
    const args = ["build", entry, "--compile", `--target=bun-windows-${target}`, `--outfile=${outfile}`];
    if (target !== opts.hostArch) {
      const warning = `windows-${target} 是交叉編譯（主機為 ${opts.hostArch}），Bun 無法設定圖示與版本資訊；請在 ${target} 的 Windows 上建置`;
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

function bunVersion(): string {
  const r = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (r.error || r.status !== 0) fail(`找不到 Bun。打包需要 Bun ≥ ${MIN_BUN}（https://bun.com）。`);
  const version = r.stdout.trim();
  if (!meetsMinimum(version, MIN_BUN)) fail(`Bun ${version} 太舊，需要 ≥ ${MIN_BUN}。`);
  return version;
}

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { entry: { type: "string" }, name: { type: "string" } },
  });
  const targets = positionals.length === 0 ? ARCHES : positionals;
  const unknown = targets.find((t) => !ARCHES.includes(t as Arch));
  if (unknown !== undefined) fail(`不認得的目標「${unknown}」，可用：${ARCHES.join("、")}`);

  const root = join(import.meta.dirname, "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  const plan = compilePlan({
    version: pkg.version,
    hostArch: process.arch,
    targets: targets as Arch[],
    entry: values.entry,
    name: values.name,
  });

  process.stdout.write(`Bun ${bunVersion()}\n`);
  mkdirSync(join(root, "dist"), { recursive: true });
  for (const step of plan) {
    for (const w of step.warnings) process.stderr.write(`警告：${w}\n`);
    process.stdout.write(`> bun ${step.args.join(" ")}\n`);
    const r = spawnSync("bun", step.args, { cwd: root, stdio: "inherit" });
    if (r.status !== 0) fail(`windows-${step.target} 打包失敗`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
