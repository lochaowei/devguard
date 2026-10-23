import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readIfExists } from "../settings/config-files.ts";
import { fileCategory, type FileCategory } from "./category.ts";
import { editConfigText } from "./edit.ts";
import type { KeyEdit, Repair } from "./repair.ts";

export { fileCategory } from "./category.ts";

/** A file `fix` (or `install`) writes: its text now ("" when new) and after. */
export interface FileWrite {
  file: string;
  category: "generated" | "managed";
  before: string;
  after: string;
}

/** Something printed for a person to apply: build files, code-form config, user-level settings. */
export interface Printed {
  file: string;
  category: "snippet" | "user";
  lines: string[];
}

export interface ChangePlan {
  writes: FileWrite[];
  printed: Printed[];
}

export const GENERATED_MARK = "由 CLI 產生";
const HEADER_TEXT = `${GENERATED_MARK}（devguard），請勿手動修改；執行 devguard fix 重新產生`;

/** Adds the "由 CLI 產生" header in the file's own comment syntax (after an XML declaration, shebang or front matter). */
export function withGeneratedHeader(file: string, content: string): string {
  if (content.includes(GENERATED_MARK) || file.endsWith("maven.config")) return content;
  const xmlish = /\.(xml|md)$/.test(file);
  const header = xmlish ? `<!-- ${HEADER_TEXT} -->` : `# ${HEADER_TEXT}`;
  const lead = /^(<\?xml[^>]*\?>\r?\n|#![^\n]*\n|---\n[\s\S]*?\n---\n)/.exec(content)?.[0] ?? "";
  return `${lead}${header}\n${content.slice(lead.length)}`;
}

const keyEdit = (r: Repair): r is Extract<Repair, KeyEdit> => r.op !== "generate" && r.op !== "snippet";

/** A key edit as a line to apply by hand. */
function describeEdit(r: Repair): string {
  switch (r.op) {
    case "snippet":
      return r.text;
    case "generate":
      return `（整份內容）\n${r.content}`;
    case "line":
      return r.value;
    case "delete":
      return `刪除 ${r.path.join(".")}`;
    case "set":
      return `${r.path.join(".")}: ${JSON.stringify(r.value)}`;
    case "add":
      return `${r.path.join(".")}: 加上 ${JSON.stringify(r.value)}`;
    case "remove":
      return `${r.path.join(".")}: 移除 ${JSON.stringify(r.value)}`;
  }
}

function byFile(repairs: readonly Repair[]): Map<string, Repair[]> {
  const seen = new Set<string>();
  const files = new Map<string, Repair[]>();
  for (const r of repairs) {
    const id = JSON.stringify(r);
    if (seen.has(id)) continue;
    seen.add(id);
    files.set(r.file, [...(files.get(r.file) ?? []), r]);
  }
  return files;
}

async function planWrite(
  cwd: string,
  file: string,
  category: "generated" | "managed",
  repairs: Repair[],
): Promise<{ write?: FileWrite; rest: Repair[] }> {
  const before = (await readIfExists(join(cwd, file))) ?? "";
  if (category === "generated") {
    const generate = repairs.filter((r) => r.op === "generate").pop();
    const rest = repairs.filter((r) => r.op !== "generate");
    if (!generate) return { rest };
    const after = withGeneratedHeader(file, generate.content);
    return { write: after === before ? undefined : { file, category, before, after }, rest };
  }
  const edits = repairs.filter(keyEdit);
  const after = editConfigText(file, before, edits);
  const rest = repairs.filter((r) => !keyEdit(r));
  return { write: after === before ? undefined : { file, category, before, after }, rest };
}

/**
 * Turns repairs into what to write and what to print, by file category (SPEC §9.2): CLI-owned files are regenerated,
 * structured shared files get their managed keys edited, everything else (build files, code-form config, user-level
 * settings) is only printed. Files already as wanted drop out. Nothing is written here.
 */
export async function planChanges(cwd: string, repairs: readonly Repair[]): Promise<ChangePlan> {
  const plan: ChangePlan = { writes: [], printed: [] };
  for (const [file, list] of byFile(repairs)) {
    const category: FileCategory = fileCategory(file);
    let rest = list;
    if (category === "generated" || category === "managed") {
      const planned = await planWrite(cwd, file, category, list);
      if (planned.write) plan.writes.push(planned.write);
      rest = planned.rest;
    }
    if (rest.length === 0) continue;
    const printedCategory = category === "user" ? "user" : "snippet";
    plan.printed.push({ file, category: printedCategory, lines: rest.map(describeEdit) });
  }
  return plan;
}

/** Line diff (longest common subsequence) with `-` / `+` markers and up to two lines of context. */
export function diffLines(before: string, after: string): string[] {
  const a = before === "" ? [] : before.replace(/\r?\n$/, "").split(/\r?\n/);
  const b = after.replace(/\r?\n$/, "").split(/\r?\n/);
  const ops = lineOps(a, b);
  const near = (k: number) => ops.slice(Math.max(0, k - 2), k + 3).some((o) => !o.startsWith(" "));
  return ops.filter((_, k) => near(k));
}

/** Length of the longest common subsequence of `a[i..]` and `b[j..]`, as a lookup. */
function lcsLengths(a: readonly string[], b: readonly string[]): (i: number, j: number) => number {
  const width = b.length + 1;
  const table = new Int32Array((a.length + 1) * width);
  const lcs = (i: number, j: number): number => table[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i * width + j] = a[i] === b[j] ? lcs(i + 1, j + 1) + 1 : Math.max(lcs(i + 1, j), lcs(i, j + 1));
  return lcs;
}

function trimCommon(
  a: readonly string[],
  b: readonly string[],
): { prefix: string[]; midA: readonly string[]; midB: readonly string[]; suffix: string[] } {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return {
    prefix: a.slice(0, start).map((l) => ` ${l}`),
    midA: a.slice(start, endA),
    midB: b.slice(start, endB),
    suffix: a.slice(endA).map((l) => ` ${l}`),
  };
}

/** Every line of `a` and `b` marked " " (both), "-" (only a) or "+" (only b), in order. */
function lineOps(a: readonly string[], b: readonly string[]): string[] {
  const { prefix, midA, midB, suffix } = trimCommon(a, b);
  const lcs = lcsLengths(midA, midB);
  const ops: string[] = [...prefix];
  let i = 0;
  let j = 0;
  while (i < midA.length && j < midB.length) {
    const left = midA[i] ?? "";
    const right = midB[j] ?? "";
    if (left === right) {
      ops.push(` ${left}`);
      i++;
      j++;
    } else if (lcs(i, j + 1) >= lcs(i + 1, j)) {
      ops.push(`+${right}`);
      j++;
    } else {
      ops.push(`-${left}`);
      i++;
    }
  }
  return [...ops, ...midA.slice(i).map((l) => `-${l}`), ...midB.slice(j).map((l) => `+${l}`), ...suffix];
}

const WRITE_LABEL = { generated: "重新產生（由 CLI 產生）", managed: "修改 CLI 管理的設定" } as const;
const PRINT_LABEL = {
  snippet: "建置檔或程式碼形式的設定，不會自動修改；請自行套用",
  user: "使用者層級的設定，不會修改；請自行套用",
} as const;

/** The preview: a diff per written file, then the printed snippets. */
export function renderPlan(plan: ChangePlan): string {
  const out: string[] = [];
  for (const w of plan.writes) {
    out.push(
      `${w.file}：${w.before === "" ? "新增，" : ""}${WRITE_LABEL[w.category]}`,
      ...diffLines(w.before, w.after),
      "",
    );
  }
  for (const p of plan.printed) {
    out.push(`${p.file}：${PRINT_LABEL[p.category]}`, ...p.lines.map((l) => `    ${l}`), "");
  }
  if (out.length === 0) return "沒有需要修正的設定。\n";
  return out.join("\n");
}

/** Writes the planned files. Printed items are never written. */
export async function applyPlan(cwd: string, plan: ChangePlan): Promise<void> {
  for (const w of plan.writes) {
    const path = join(cwd, w.file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, w.after);
  }
}
