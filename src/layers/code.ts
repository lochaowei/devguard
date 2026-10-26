import { CODE_CHECKERS } from "../code/registry.ts";
import {
  CODE_CATEGORIES,
  type CodeCategory,
  type CodeCheckContext,
  type CodeChecker,
  type CodeTarget,
} from "../code/types.ts";
import type { ResolvedComponent } from "../declaration/resolve.ts";
import type { Finding } from "../report/finding.ts";
import { assignFiles, type OwnedFile } from "../repo/files.ts";
import { defaultStandard } from "../standard/registry.ts";
import type { Language, Standard } from "../standard/types.ts";
import { scopedFiles, type CheckScope, type LayerContext, type CheckLayer } from "./types.ts";
import { repoReader } from "../shared/fs.ts";

interface Group {
  owner: OwnedFile["owner"];
  dir: string;
  language: Language;
  files: string[];
  /** Repo-relative files only the formatter checks (#43). */
  formatOnly?: string[];
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

const extension = (file: string) => {
  const name = file.slice(file.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
};

/**
 * A file list leaves out what is not a source file, but a whole-directory format run also checks the other files the
 * component's formatter handles. Each such file goes to the deepest component whose formatter takes it (#43).
 */
function addFormatOnly(groups: Group[], components: readonly ResolvedComponent[], files: readonly string[]): Group[] {
  const owned = new Set(groups.flatMap((g) => g.files));
  const formatting = components
    .filter((c) => CODE_CHECKERS[c.language]?.formatsAlso !== undefined)
    .sort((a, b) => b.dir.length - a.dir.length);
  for (const file of files.filter((f) => !owned.has(f))) {
    const component = formatting.find((c) => {
      const also = CODE_CHECKERS[c.language]?.formatsAlso?.(values(c.effective)) ?? [];
      return file.startsWith(c.dir) && also.includes(extension(file));
    });
    if (!component) continue;
    let group = groups.find((g) => g.owner.kind === "component" && g.owner.component === component);
    if (!group) {
      group = { owner: { kind: "component", component }, dir: component.dir, language: component.language, files: [] };
      groups.push(group);
    }
    (group.formatOnly ??= []).push(file);
  }
  return groups;
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
  const relative = (files: readonly string[]) => files.map((f) => f.slice(group.dir.length));
  const asked: readonly CodeCategory[] = scope.only ? [scope.only] : CODE_CATEGORIES;
  // Only non-source files in scope: there is nothing to lint or type-check.
  const categories = group.files.length === 0 ? asked.filter((c) => c === "format") : asked;
  return {
    ...(group.owner.kind === "component" ? { component: group.owner.component.name } : {}),
    dir: group.dir,
    language: group.language,
    effective: effectiveValues(group, standard, global),
    ...(listFiles ? { files: relative(group.files) } : {}),
    ...(group.formatOnly ? { formatOnly: relative(group.formatOnly) } : {}),
    categories: new Set(categories),
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
  const standard = ctx.resolution?.standard ?? defaultStandard();
  if (!standard) return [];
  const global = values(ctx.resolution?.standard ? ctx.resolution.global : standard.global);
  const components = ctx.resolution?.components ?? [];
  const files = await scopedFiles(ctx);
  const grouped = groupFiles(assignFiles(components, files));
  const groups = ctx.scope.files === undefined ? grouped : addFormatOnly(grouped, components, files);
  return groups.flatMap((group) => {
    const checker: CodeChecker | undefined = CODE_CHECKERS[group.language];
    const target = toTarget(group, ctx.scope, standard, global);
    if (!checker || target.categories.size === 0) return [];
    return [{ checker, target, owned: [...group.files, ...(group.formatOnly ?? [])] }];
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
