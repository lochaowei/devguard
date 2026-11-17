import { pathToolHint } from "../distribution.ts";
import { valueInForce, type EffectiveItem, type ResolvedComponent } from "../declaration/resolve.ts";
import { DECLARATION_FILE } from "../declaration/types.ts";
import type { Finding } from "../report/finding.ts";
import type { ItemDef } from "../standard/types.ts";
import { reportingMissingTool } from "../tools/missing.ts";
import type { ToolRunner } from "../tools/runner.ts";
import { installedNpmPackage } from "../versions/installed.ts";
import { pinnedBuilds, type ReadRepoFile } from "../versions/pinned.ts";
import { preCommitRevHints } from "../versions/pre-commit-revs.ts";
import { inRange } from "../versions/range.ts";
import type { CheckLayer } from "./types.ts";
import { repoReaderSync } from "../shared/fs.ts";
import { listDirsIn } from "../settings/java/gradle-projects.ts";
import { rangeApplies } from "../settings/type-checkers.ts";

/** The version range a component is held to (`valueInForce`), as text. */
export function rangeInForce(item: ItemDef, effective: EffectiveItem | undefined): string {
  const value = valueInForce(item.value, effective);
  return typeof value === "string" ? value : typeof item.value === "string" ? item.value : "";
}

interface RangeItem {
  key: string;
  item: ItemDef;
}

/** The component's version-range items, less the type checkers it does not declare (`rangeApplies`, #113). */
function rangeItems(c: ResolvedComponent, defs: Readonly<Record<string, ItemDef>>): RangeItem[] {
  return Object.entries(defs)
    .filter(([key, item]) => item.kind === "versionRange" && rangeApplies(key, c, defs))
    .map(([key, item]) => ({ key, item }));
}

/** Locked versions of the component's tools against the ranges in force (SPEC §5.2, §8). */
async function checkPinned(c: ResolvedComponent, items: RangeItem[], cwd: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  const read = repoReaderSync(cwd);
  const builds = await pinnedBuilds(c.language, c.dir, read, listDirsIn(cwd));
  for (const { key, item } of items) {
    if (item.onPath) continue;
    const range = rangeInForce(item, c.effective[key]);
    for (const name of item.pinnedAs ?? []) {
      for (const pinned of builds) {
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
      if (builds.every((b) => !b.versions.has(name))) {
        findings.push(...checkInstalled(c, { name, key, range }, read));
      }
    }
  }
  return findings;
}

/** No lockfile says which version is installed: a TypeScript component's tool is read from node_modules (#212). */
function checkInstalled(
  c: ResolvedComponent,
  tool: { name: string; key: string; range: string },
  read: ReadRepoFile,
): Finding[] {
  const { name, key, range } = tool;
  const installed = c.language === "typescript" ? installedNpmPackage(c.dir, name, read) : undefined;
  if (!installed || inRange(installed.version, range)) return [];
  return [
    {
      level: "error",
      layer: "consistency",
      rule: "tool-version/out-of-range",
      message: `安裝的 ${name} ${installed.version} 不在允許的版本範圍 ${range} 內`,
      component: c.name,
      file: installed.file,
      fix: `安裝 ${range} 內的 ${name}；或在 ${DECLARATION_FILE} 以 {value, reason, until} 放寬 ${key}`,
    },
  ];
}

const VERSION_OUTPUT = /version\s+v?(\d+(?:\.\d+)+)/;

/** What a tool on PATH says its version is (undefined when unreadable), or the finding that it is not there. */
async function versionOnPath(tools: ToolRunner, c: ResolvedComponent, tool: string) {
  let version: string | undefined;
  const missing = await reportingMissingTool(async () => {
    const out = await tools.run({ language: c.language, tool, dir: c.dir, args: ["--version"] });
    version = VERSION_OUTPUT.exec(`${out.stdout}\n${out.stderr}`)?.[1];
    return [];
  });
  return { version, missing };
}

/** Tools taken from PATH rather than the project (golangci-lint): ask the binary once, check every component. */
async function checkOnPath(
  components: ResolvedComponent[],
  defs: (c: ResolvedComponent) => RangeItem[],
  tools: ToolRunner,
) {
  const findings: Finding[] = [];
  const asked = new Map<string, Awaited<ReturnType<typeof versionOnPath>>>();
  for (const c of components) {
    for (const { key, item } of defs(c)) {
      if (!item.onPath) continue;
      const tool = key.replace(/^tools\./, "");
      let answer = asked.get(tool);
      if (!answer) {
        answer = await versionOnPath(tools, c, tool);
        asked.set(tool, answer);
        findings.push(...answer.missing);
      }
      // Not on PATH: that is the error, reported once; there is no version to hold against the range.
      if (answer.missing.length > 0) continue;
      const { version } = answer;
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
        fix: pathToolHint(tool, range),
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
    const defs = (c: ResolvedComponent) => rangeItems(c, standard.languages[c.language]);
    const pinned = (await Promise.all(resolution.components.map((c) => checkPinned(c, defs(c), cwd)))).flat();
    const onPath = await checkOnPath(resolution.components, defs, tools);
    const revs = preCommitRevHints(resolution.components, repoReaderSync(cwd));
    return { findings: [...pinned, ...onPath, ...revs] };
  },
};
