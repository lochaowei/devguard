import { join } from "node:path";
import { findNodeAtLocation, getNodeValue, parseTree, type ParseError } from "jsonc-parser";
import { fixText } from "../fix/category.ts";
import type { KeyPath, Layout, Repair } from "../fix/repair.ts";
import type { Finding } from "../report/finding.ts";
import { isRecord, readIfExists } from "../settings/config-files.ts";
import { managedWorkspace, VSCODE_FILES, workspaceLayout, type Managed, type VscodeFile } from "../vscode/workspace.ts";
import type { CheckLayer } from "./types.ts";

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function getIn(root: unknown, path: KeyPath): unknown {
  let cur = root;
  for (const k of path)
    cur = isRecord(cur) || Array.isArray(cur) ? (cur as Record<string | number, unknown>)[k] : undefined;
  return cur;
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const tasksOf = (doc: unknown): unknown[] => list(getIn(doc, ["tasks"]));

const taskIndex = (doc: unknown, label: string): number =>
  tasksOf(doc).findIndex((t) => isRecord(t) && t.label === label);

function satisfied(m: Managed, doc: unknown): boolean {
  switch (m.kind) {
    case "value":
      return [m.path, ...(m.alternatives ?? [])].some((p) => same(getIn(doc, p), m.value));
    case "member":
      return list(getIn(doc, m.path)).includes(m.value);
    case "absent":
      return !list(getIn(doc, m.path)).includes(m.value);
    case "task":
      return tasksOf(doc).some((t) => same(t, m.value));
  }
}

function repair(m: Managed, doc: unknown, layout: Layout): Repair {
  switch (m.kind) {
    case "value":
      return { op: "set", file: m.file, path: m.path, value: m.value, layout };
    case "member":
      return { op: "add", file: m.file, path: m.path, value: m.value, layout };
    case "absent":
      return { op: "remove", file: m.file, path: m.path, value: m.value };
    case "task": {
      const at = taskIndex(doc, m.value.label);
      return at < 0
        ? { op: "add", file: m.file, path: ["tasks"], value: m.value, layout }
        : { op: "set", file: m.file, path: ["tasks", at], value: m.value, layout };
    }
  }
}

const shownPath = (path: KeyPath): string => path.map(String).join(" › ");

function describe(m: Managed): { rule: string; message: string; path: KeyPath } {
  switch (m.kind) {
    case "value":
      return {
        rule: "vscode/setting",
        message: `${m.file}：${shownPath(m.path)} 應為 ${JSON.stringify(m.value)}`,
        path: m.path,
      };
    case "member":
      return {
        rule: "vscode/managed-list",
        message: `${m.file}：${shownPath(m.path)} 應包含 ${m.value}`,
        path: m.path,
      };
    case "absent":
      return {
        rule: "vscode/managed-list",
        message: `${m.file}：${shownPath(m.path)} 不應包含 ${m.value}`,
        path: m.path,
      };
    case "task":
      return { rule: "vscode/task", message: `${m.file}：task「${m.value.label}」與標準不同`, path: ["tasks"] };
  }
}

/** 1-based line of the node at `path` (or its nearest existing parent). */
function lineOf(text: string, path: KeyPath): number | undefined {
  const root = parseTree(text);
  if (!root) return undefined;
  for (let n = path.length; n > 0; n--) {
    const node = findNodeAtLocation(root, [...path.slice(0, n)]);
    if (node) return text.slice(0, node.offset).split("\n").length;
  }
  return undefined;
}

/** Files not there yet: a hint when none of them is (not installed), otherwise an error (one was deleted). */
function missingFiles(files: readonly string[], repairs: Repair[], installed: boolean): Finding {
  const list = files.join("、");
  return {
    level: installed ? "error" : "hint",
    layer: "consistency",
    rule: installed ? "vscode/missing-file" : "vscode/not-generated",
    message: installed ? `缺少 CLI 產生的 VS Code 設定：${list}` : `尚未產生 VS Code workspace 設定：${list}`,
    fix: fixText(`產生 ${list}`, repairs),
    repairs,
  };
}

const GITIGNORE = ".gitignore";
const IGNORES_WHOLE_DIR = /^\/?\.vscode(\/(\*\*)?)?$/;

/** SPEC §7.2 提交規則: the workspace files are committed, so `.gitignore` may not ignore the whole `.vscode/`. */
async function gitignoreFinding(cwd: string): Promise<Finding[]> {
  const text = await readIfExists(join(cwd, GITIGNORE));
  const line = text?.split(/\r?\n/).findIndex((l) => IGNORES_WHOLE_DIR.test(l.trim())) ?? -1;
  if (line < 0) return [];
  const exceptions = VSCODE_FILES.map((f) => `!${f}`).join("、");
  return [
    {
      level: "hint",
      layer: "consistency",
      rule: "vscode/gitignored",
      message: `${GITIGNORE} 忽略了整個 .vscode/，CLI 產生的 VS Code 設定不會被提交`,
      file: GITIGNORE,
      line: line + 1,
      fix: `把這一行改成 .vscode/*，並加上例外規則 ${exceptions}`,
    },
  ];
}

function parseErrorFinding(file: string): Finding {
  return {
    level: "error",
    layer: "consistency",
    rule: "vscode/unreadable",
    message: `${file} 不是有效的 JSONC，無法確認 CLI 管理的設定`,
    file,
    fix: `修正 ${file} 的語法，再執行 devguard fix`,
  };
}

function mismatches(file: VscodeFile, text: string, managed: readonly Managed[], layout: Layout): Finding[] {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || (root && root.type !== "object")) return [parseErrorFinding(file)];
  const doc: unknown = root ? (getNodeValue(root) as unknown) : {};
  return managed
    .filter((m) => !satisfied(m, doc))
    .map((m) => {
      const { rule, message, path } = describe(m);
      const repairs = [repair(m, doc, layout)];
      const line = lineOf(text, path);
      return {
        level: "error" as const,
        layer: "consistency" as const,
        rule,
        message,
        file,
        ...(line === undefined ? {} : { line }),
        fix: fixText("改回 CLI 管理的值", repairs),
        repairs,
      };
    });
}

