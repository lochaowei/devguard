import { join } from "node:path";
import {
  findFirst,
  isRecord,
  literalProperty,
  objectProperty,
  parseJsonc,
  propertyValueIndex,
  pullsFromElsewhere,
  readIfExists,
} from "../config-files.ts";
import type { SettingsJudge } from "../judge.ts";

const METRICS = ["lines", "branches", "functions", "statements"] as const;

const CODE_EXTS = ["ts", "mts", "cts", "js", "mjs", "cjs"];

/** Judges the four metrics in a thresholds object literal against the declared `coverage.lines`. */
function judgeThresholds(block: string, file: string, label: string, judge: SettingsJudge): void {
  const all100 = literalProperty(block, "100") === true;
  for (const metric of METRICS) {
    const value = all100 ? 100 : literalProperty(block, metric);
    const what = `${label}.${metric}`;
    if (value === undefined && propertyValueIndex(block, metric) === undefined)
      judge.disabled("coverage.lines", file, what);
    else if (typeof value !== "number" || value < 0) judge.unconfirmed(file, ` ${what}（不是可比較的百分比）`);
    else judge.compare("coverage.lines", value, file, what);
  }
}

/** Finds the thresholds object inside a config's text, or says why it cannot. */
function judgeConfig(text: string, path: readonly string[], file: string, label: string, judge: SettingsJudge): void {
  let block: string | undefined = text;
  for (const key of path) block = block === undefined ? undefined : objectProperty(block, key);
  if (block !== undefined) judgeThresholds(block, file, label, judge);
  else if (pullsFromElsewhere(text) || propertyValueIndex(text, path[0] ?? "") !== undefined)
    judge.unconfirmed(file, ` ${label}`);
  else judge.disabled("coverage.lines", file, label);
}

async function checkVitest(root: string, judge: SettingsJudge): Promise<void> {
  const names = ["vitest", "vite"].flatMap((tool) => CODE_EXTS.map((ext) => `${tool}.config.${ext}`));
  const found = await findFirst(root, names);
  if (!found) {
    judge.missingFile(judge.path("vitest.config.ts"), " Vitest 設定檔（覆蓋率門檻設在 coverage.thresholds）");
    return;
  }
  judgeConfig(found.text, ["thresholds"], judge.path(found.name), "Vitest coverage.thresholds", judge);
}

async function checkJest(root: string, judge: SettingsJudge): Promise<void> {
  const label = "Jest coverageThreshold.global";
  const path = ["coverageThreshold", "global"];
  const pkg = parseJsonc((await readIfExists(join(root, "package.json"))) ?? "");
  if (isRecord(pkg) && isRecord(pkg.jest)) {
    judgeConfig(JSON.stringify(pkg.jest), path, judge.path("package.json"), label, judge);
    return;
  }
  const found = await findFirst(
    root,
    [...CODE_EXTS, "json"].map((ext) => `jest.config.${ext}`),
  );
  if (!found) {
    judge.missingFile(judge.path("jest.config.js"), " Jest 設定檔（覆蓋率門檻設在 coverageThreshold.global）");
    return;
  }
  judgeConfig(found.text, path, judge.path(found.name), label, judge);
}

/** The four coverage thresholds against the declared `coverage.lines`, for Vitest or Jest. */
export async function checkCoverage(root: string, judge: SettingsJudge): Promise<void> {
  const tool = judge.declared("test.tool");
  if (tool === "vitest") await checkVitest(root, judge);
  else if (tool === "jest") await checkJest(root, judge);
}
