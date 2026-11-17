/**
 * Times `devguard check --only format` on a throwaway TypeScript project with N files Prettier would change (#209).
 *
 *   node scripts/bench-format.ts                      # 1, 10 and 19 unformatted files
 *   node scripts/bench-format.ts 1 25 50              # the sizes given
 *   node scripts/bench-format.ts --cli <cli.ts> 19    # another checkout's CLI, to compare before and after
 *
 * The project is written under `.scratch/repro/` and borrows this repo's node_modules, so the real Prettier runs. Each
 * size is timed three times and the median is reported, next to `prettier --list-different .` on the same files.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const DEFAULT_SIZES = [1, 10, 19];
const RUNS = 3;
const PRETTIER = join(ROOT, "node_modules", "prettier", "bin", "prettier.cjs");

/** Clean on line 1, unformatted on line 2. */
const UNFORMATTED = "export const a = 1;\nexport  const b=2\n";

function project(count: number): string {
  const dir = join(ROOT, ".scratch", "repro", `bench-format-${String(process.pid)}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "junction");
  const files: Record<string, string> = {
    ".gitignore": "node_modules/\n",
    ".devguard.yaml": "standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: typescript\n",
    "package.json": '{ "type": "module" }\n',
    ".prettierrc": '{ "printWidth": 120, "endOfLine": "lf" }\n',
  };
  for (let i = 0; i < count; i++) files[`src/file-${String(i)}.ts`] = UNFORMATTED;
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  // Its own repo: under .scratch/ the files are ignored by this one, and `check` only looks at files git lists.
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
  ]) {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
  return dir;
}

/** Median wall-clock seconds of `RUNS` runs, with the output of the last one. */
function time(args: readonly string[], cwd: string): { seconds: number; output: string } {
  const seconds: number[] = [];
  let output = "";
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    const r = spawnSync(process.execPath, args, { cwd, encoding: "utf8" });
    seconds.push((performance.now() - start) / 1000);
    output = r.stdout + r.stderr;
  }
  return { seconds: seconds.sort((a, b) => a - b)[Math.floor(RUNS / 2)] ?? 0, output };
}

function main(argv: readonly string[]): void {
  const at = argv.indexOf("--cli");
  const cli = at === -1 ? join(ROOT, "src", "cli.ts") : resolve(argv[at + 1] ?? "");
  const given = argv.filter((_, i) => at === -1 || (i !== at && i !== at + 1)).map(Number);
  if (given.some((n) => !Number.isInteger(n) || n < 1)) throw new Error("sizes must be positive integers");
  const lines = ["| unformatted files | check --only format (s) | prettier --list-different . (s) | findings |"];
  lines.push("| ---: | ---: | ---: | ---: |");
  for (const size of given.length > 0 ? given : DEFAULT_SIZES) {
    const dir = project(size);
    try {
      const check = time([cli, "check", "--only", "format"], dir);
      const prettier = time([PRETTIER, "--list-different", "."], dir);
      // Every finding has to be located on line 2, or the run did not do the work being timed.
      const located = check.output.split("\n").filter((l) => /\[prettier\/format\] src\/file-\d+\.ts:2\b/.test(l));
      if (located.length !== size) process.stderr.write(check.output);
      lines.push(
        `| ${String(size)} | ${check.seconds.toFixed(1)} | ${prettier.seconds.toFixed(1)} | ${String(located.length)} |`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

main(process.argv.slice(2));
