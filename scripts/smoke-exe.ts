/**
 * Smoke test for a compiled devguard exe (SPEC §3.1): `--version` and `check` on a sample project,
 * run with every Node installation removed from PATH to show the exe does not need Node.
 *
 *   node scripts/smoke-exe.ts                          # dist/devguard-windows-<host arch>.exe
 *   node scripts/smoke-exe.ts dist/devguard-windows-arm64.exe
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface SmokeResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** A TypeScript project whose tool configs and lockfile meet team@1.0.0. */
const SAMPLE: Readonly<Record<string, string>> = {
  ".devguard.yaml": "standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: typescript\n",
  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      strict: true,
      noUncheckedIndexedAccess: true,
      noImplicitOverride: true,
      noFallthroughCasesInSwitch: true,
    },
  }),
  ".prettierrc": '{ "printWidth": 120, "endOfLine": "lf" }',
  "eslint.config.js":
    'export default [tseslint.configs.strictTypeChecked, { rules: { complexity: ["error", 10], "sonarjs/cognitive-complexity": ["error", 15] } }];\n',
  "vitest.config.ts":
    "export default { test: { coverage: { thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 } } } };\n",
  // Satisfies the deps layer; the temp dir is not a git repo, so existing counts as committed.
  "package-lock.json": "{}",
};

function run(command: readonly string[], args: string[], env: NodeJS.ProcessEnv) {
  const [file = "", ...pre] = command;
  const r = spawnSync(file, [...pre, ...args], { encoding: "utf8", env, timeout: 30_000 });
  const output = r.error ? `無法執行：${r.error.message}` : `exit ${String(r.status)}\n${r.stdout}${r.stderr}`;
  return { status: r.error ? null : r.status, stdout: r.stdout, output };
}

/** Runs the smoke checks against `command` (an exe path, optionally preceded by an interpreter). */
export function runSmoke(command: readonly string[], expectedVersion: string, env = process.env): SmokeResult[] {
  const dir = mkdtempSync(join(tmpdir(), "devguard-smoke-"));
  const empty = mkdtempSync(join(tmpdir(), "devguard-smoke-empty-"));
  try {
    for (const [name, text] of Object.entries(SAMPLE)) writeFileSync(join(dir, name), text);
    const version = run(command, ["--version"], env);
    const sample = run(command, ["check", "--cwd", dir], env);
    const missing = run(command, ["check", "--cwd", empty], env);
    return [
      { name: "--version", ok: version.stdout === `devguard ${expectedVersion}\n`, detail: version.output },
      { name: "check（範例專案）", ok: sample.status === 0 && sample.stdout.includes("通過"), detail: sample.output },
      {
        name: "check（缺少宣告）",
        ok: missing.status === 1 && missing.stdout.includes(".devguard.yaml"),
        detail: missing.output,
      },
    ];
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
}

/** PATH with every directory that holds `node.exe` removed. */
export function pathWithoutNode(path: string, hasNode = (dir: string) => existsSync(join(dir, "node.exe"))): string {
  return path
    .split(delimiter)
    .filter((dir) => dir !== "" && !hasNode(dir))
    .join(delimiter);
}

function main(): void {
  const root = join(import.meta.dirname, "..");
  const exe = resolve(process.argv[2] ?? join(root, "dist", `devguard-windows-${process.arch}.exe`));
  if (!existsSync(exe)) {
    process.stderr.write(`找不到 ${exe}，請先執行 npm run build:exe\n`);
    process.exit(1);
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  // A spread copy of process.env is case-sensitive, so drop every spelling of PATH before setting it.
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.toUpperCase() !== "PATH"),
  );
  env.Path = pathWithoutNode(process.env.PATH ?? "");

  const results = runSmoke([exe], pkg.version, env);
  for (const r of results) {
    process.stdout.write(`${r.ok ? "通過" : "失敗"}  ${r.name}\n`);
    if (!r.ok) process.stdout.write(`${r.detail.replace(/^/gm, "      ")}\n`);
  }
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
