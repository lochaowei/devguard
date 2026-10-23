import { CODE_CHECKERS } from "../code/registry.ts";
import { CODE_CATEGORIES, type CodeCheckContext, type CodeChecker, type CodeTarget } from "../code/types.ts";
import type { Finding } from "../report/finding.ts";
import { assignFiles, type OwnedFile } from "../repo/files.ts";
import { BUNDLED_STANDARDS } from "../standard/registry.ts";
import type { Language, Standard } from "../standard/types.ts";
import { scopedFiles, type CheckScope, type LayerContext, type CheckLayer } from "./types.ts";
import { repoReader } from "../shared/fs.ts";

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

/** One code target with the checker for its language and the repo-relative files in scope that it owns. */
export interface PlannedTarget {
  checker: CodeChecker;
  target: CodeTarget;
  owned: readonly string[];
}

/** The code targets in scope: one per component, or per language for files no component covers. */
export async function codeTargets(ctx: LayerContext): Promise<PlannedTarget[]> {
  const standard = ctx.resolution?.standard ?? BUNDLED_STANDARDS[BUNDLED_STANDARDS.length - 1];
  if (!standard) return [];
  const global = values(ctx.resolution?.standard ? ctx.resolution.global : standard.global);
  const owned = assignFiles(ctx.resolution?.components ?? [], await scopedFiles(ctx));
  return groupFiles(owned).flatMap((group) => {
    const checker: CodeChecker | undefined = CODE_CHECKERS[group.language];
    return checker ? [{ checker, target: toTarget(group, ctx.scope, standard, global), owned: group.files }] : [];
  });
}

/** What a CodeChecker sees of the layer context. */
export function codeCheckContext(ctx: Pick<LayerContext, "cwd" | "tools" | "stagedText">): CodeCheckContext {
  const base = { cwd: ctx.cwd, tools: ctx.tools, readText: (p: string) => repoReader(ctx.cwd)(p) };
  return ctx.stagedText ? { ...base, staged: ctx.stagedText } : base;
}

/** Runs each target's checker in order. */
export async function checkTargets(targets: readonly PlannedTarget[], ctx: CodeCheckContext): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const { checker, target } of targets) findings.push(...(await checker.check(target, ctx)));
  return findings;
}

/** Lint, format and type checks through each language's CodeChecker (SPEC §7.1). */
export const codeLayer: CheckLayer = {
  id: "code",
  async run(ctx: LayerContext) {
    return { findings: await checkTargets(await codeTargets(ctx), codeCheckContext(ctx)) };
  },
};
