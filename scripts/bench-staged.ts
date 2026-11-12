/**
 * Times `devguard check --staged` (run from source) on this repo with N new files staged (#205).
 *
 *   node scripts/bench-staged.ts                 # 1, 5 and 10 staged files
 *   node scripts/bench-staged.ts 1 10 25         # the sizes given
 *   node scripts/bench-staged.ts --partial 5     # each file also has an unstaged change
 *
 * The files are staged in a copy of the index (`GIT_INDEX_FILE`), so the real index is left alone; the files
 * themselves are written under src/ and removed afterwards. `--partial` makes the working-tree version differ from the
 * staged one, which is the case where a tool has to be given the staged text through stdin. Set `BENCH_VERBOSE` to
 * see the output of each `check --staged` (it is always shown when the check fails).
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
/** Inside `src` so the repo's tsconfig, ESLint and Prettier cover the files like any other source file. */
const BENCH_DIR = "src/bench-staged-tmp";
const DEFAULT_SIZES = [1, 5, 10];

export interface BenchRow {
  files: number;
  seconds: number;
  exitCode: number;
}

function git(args: readonly string[], env: NodeJS.ProcessEnv): string {
  const r = spawnSync("git", args, { cwd: ROOT, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** Writes and stages `count` files; with `partial`, each then gets a change that is not staged. */
function stage(count: number, partial: boolean, env: NodeJS.ProcessEnv): void {
  mkdirSync(join(ROOT, BENCH_DIR), { recursive: true });
  const names = Array.from({ length: count }, (_, i) => `${BENCH_DIR}/file-${String(i)}.ts`);
  names.forEach((name, i) => {
    writeFileSync(join(ROOT, name), `export const value${String(i)} = ${String(i)};\n`);
  });
  git(["add", "--", ...names], env);
  if (!partial) return;
  names.forEach((name, i) => {
    writeFileSync(join(ROOT, name), `export const value${String(i)} = ${String(i)};\n// not staged\n`);
  });
}

/** One timed `check --staged` with `count` files staged in a throwaway copy of the index. */
export function benchOnce(count: number, partial: boolean): BenchRow {
  const realIndex = resolve(ROOT, git(["rev-parse", "--git-path", "index"], process.env));
  const index = join(ROOT, ".scratch", "repro", `bench-index-${String(process.pid)}`);
  mkdirSync(join(ROOT, ".scratch", "repro"), { recursive: true });
  if (existsSync(realIndex)) copyFileSync(realIndex, index);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    stage(count, partial, env);
    const start = performance.now();
    const r = spawnSync(process.execPath, ["src/cli.ts", "check", "--staged"], { cwd: ROOT, env, encoding: "utf8" });
    const seconds = (performance.now() - start) / 1000;
    if (r.status !== 0 || process.env.BENCH_VERBOSE !== undefined) process.stderr.write(r.stdout + r.stderr);
    return { files: count, seconds, exitCode: r.status ?? 1 };
  } finally {
    rmSync(join(ROOT, BENCH_DIR), { recursive: true, force: true });
    rmSync(index, { force: true });
    rmSync(`${index}.lock`, { force: true });
  }
}

export function renderTable(rows: readonly BenchRow[]): string {
  const lines = rows.map((r) => `| ${String(r.files)} | ${r.seconds.toFixed(1)} | ${String(r.exitCode)} |`);
  return ["| staged files | seconds | exit code |", "| ---: | ---: | ---: |", ...lines].join("\n") + "\n";
}

function main(argv: readonly string[]): void {
  const partial = argv.includes("--partial");
  const given = argv.filter((a) => a !== "--partial").map(Number);
  if (given.some((n) => !Number.isInteger(n) || n < 1)) throw new Error("sizes must be positive integers");
  const rows: BenchRow[] = [];
  for (const size of given.length > 0 ? given : DEFAULT_SIZES) {
    const row = benchOnce(size, partial);
    rows.push(row);
    process.stdout.write(`${String(row.files)} files: ${row.seconds.toFixed(1)} s (exit ${String(row.exitCode)})\n`);
  }
  process.stdout.write(`\n${partial ? "partially staged" : "fully staged"}\n${renderTable(rows)}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
