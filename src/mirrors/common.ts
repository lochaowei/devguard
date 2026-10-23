import type { ResolvedComponent } from "../declaration/resolve.ts";
import { fixText } from "../fix/category.ts";
import type { Repair } from "../fix/repair.ts";
import type { Finding } from "../report/finding.ts";

/** The resolved `mirrors.*` values the project-level settings must point at (SPEC §10.1). */
export interface MirrorSettings {
  pypi: string;
  npm: string;
  maven: string;
  auth: "none" | "env";
}

/** Reads a repo-relative file; undefined when it does not exist. */
export type ReadFile = (file: string) => Promise<string | undefined>;

export type MirrorComponent = Pick<ResolvedComponent, "dir" | "language" | "name" | "effective">;

/** Checks one component's project-level mirror settings. */
export type MirrorChecker = (component: MirrorComponent, mirrors: MirrorSettings, read: ReadFile) => Promise<Finding[]>;

export interface MirrorProblem {
  rule: "missing" | "external" | "auth-missing" | "plaintext-credentials";
  message: string;
  /** What to do by hand; `fixText` prefixes it with `devguard fix` when the repairs write themselves. */
  detail: string;
  repairs?: Repair[];
  line?: number;
}

/** A mirror finding: always an error (SPEC §10.2). Messages never contain a credential's value. */
export function mirrorFinding(component: MirrorComponent, file: string, p: MirrorProblem): Finding {
  const repairs = p.repairs ?? [];
  return {
    level: "error",
    layer: "config",
    rule: `mirrors/${p.rule}`,
    component: component.name,
    file,
    ...(p.line === undefined ? {} : { line: p.line }),
    message: p.message,
    fix: fixText(p.detail, repairs),
    ...(repairs.length > 0 ? { repairs } : {}),
  };
}

/** Same mirror: compares URLs without a trailing slash. */
export function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

function origin(url: string): string {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

/** On the mirror's host: another repository of the same Nexus is internal, anything else is an external source. */
export function internal(url: string, mirror: string): boolean {
  return origin(url) === origin(mirror);
}

/** `user:password@` in a URL: a credential written into a project file. */
export const USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i;

/** Text (URLs) as it may be printed: never with the credentials a URL embeds. */
export function redact(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1***@");
}
