import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CODE_CHECKERS } from "../code/registry.ts";
import { CODE_CATEGORIES, type CodeChecker, type CodeTarget } from "../code/types.ts";
import type { Finding } from "../report/finding.ts";
import { assignFiles, type OwnedFile } from "../repo/files.ts";
import { BUNDLED_STANDARDS } from "../standard/registry.ts";
import type { Language, Standard } from "../standard/types.ts";
import { scopedFiles, type CheckScope, type LayerContext, type CheckLayer } from "./types.ts";

interface Group {
  owner: OwnedFile["owner"];
  dir: string;
  language: Language;
  files: string[];
}

/** Files grouped by owning component; files no component covers form one group per language at the repo root. */
function groupFiles(owned: readonly OwnedFile[]): Group[] {
  const groups = new Map<string, Group>();
  for (const { file, owner } of owned) {
    const language = owner.kind === "component" ? owner.component.language : owner.language;
    const dir = owner.kind === "component" ? owner.component.dir : "";
    const key = `${owner.kind}|${dir}|${language}`;
    const group = groups.get(key) ?? { owner, dir, language, files: [] };
    group.files.push(file);
    groups.set(key, group);
  }
  return [...groups.values()];
}

const values = (items: Readonly<Record<string, { value: unknown }>>) =>
  Object.fromEntries(Object.entries(items).map(([k, item]) => [k, item.value]));

/** The language's items plus the repo-wide ones (`mirrors.*`), as resolved from the declaration. */
function effectiveValues(group: Group, standard: Standard, global: Record<string, unknown>): Record<string, unknown> {
  const own = group.owner.kind === "component" ? group.owner.component.effective : standard.languages[group.language];
  return { ...global, ...values(own) };
}

function toTarget(group: Group, scope: CheckScope, standard: Standard, global: Record<string, unknown>): CodeTarget {
  // A whole component is checked as a directory; a file list is passed only when it was asked for, or when the
  // files are scattered outside any component.
  const listFiles = scope.files !== undefined || group.owner.kind !== "component";
  return {
    ...(group.owner.kind === "component" ? { component: group.owner.component.name } : {}),
    dir: group.dir,
    language: group.language,
    effective: effectiveValues(group, standard, global),
    ...(listFiles ? { files: group.files.map((f) => f.slice(group.dir.length)) } : {}),
    categories: new Set(scope.only ? [scope.only] : CODE_CATEGORIES),
  };
}

async function readText(cwd: string, repoPath: string): Promise<string | undefined> {
  try {
    return await readFile(join(cwd, repoPath), "utf8");
  } catch {
    return undefined;
  }
}

/** Lint, format and type checks through each language's CodeChecker (SPEC §7.1). */
export const codeLayer: CheckLayer = {
  id: "code",
  async run(ctx: LayerContext) {
    const standard = ctx.resolution?.standard ?? BUNDLED_STANDARDS[BUNDLED_STANDARDS.length - 1];
    if (!standard) return { findings: [] };
    const global = values(ctx.resolution?.standard ? ctx.resolution.global : standard.global);
    const owned = assignFiles(ctx.resolution?.components ?? [], await scopedFiles(ctx));
    const findings: Finding[] = [];
    for (const group of groupFiles(owned)) {
      const checker: CodeChecker | undefined = CODE_CHECKERS[group.language];
      if (!checker) continue;
      const target = toTarget(group, ctx.scope, standard, global);
      findings.push(
        ...(await checker.check(target, { cwd: ctx.cwd, tools: ctx.tools, readText: (p) => readText(ctx.cwd, p) })),
      );
    }
    return { findings };
  },
};
