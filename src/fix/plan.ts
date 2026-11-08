import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { normalizePath } from "../declaration/path.ts";
import { nodeExec, type Exec } from "../process/exec.ts";
import { redactSecrets } from "../report/redact.ts";
import { fileCategory, type FileCategory } from "./category.ts";
import { editConfigText, editFormat, parseConfigText } from "./edit.ts";
import type { KeyEdit, Repair } from "./repair.ts";
import { readIfExists } from "../shared/fs.ts";

export { fileCategory } from "./category.ts";

/** A file `fix` (or `install`) writes: its text now ("" when new) and after. */
export interface FileWrite {
  file: string;
  category: "generated" | "managed";
  before: string;
  after: string;
  /** File mode set after writing, e.g. 0o755 for a git hook. */
  mode?: number;
}

/** Something printed for a person to apply: build files, code-form config, user-level settings. */
export interface Printed {
  file: string;
  /**
   * `conflict`: a setting that stops the git hooks from running (`core.hooksPath`, SPEC §7.4). `typecheck`: the
   * project already configures a type checker other than the declared one (#68). `unparseable`: editing a shared TOML
   * file would leave it unparseable, so it is not written (#105). `foreign`: a CLI-owned file devguard did not generate,
   * so it is not overwritten (#100). `blocked`: a file sits where the path needs a directory, so it cannot be written
   * (#129).
   */
  category: "snippet" | "user" | "conflict" | "typecheck" | "unparseable" | "foreign" | "blocked";
  lines: string[];
}

export interface ChangePlan {
  writes: FileWrite[];
  printed: Printed[];
}

export const GENERATED_MARK = "由 CLI 產生";
const HEADER_TEXT = `${GENERATED_MARK}（devguard），請勿手動修改；執行 devguard fix 重新產生`;

/**
 * A CLI-owned file (SPEC §9.2) that devguard did not generate: it has content but no "由 CLI 產生" header. `fix` does
 * not overwrite it (#100), as `install` leaves a git hook it did not write alone.
 */
export function isForeign(text: string | undefined): boolean {
  return text !== undefined && text.trim() !== "" && !text.includes(GENERATED_MARK);
}

/**
 * Adds the "由 CLI 產生" header in the file's own comment syntax (after an XML declaration, shebang or front matter).
 * Markdown gets the blank lines Prettier puts around front matter and an HTML block, so formatting changes nothing.
 */
