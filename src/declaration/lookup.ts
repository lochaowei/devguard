import { EXTENSION_LANGUAGE, type Language } from "../standard/types.ts";
import { normalizePath } from "./path.ts";
import type { ResolvedComponent } from "./resolve.ts";

export type FileOwner =
  | { kind: "component"; component: ResolvedComponent }
  /** No component covers it: the language is inferred from the extension and the default standard applies. */
  | { kind: "inferred"; language: Language }
  /** Not one of the four languages: outside the checks. */
  | { kind: "out-of-scope" };

function languageOf(file: string): Language | undefined {
  const name = file.slice(file.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? undefined : EXTENSION_LANGUAGE[name.slice(dot).toLowerCase()];
}

/** Which standard governs `file`: the component with the longest matching path and the same language (SPEC §4.1). */
export function findOwner(components: readonly ResolvedComponent[], file: string): FileOwner {
  const path = normalizePath(file);
  const language = languageOf(path);
  if (!language) return { kind: "out-of-scope" };
  const owner = components
    .filter((c) => c.language === language && path.startsWith(c.dir))
    .reduce<ResolvedComponent | undefined>(
      (best, c) => (!best || c.dir.length > best.dir.length ? c : best),
      undefined,
    );
  return owner ? { kind: "component", component: owner } : { kind: "inferred", language };
}
