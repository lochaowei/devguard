import { join } from "node:path";
import { parseJsonc, searchDirs } from "../config-files.ts";
import { setAt, type SettingsJudge } from "../judge.ts";
import { readIfExists } from "../../shared/fs.ts";
import { isRecord } from "../../shared/guards.ts";

const KEY = "node.minVersion";

/** A lower-bound comparator of an npm semver range: `>=20`, `>20.1`, `^22.11`, `~20.0`, `=20`, `v20`, `20.x`, `20`. */
const LOWER = /^(?:>=|>|\^|~|=)?v?(\d+)(?:\.(?:\d+|[xX*]))*$/;
/** Comparators that only bound from above (`<22`, `<=22.1`): no lower bound, but still readable. */
const UPPER = /^<=?v?\d+(?:\.(?:\d+|[xX*]))*$/;

/**
 * The lowest major Node version an `engines.node` range allows, e.g. `>=20 <24` → "20", `^22.11` → "22". Undefined
 * when the range has no readable lower bound: a `||` union, `*`, a tag, a hyphen range or anything else. With
 * several comparators the highest lower bound wins, as the intersection does.
 */
export function enginesNodeFloor(range: string): string | undefined {
  if (range.includes("||")) return undefined;
  const parts = range.trim().split(/\s+/);
  const floors: number[] = [];
  for (const part of parts) {
    const major = LOWER.exec(part)?.[1];
    if (major !== undefined) floors.push(Number(major));
    else if (!UPPER.test(part)) return undefined;
  }
  return floors.length === 0 ? undefined : String(Math.max(...floors));
}

/**
 * `node.minVersion` against `engines.node` of the nearest package.json (the component's own, else the one of the
 * workspace root above it; none is created in a sub-component). A higher floor is the project's call (no hint); a
 * missing `engines.node` is an error that `fix` adds; an unreadable range is a hint. No package.json: nothing to judge.
 */
export async function checkNodeVersion(root: string, judge: SettingsJudge): Promise<void> {
  for (const { fsDir, relDir } of searchDirs(root, judge.dir)) {
    const text = await readIfExists(join(fsDir, "package.json"));
    if (text === undefined) continue;
    const file = `${relDir}package.json`;
    const pkg = parseJsonc(text);
    if (!isRecord(pkg)) return;
    judgeEngines(pkg, file, judge);
    return;
  }
}

function judgeEngines(pkg: Record<string, unknown>, file: string, judge: SettingsJudge): void {
  const want = judge.declared(KEY);
  if (typeof want !== "string") return;
  const node = isRecord(pkg.engines) ? pkg.engines.node : undefined;
  const repair = setAt(file, ["engines", "node"], (w) => `>=${String(w)}`);
  if (node === undefined) {
    judge.missingSetting(
      "settings/engines-node-missing",
      file,
      `${file} 沒有 engines.node（標準要求至少 ${want}）`,
      `在 ${file} 設定 engines.node 為 ">=${want}"`,
      repair(want),
    );
    return;
  }
  const floor = typeof node === "string" ? enginesNodeFloor(node) : undefined;
  if (floor === undefined) {
    judge.unreadable(
      file,
      `${file}：無法判讀 engines.node 的範圍 ${JSON.stringify(node)}，請自行確認下限不低於 ${want}`,
    );
    return;
  }
  judge.compareFloor(KEY, floor, file, "engines.node 下限", repair);
}
