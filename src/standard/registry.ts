import { team_1_0_0 } from "./team-1.0.0.ts";
import type { Standard } from "./types.ts";

/** All standard versions bundled with this CLI release (SPEC §5.5). */
export const BUNDLED_STANDARDS: readonly Standard[] = [team_1_0_0];

export type StandardLookup =
  | { ok: true; standard: Standard }
  | { ok: false; reason: "malformed" | "unknown-name" | "newer-than-cli" | "no-longer-bundled" };

const ID_PATTERN = /^([a-z][a-z0-9-]*)@(\d+)\.(\d+)\.(\d+)$/;

export function parseStandardId(id: string): { name: string; version: [number, number, number] } | undefined {
  const m = ID_PATTERN.exec(id);
  if (!m) return undefined;
  return { name: m[1] ?? "", version: [Number(m[2]), Number(m[3]), Number(m[4])] };
}

function compareVersion(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function findStandard(id: string, bundled: readonly Standard[] = BUNDLED_STANDARDS): StandardLookup {
  const wanted = parseStandardId(id);
  if (!wanted) return { ok: false, reason: "malformed" };
  const exact = bundled.find((s) => s.id === id);
  if (exact) return { ok: true, standard: exact };
  const sameName = bundled.map((s) => parseStandardId(s.id)).filter((p) => p?.name === wanted.name);
  if (sameName.length === 0) return { ok: false, reason: "unknown-name" };
  const newest = sameName.reduce((a, b) => (a && b && compareVersion(a.version, b.version) >= 0 ? a : b));
  if (newest && compareVersion(wanted.version, newest.version) > 0) return { ok: false, reason: "newer-than-cli" };
  return { ok: false, reason: "no-longer-bundled" };
}

export { compareVersion };
