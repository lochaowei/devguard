import { join } from "node:path";
import {
  findFirst,
  literalProperty,
  objectProperty,
  parseJsonc,
  propertyValueIndex,
  pullsFromElsewhere,
  searchDirs,
} from "../config-files.ts";
import type { KeyPath, Repair } from "../../fix/repair.ts";
import { setAt, type SettingsJudge } from "../judge.ts";
import { readIfExists } from "../../shared/fs.ts";
import { isRecord } from "../../shared/guards.ts";
import { coverageGateOff } from "../../testing/coverage.ts";

const METRICS = ["lines", "branches", "functions", "statements"] as const;

const CODE_EXTS = ["ts", "mts", "cts", "js", "mjs", "cjs"];

/** Where a thresholds object lives: the file, its label in findings, and its key path inside the file. */
interface Thresholds {
  file: string;
  label: string;
  at: KeyPath;
}

/** Judges the four metrics in a thresholds object literal against the declared `coverage.lines`. */
function judgeThresholds(block: string, t: Thresholds, judge: SettingsJudge): void {
  const all100 = literalProperty(block, "100") === true;
  for (const metric of METRICS) {
    const value = all100 ? 100 : literalProperty(block, metric);
    const what = `${t.label}.${metric}`;
    const repair = setAt(t.file, [...t.at, metric]);
    if (value === undefined && propertyValueIndex(block, metric) === undefined)
      judge.disabled("coverage.lines", t.file, what, repair);
    else if (typeof value !== "number" || value < 0) judge.unconfirmed(t.file, ` ${what}（不是可比較的百分比）`);
    else judge.compare("coverage.lines", value, t.file, what, repair);
  }
}

/** Finds the thresholds object inside a config's text, or says why it cannot. */
function judgeConfig(text: string, path: readonly string[], t: Thresholds, judge: SettingsJudge): void {
  let block: string | undefined = text;
  for (const key of path) block = block === undefined ? undefined : objectProperty(block, key);
  if (block !== undefined) judgeThresholds(block, t, judge);
  else if (pullsFromElsewhere(text) || propertyValueIndex(text, path[0] ?? "") !== undefined)
    judge.unconfirmed(t.file, ` ${t.label}`);
  else {
    const all = setAt(t.file, t.at, (want) => Object.fromEntries(METRICS.map((m) => [m, want])));
    judge.disabled("coverage.lines", t.file, t.label, all);
  }
}

const SCOPE_RULE = "settings/coverage-include";

/**
 * Without an explicit file list, Vitest and Jest count only the files a test imports, so an untested file never lowers
 * coverage (#45). The setting is required; the files to list are the project's, so the printed value is an example.
 * `s.at` is the object that should hold `key`; `block` is that object's text.
 */
function judgeScope(text: string, block: string | undefined, key: string, s: Thresholds, judge: SettingsJudge): void {
  if (block === undefined || pullsFromElsewhere(text) || propertyValueIndex(block, key) !== undefined) return;
  const { label } = s;
  const repair: Repair = { op: "set", file: s.file, path: [...s.at, key], value: ["src/**/*.{ts,tsx}"] };
  judge.missingSetting(
    SCOPE_RULE,
    s.file,
    `${label} 沒有設定：只有被測試 import 的檔案會算進覆蓋率`,
    `在 ${s.file} 設定 ${label}，列出元件所有的原始碼`,
    [repair],
  );
}

async function checkVitest(root: string, judge: SettingsJudge): Promise<void> {
  const names = ["vitest", "vite"].flatMap((tool) => CODE_EXTS.map((ext) => `${tool}.config.${ext}`));
  const found = await findFirst(root, names, judge.dir);
  if (!found) {
    judge.missingFile(judge.path("vitest.config.ts"), " Vitest 設定檔（覆蓋率門檻設在 coverage.thresholds）");
    return;
  }
  const at = ["test", "coverage", "thresholds"];
  judgeConfig(found.text, ["thresholds"], { file: found.file, label: "Vitest coverage.thresholds", at }, judge);
  const coverage = objectProperty(found.text, "coverage");
  judgeScope(
    found.text,
    coverage,
    "include",
    { file: found.file, label: "Vitest coverage.include", at: ["test", "coverage"] },
    judge,
  );
}

async function checkJest(root: string, judge: SettingsJudge): Promise<void> {
  const label = "Jest coverageThreshold.global";
  const path = ["coverageThreshold", "global"];
  const names = [...CODE_EXTS, "json"].map((ext) => `jest.config.${ext}`);
  for (const { fsDir, relDir } of searchDirs(root, judge.dir)) {
    const pkg = parseJsonc((await readIfExists(join(fsDir, "package.json"))) ?? "");
    if (isRecord(pkg) && isRecord(pkg.jest)) {
      const t = { file: `${relDir}package.json`, label, at: ["jest", ...path] };
      const text = JSON.stringify(pkg.jest);
      judgeConfig(text, path, t, judge);
      judgeScope(text, text, "collectCoverageFrom", { ...t, label: "Jest collectCoverageFrom", at: ["jest"] }, judge);
      return;
    }
    const found = await findFirst(fsDir, names);
    if (found) {
      const file = relDir + found.name;
      judgeConfig(found.text, path, { file, label, at: path }, judge);
      judgeScope(
        found.text,
        found.text,
        "collectCoverageFrom",
        { file, label: "Jest collectCoverageFrom", at: [] },
        judge,
      );
      return;
    }
  }
  judge.missingFile(judge.path("jest.config.js"), " Jest 設定檔（覆蓋率門檻設在 coverageThreshold.global）");
}

/**
 * The four coverage thresholds against the declared `coverage.lines`, for Vitest or Jest. With the coverage gate off
 * (`coverageGateOff`) no config file, thresholds or file list is needed.
 */
export async function checkCoverage(root: string, judge: SettingsJudge): Promise<void> {
  if (coverageGateOff(judge.declared("coverage.lines"))) return;
  const tool = judge.declared("test.tool");
  if (tool === "vitest") await checkVitest(root, judge);
  else if (tool === "jest") await checkJest(root, judge);
}
