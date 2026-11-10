import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JavaTarget } from "../src/settings/java/common.ts";
import { pmdRulesetXml } from "../src/settings/java/generate.ts";

/** PMD and Java are not dependencies of this repo: these run only where `pmd` (or `$PMD_HOME/bin/pmd`) works. */
const pmdCommand = process.env.PMD_HOME ? join(process.env.PMD_HOME, "bin", "pmd") : "pmd";
const pmdInstalled = spawnSync(pmdCommand, ["--version"], { encoding: "utf8", shell: true }).status === 0;

const BANNED = ["sun.*", "java.util.Date", "javax.xml.bind.*"];

/** Just enough of a target for the ruleset generator: the declared limits and banned APIs. */
const target = {
  component: {
    effective: {
      "complexity.cognitive": { value: 15 },
      "complexity.cyclomatic": { value: 10 },
      "deps.bannedApis": { value: BANNED },
    },
  },
  defs: {},
} as unknown as JavaTarget;

/** One Java file per case: the imports it has, and whether BannedApis must flag it. */
const CASES: readonly { name: string; imports: string[]; flagged: boolean }[] = [
  { name: "ExactClass", imports: ["import java.util.Date;"], flagged: true },
  { name: "WildcardPackage", imports: ["import javax.xml.bind.*;"], flagged: true },
  { name: "ClassUnderWildcardPackage", imports: ["import sun.misc.Unsafe;"], flagged: true },
  { name: "WildcardOfBannedRoot", imports: ["import sun.*;"], flagged: true },
  { name: "StaticImport", imports: ["import static java.util.Date.parse;"], flagged: true },
  {
    name: "NotBanned",
    imports: [
      "import java.util.List;",
      "import java.util.Dates.X;",
      "import java.sql.Date;",
      "import static java.util.Collections.emptyList;",
    ],
    flagged: false,
  },
];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface PmdReport {
  files: { filename: string; violations: { rule: string }[] }[];
}

describe.skipIf(!pmdInstalled)("BannedApis rule on real PMD", () => {
  it("flags imports of banned APIs and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "devguard-pmd-"));
    dirs.push(dir);
    const src = join(dir, "src");
    mkdirSync(src);
    for (const c of CASES) writeFileSync(join(src, `${c.name}.java`), `${c.imports.join("\n")}\nclass ${c.name} {}\n`);
    writeFileSync(join(dir, "ruleset.xml"), pmdRulesetXml(target));

    const run = spawnSync(
      pmdCommand,
      ["check", "-d", src, "-R", join(dir, "ruleset.xml"), "-f", "json", "--no-cache", "--no-progress"],
      { encoding: "utf8", shell: true },
    );
    // 0: no violations, 4: violations found; anything else is PMD failing (for example on the ruleset).
    expect([0, 4], run.stderr).toContain(run.status);
    const report = JSON.parse(run.stdout) as PmdReport;
    const flagged = report.files
      .filter((f) => f.violations.some((v) => v.rule === "BannedApis"))
      .map((f) => basename(f.filename, ".java"))
      .sort();
    expect(flagged).toEqual(
      CASES.filter((c) => c.flagged)
        .map((c) => c.name)
        .sort(),
    );
  });
});
