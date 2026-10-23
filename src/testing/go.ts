import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Finding } from "../report/finding.ts";
import { judgeCoverage, readReport, reportMissing, testsFailed, testToolFailed } from "./coverage.ts";
import type { TestChecker, TestContext, TestTarget } from "./types.ts";

/** The Go convention for generated files (https://go.dev/s/generatedcode). */
const GENERATED = /^\/\/ Code generated .* DO NOT EDIT\.\r?$/m;

const MOCKS = /(^|\/)mocks\//;

/** What `go test` says failed: test names (`--- FAIL: TestX`), else packages that did not build. */
function failedTests(stdout: string): string[] {
  const tests = [...stdout.matchAll(/^\s*--- FAIL: (\S+)/gm)].map((m) => m[1] ?? "");
  if (tests.length > 0) return tests;
  return [...stdout.matchAll(/^FAIL\t(\S+ \[(?:build|setup) failed\])/gm)].map((m) => m[1] ?? "");
}

function modulePath(goMod: string | undefined): string | undefined {
  return /^module\s+(\S+)/m.exec(goMod ?? "")?.[1];
}

/** The repo file a profile entry such as `example.com/app/x/y.go` refers to, when it is in this module. */
function repoFile(target: TestTarget, module: string | undefined, importPath: string): string | undefined {
  if (module === undefined || !importPath.startsWith(`${module}/`)) return undefined;
  return target.dir + importPath.slice(module.length + 1);
}

/** The profile without blocks from generated files and `mocks/` directories (SPEC §6.2). */
async function filterProfile(target: TestTarget, ctx: TestContext, profile: string) {
  const module = modulePath(await readReport(join(ctx.cwd, target.dir, "go.mod")));
  const judged = new Map<string, Promise<boolean>>();
  const judge = async (importPath: string): Promise<boolean> => {
    const file = repoFile(target, module, importPath);
    if (MOCKS.test(file ?? importPath)) return true;
    return file !== undefined && GENERATED.test((await readReport(join(ctx.cwd, file))) ?? "");
  };
  const isExcluded = (importPath: string): Promise<boolean> => {
    const result = judged.get(importPath) ?? judge(importPath);
    judged.set(importPath, result);
    return result;
  };
  const [mode = "mode: set", ...blocks] = profile.split(/\r?\n/).filter((l) => l.trim() !== "");
  const kept: string[] = [];
  for (const block of blocks) {
    const importPath = /^(.+):\d+\.\d+,\d+\.\d+ \d+ \d+$/.exec(block)?.[1];
    if (importPath === undefined || !(await isExcluded(importPath))) kept.push(block);
  }
  return { mode, kept };
}

/** `go test -coverprofile`, then `go tool cover -func` on the filtered profile; the CLI judges its total. */
export const goTests: TestChecker = {
  language: "go",
  async check(target: TestTarget, ctx: TestContext): Promise<Finding[]> {
    const run = (args: string[]) => ctx.tools.run({ language: "go", tool: "go", dir: target.dir, args });
    const profilePath = join(ctx.reportDir, "cover.out");
    const test = await run(["test", `-coverprofile=${profilePath}`, "./..."]);
    const findings: Finding[] = [];
    if (test.code !== 0) {
      const failed = failedTests(test.stdout);
      if (failed.length === 0) return [testToolFailed(target, "go test", test)];
      findings.push(testsFailed(target, "go test ./...", failed));
    }
    const profile = await readReport(profilePath);
    if (profile === undefined) {
      return [...findings, reportMissing(target, "go test -coverprofile", "修正上面的測試失敗後再執行")];
    }
    const { mode, kept } = await filterProfile(target, ctx, profile);
    if (kept.length === 0) return findings;
    const filtered = join(ctx.reportDir, "cover.filtered.out");
    await writeFile(filtered, [mode, ...kept, ""].join("\n"));
    const cover = await run(["tool", "cover", `-func=${filtered}`]);
    const total = /^total:\s+\(statements\)\s+([\d.]+)%/m.exec(cover.stdout)?.[1];
    if (cover.code !== 0 || total === undefined) return [...findings, testToolFailed(target, "go tool cover", cover)];
    return [...findings, ...judgeCoverage(target, [{ metric: "lines", percent: Number(total) }])];
  },
};
