import { readFileSync } from "node:fs";
import { join } from "node:path";
import { valueInForce, type EffectiveItem, type ResolvedComponent } from "../declaration/resolve.ts";
import { DECLARATION_FILE } from "../declaration/types.ts";
import type { Finding } from "../report/finding.ts";
import type { ItemDef } from "../standard/types.ts";
import type { ToolRunner } from "../tools/runner.ts";
import { pinnedVersions } from "../versions/pinned.ts";
import { preCommitRevHints } from "../versions/pre-commit-revs.ts";
import { inRange } from "../versions/range.ts";
import type { CheckLayer } from "./types.ts";

/** The version range a component is held to (`valueInForce`), as text. */
export function rangeInForce(item: ItemDef, effective: EffectiveItem | undefined): string {
  const value = valueInForce(item.value, effective);
  return typeof value === "string" ? value : typeof item.value === "string" ? item.value : "";
}

function readRepoFile(cwd: string): (path: string) => string | undefined {
  return (path) => {
    try {
      return readFileSync(join(cwd, path), "utf8");
    } catch {
      return undefined;
    }
  };
}

interface RangeItem {
  key: string;
  item: ItemDef;
}

function rangeItems(defs: Readonly<Record<string, ItemDef>>): RangeItem[] {
  return Object.entries(defs)
    .filter(([, item]) => item.kind === "versionRange")
    .map(([key, item]) => ({ key, item }));
}

/** Locked versions of the component's tools against the ranges in force (SPEC §5.2, §8). */
function checkPinned(c: ResolvedComponent, items: RangeItem[], cwd: string): Finding[] {
  const pinned = pinnedVersions(c.language, c.dir, readRepoFile(cwd));
  if (!pinned) return [];
  const findings: Finding[] = [];
  for (const { key, item } of items) {
    if (item.onPath) continue;
    const range = rangeInForce(item, c.effective[key]);
    for (const name of item.pinnedAs ?? []) {
      const version = pinned.versions.get(name);
      if (version === undefined || inRange(version, range)) continue;
      findings.push({
        level: "error",
        layer: "consistency",
        rule: "tool-version/out-of-range",
        message: `${name} ${version} 不在允許的版本範圍 ${range} 內`,
        component: c.name,
        file: pinned.file,
        fix: `把 ${name} 改成 ${range} 內的版本並更新 lockfile；或在 ${DECLARATION_FILE} 以 {value, reason, until} 放寬 ${key}`,
      });
    }
  }
  return findings;
}

const VERSION_OUTPUT = /version\s+v?(\d+(?:\.\d+)+)/;

/** Tools taken from PATH rather than the project (golangci-lint): ask the binary once, check every component. */
async function checkOnPath(
  components: ResolvedComponent[],
  defs: (c: ResolvedComponent) => RangeItem[],
  tools: ToolRunner,
) {
  const findings: Finding[] = [];
  const asked = new Map<string, string | undefined>();
  for (const c of components) {
    for (const { key, item } of defs(c)) {
      if (!item.onPath) continue;
      const tool = key.replace(/^tools\./, "");
      if (!asked.has(tool)) {
        const out = await tools.run({ language: c.language, tool, dir: c.dir, args: ["--version"] });
        asked.set(tool, VERSION_OUTPUT.exec(`${out.stdout}\n${out.stderr}`)?.[1]);
      }
      const version = asked.get(tool);
      const range = rangeInForce(item, c.effective[key]);
      if (version !== undefined && inRange(version, range)) continue;
      findings.push({
        level: "error",
        layer: "environment",
        rule: `tool-version/${tool}`,
        message:
          version === undefined
            ? `無法從 ${tool} --version 的輸出讀出版本，無法確認是否在 ${range} 內`
            : `PATH 上的 ${tool} 是 ${version}，不在允許的版本範圍 ${range} 內`,
        component: c.name,
        fix: `scoop update ${tool}`,
      });
    }
  }
  return findings;
}

/** 一致性檢查：專案鎖定的工具版本、PATH 上的 golangci-lint，是否落在標準的版本範圍內。 */
export const toolVersionsLayer: CheckLayer = {
  id: "tool-versions",
  async run({ cwd, resolution, tools }) {
    const standard = resolution?.standard;
    if (!standard) return { findings: [] };
    const defs = (c: ResolvedComponent) => rangeItems(standard.languages[c.language]);
    const pinned = resolution.components.flatMap((c) => checkPinned(c, defs(c), cwd));
    const onPath = await checkOnPath(resolution.components, defs, tools);
    const revs = preCommitRevHints(resolution.components, readRepoFile(cwd));
    return { findings: [...pinned, ...onPath, ...revs] };
  },
};