export function withGeneratedHeader(file: string, content: string): string {
  if (content.includes(GENERATED_MARK) || file.endsWith("maven.config")) return content;
  const xmlish = /\.(xml|md)$/.test(file);
  const header = xmlish ? `<!-- ${HEADER_TEXT} -->` : `# ${HEADER_TEXT}`;
  const lead = /^(<\?xml[^>]*\?>\r?\n|#![^\n]*\n|---\n[\s\S]*?\n---\n)/.exec(content)?.[0] ?? "";
  const rest = content.slice(lead.length);
  if (!file.endsWith(".md")) return `${lead}${header}\n${rest}`;
  return `${lead}${lead === "" ? "" : "\n"}${header}\n\n${rest.replace(/^\n+/, "")}`;
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

interface PlannedFile {
  write?: FileWrite;
  rest: Repair[];
  printAs?: Printed["category"];
}

/** A CLI-owned file: regenerated whole, unless it exists and devguard did not generate it (#100). */
function planGenerated(file: string, before: string, repairs: Repair[]): PlannedFile {
  const generate = repairs.filter((r) => r.op === "generate").pop();
  const rest = repairs.filter((r) => r.op !== "generate");
  // Not devguard's file: nothing is written. The checks attach the part to add as snippets; failing those, the whole
  // generated content is printed for reference.
  if (isForeign(before)) return { rest: rest.length > 0 || !generate ? rest : [generate], printAs: "foreign" };
  if (!generate) return { rest };
  const after = withGeneratedHeader(file, generate.content);
  return { write: after === before ? undefined : { file, category: "generated", before, after }, rest };
}

async function planWrite(
  cwd: string,
  file: string,
  category: "generated" | "managed",
  repairs: Repair[],
): Promise<PlannedFile> {
  const before = (await readIfExists(join(cwd, file))) ?? "";
  if (category === "generated") return planGenerated(file, before, repairs);
  const edits = repairs.filter(keyEdit);
  // A broken TOML file stops every tool that reads it, so a TOML edit that fails or whose result does not parse is
  // not written; the edits are printed instead. JSONC and YAML results are not checked.
  const unparseable = { rest: repairs, printAs: "unparseable" } as const;
  let after: string;
  try {
    after = editConfigText(file, before, edits);
  } catch (error) {
    if (editFormat(file, before) === "toml") return unparseable;
    throw error;
  }
  if (editFormat(file, after) === "toml" && parseConfigText(file, after) === undefined) return unparseable;
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
    let printAs: Printed["category"] = category === "user" ? "user" : "snippet";
    if (category === "generated" || category === "managed") {
      const planned = await planWrite(cwd, file, category, list);
      if (planned.write) plan.writes.push(planned.write);
      rest = planned.rest;
      printAs = planned.printAs ?? printAs;
    }
    if (rest.length === 0) continue;
    plan.printed.push({ file, category: printAs, lines: rest.map(describeEdit) });
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
  conflict: "core.hooksPath 衝突，hook 不會執行；請自行處理",
  typecheck: "警告：已有宣告以外的型別檢查器設定，不會修改宣告；請自行決定",
  unparseable: "錯誤：修改後不是合法的 TOML，不會修改；請自行套用",
  foreign: "這份檔案不是 devguard 產生的，不會覆寫；請自行加入以下內容",
  blocked: "錯誤：路徑上有檔案而不是目錄，無法寫入；請自行處理",
} as const;

/** A diff line (`-` / `+` / ` ` marker) with any credential it shows masked (SPEC §10.3). */
const redactedDiffLine = (line: string): string => line.slice(0, 1) + redactSecrets(line.slice(1));

/** The preview: a diff per written file, then the printed snippets. Credentials are never printed (SPEC §10.3). */
export function renderPlan(plan: ChangePlan): string {
  const out: string[] = [];
  for (const w of plan.writes) {
    out.push(
      `${w.file}：${w.before === "" ? "新增，" : ""}${WRITE_LABEL[w.category]}`,
      ...diffLines(w.before, w.after).map(redactedDiffLine),
      "",
    );
  }
  for (const p of plan.printed) {
    const lines = p.lines.flatMap((l) =>
      redactSecrets(l)
        .replace(/\r?\n$/, "")
        .split(/\r?\n/),
    );
    out.push(`${p.file}：${PRINT_LABEL[p.category]}`, ...lines.map((l) => `    ${l}`), "");
  }
  if (out.length === 0) return "沒有需要修正的設定。\n";
  return out.join("\n");
}

/** The nearest existing ancestor directory entry of `path`, when it is not a directory. */
async function fileInTheWay(path: string): Promise<string | undefined> {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    try {
      return (await stat(dir)).isDirectory() ? undefined : dir;
    } catch {
      // Missing (or under a file, ENOTDIR): look one level up.
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/** Whether `rel` (relative to `cwd`) is a symlink in the git index (mode 120000). */
async function gitSymlink(cwd: string, rel: string, exec: Exec): Promise<boolean> {
  try {
    const result = await exec({ file: "git", args: ["ls-files", "-s", "--", rel], cwd });
    return result.code === 0 && result.stdout.startsWith("120000 ");
  } catch {
    return false;
  }
}

/**
 * Takes out of the plan each write whose path runs through a file where a directory is needed, such as a git symlink
 * Windows checked out as a plain file (#129), and prints it as `blocked` instead. The other writes stay.
 */
export async function withoutBlockedWrites(cwd: string, plan: ChangePlan, exec: Exec = nodeExec): Promise<ChangePlan> {
  const writes: FileWrite[] = [];
  const blocked: Printed[] = [];
  for (const w of plan.writes) {
    const file = await fileInTheWay(resolve(cwd, w.file));
    if (file === undefined) {
      writes.push(w);
      continue;
    }
    const rel = relative(cwd, file);
    const inside = !rel.startsWith("..") && !isAbsolute(rel);
    const shown = normalizePath(inside ? rel : file);
    const lines = [`${shown} 是檔案，不是目錄`];
    if (inside && (await gitSymlink(cwd, rel, exec))) {
      lines.push(
        `${shown} 在 git 中是 symlink（mode 120000），checkout 時沒有展開成 symlink（core.symlinks 為 false，Windows 上常見）；`,
        `請先讓系統允許建立 symlink（Windows：開啟開發人員模式），執行 git config core.symlinks true，再重新 checkout ${shown}`,
      );
    }
    blocked.push({ file: w.file, category: "blocked", lines });
  }
  return { writes, printed: [...plan.printed, ...blocked] };
}

/** Whether the plan has writes that cannot be made (#129): the command then exits 1. */
export const hasBlockedWrites = (plan: ChangePlan): boolean => plan.printed.some((p) => p.category === "blocked");

/** Writes the planned files: repo-relative, or absolute (a hooks directory outside the work tree). Printed items are never written. */
export async function applyPlan(cwd: string, plan: ChangePlan): Promise<void> {
  for (const w of plan.writes) {
    const path = resolve(cwd, w.file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, w.after);
    if (w.mode !== undefined) await chmod(path, w.mode);
  }
}
