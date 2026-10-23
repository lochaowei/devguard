import { editFormat } from "./edit.ts";
import type { Repair } from "./repair.ts";

/**
 * The file categories of SPEC §9.2, plus user-level settings (§9.1):
 * - generated: owned by the CLI, regenerated whole with a "由 CLI 產生" header
 * - managed: a structured shared file; only the CLI-managed keys change, comments and order stay
 * - snippet: build files and code-form config; never written, the change is printed
 * - user: outside the repo (~/.m2/settings.xml, the user's .npmrc...); never written, the change is printed
 */
export type FileCategory = "generated" | "managed" | "snippet" | "user";

const GENERATED: readonly RegExp[] = [
  /(^|\/)checkstyle\.xml$/,
  /(^|\/)(pmd-ruleset\.xml|pmd\.xml|config\/pmd\/ruleset\.xml|config\/pmd\/pmd\.xml)$/,
  /(^|\/)dependency-check-suppressions\.xml$/,
  /^\.claude\/rules\//,
  /^\.claude\/skills\/standards-doctor\//,
  /^\.githooks\//,
  /(^|\/)\.mvn\/(settings\.xml|maven\.config)$/,
];

const outsideRepo = (file: string): boolean => /^([A-Za-z]:|[\\/]|~)/.test(file) || file.split(/[\\/]/).includes("..");

/** Which category a repo-relative path falls in. */
export function fileCategory(file: string): FileCategory {
  if (outsideRepo(file)) return "user";
  if (GENERATED.some((re) => re.test(file))) return "generated";
  return editFormat(file) ? "managed" : "snippet";
}

/** `devguard fix` writes this repair itself (rather than printing it). */
export function writesItself(repair: Repair): boolean {
  const category = fileCategory(repair.file);
  if (repair.op === "snippet") return false;
  if (repair.op === "generate") return category === "generated";
  return category === "managed";
}

/**
 * The `fix` text of a finding with repairs: findings `devguard fix` resolves by itself say so up front; the others
 * keep the manual instruction and point out that `fix` only prints the snippet.
 */
export function fixText(detail: string, repairs: readonly Repair[]): string {
  if (repairs.length > 0 && repairs.every(writesItself)) return `devguard fix（${detail}）`;
  return repairs.length > 0 ? `${detail}（devguard fix 會印出要套用的片段，不會自動修改）` : detail;
}

/** A finding `devguard fix` resolves by itself. */
export const FIXABLE_PREFIX = "devguard fix";