export interface VscodeLayerOptions {
  /**
   * Also report a workspace with none of the files yet, so `fix` and `install` generate them. `check` leaves such a
   * workspace alone: only a workspace that has been set up is held to the standard.
   */
  generate: boolean;
}

/**
 * Consistency check of the CLI-managed parts of `.vscode/` (SPEC §7.2, §8): a changed managed key, or a deleted
 * file, is an error that `devguard fix` repairs; everything else in the files is left to the developer.
 */
export function createVscodeLayer(options: VscodeLayerOptions): CheckLayer {
  return {
    id: "vscode",
    async run({ cwd, resolution }) {
      if (!resolution?.standard || resolution.components.length === 0) return { findings: [] };
      const read = (path: string) => readIfExists(join(cwd, path));
      const managed = await managedWorkspace(resolution, read);
      const layout = workspaceLayout(resolution);
      const findings: Finding[] = [];
      const missing: string[] = [];
      const generate: Repair[] = [];
      for (const file of VSCODE_FILES) {
        const own = managed.filter((m) => m.file === file);
        const text = await read(file);
        if (text === undefined) {
          missing.push(file);
          generate.push(...own.filter((m) => !satisfied(m, {})).map((m) => repair(m, {}, layout)));
        } else {
          findings.push(...mismatches(file, text, own, layout));
        }
      }
      const installed = missing.length < VSCODE_FILES.length;
      if (missing.length > 0 && (installed || options.generate)) {
        findings.unshift(missingFiles(missing, generate, installed));
      }
      findings.push(...(await gitignoreFinding(cwd)));
      return { findings };
    },
  };
}

/** For `check`: holds a workspace that has been set up to the standard. */
export const vscodeFixLayer: CheckLayer = { ...createVscodeLayer({ generate: true }), fixable: true };

/** `check` holds only a workspace that has been set up to the standard; `fix` also generates a missing one. */
export const vscodeLayer: CheckLayer = { ...createVscodeLayer({ generate: false }), fixable: vscodeFixLayer };
/** For `fix` and `install`: also generates the workspace files that are not there yet. */
