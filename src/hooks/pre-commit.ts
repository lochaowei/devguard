import { join } from "node:path";
import { runCheck, type CheckOptions, type CheckResult } from "../check.ts";
import { CODE_CHECKERS } from "../code/registry.ts";
import { CODE_CATEGORIES } from "../code/types.ts";
import { withoutIgnored } from "../declaration/ignore.ts";
import type { ResolvedComponent } from "../declaration/resolve.ts";
import { isDependencyFile } from "../deps/manifests.ts";
import { codeLayer } from "../layers/code.ts";
import { declarationLayer } from "../layers/declaration.ts";
import { depsLayer } from "../layers/deps.ts";
import type { CheckLayer } from "../layers/types.ts";
import { nodeExec, type EnvVars, type Exec } from "../process/exec.ts";
import { isFixable, type Finding } from "../report/finding.ts";
import { exitCodeFor, renderText } from "../report/render.ts";
import { assignFiles } from "../repo/files.ts";
import { isFile, readIfExists } from "../shared/fs.ts";

export interface HookContext extends Omit<CheckOptions, "scope" | "listFiles" | "stagedText"> {
  /** Runs git; defaults to the real one. */
  exec?: Exec;
  /** Where the hook's report goes (git shows the hook's output to the person committing). */
  write: (text: string) => void;
  /** The hook's input on stdin (Claude Code hooks get a JSON object); absent when the caller passes none. */
  stdin?: () => Promise<string>;
  /** Where structured output goes (Claude Code reads the hook's stdout); defaults to `write`. */
  stdout?: (text: string) => void;
  /** The process environment (`DEVGUARD_PRE_PUSH`); defaults to the real one, tests pass their own. */
  env?: EnvVars;
}

interface StagedEntry {
  status: string;
  path: string;
  /** The staged blob's full object id. */
  blob: string;
}

async function git(ctx: Pick<HookContext, "cwd" | "exec">, args: string[]): Promise<string> {
  const r = await (ctx.exec ?? nodeExec)({ file: "git", args, cwd: ctx.cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} 失敗：${r.stderr.trim()}`);
  return r.stdout;
}

const nulList = (out: string) => out.split("\0").filter((p) => p !== "");

/** The mode git gives a submodule (gitlink): a commit pointer, not a file. */
const GITLINK_MODE = "160000";

/**
 * A staged change as `stagedEntries` keeps it, given its `--raw` modes. A submodule (gitlink) has no staged text and
 * its files are not this repo's (#147): one staged as a submodule is left out, or counts as deleting the file it
 * replaced; a file staged in place of a submodule is checked like any other.
 */
function withoutGitlink(oldMode: string, newMode: string, entry: StagedEntry): StagedEntry | undefined {
  const wasFile = oldMode !== GITLINK_MODE && !/^0+$/.test(oldMode);
  if (newMode === GITLINK_MODE) return wasFile ? { ...entry, status: "D" } : undefined;
  // A deleted or unmerged submodule has no file to check either.
  if (oldMode === GITLINK_MODE && (entry.status === "D" || entry.status === "U")) return undefined;
  return entry;
}

/** `git diff --cached --raw -z`: status, path and blob of each staged change (renames as delete + add). */
async function stagedEntries(ctx: Pick<HookContext, "cwd" | "exec">): Promise<StagedEntry[]> {
  const parts = nulList(await git(ctx, ["diff", "--cached", "--raw", "-z", "--no-renames", "--no-abbrev"]));
  const entries: StagedEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    // `:<old mode> <new mode> <old sha> <new sha> <status>`, then the path.
    const [oldMode = "", newMode = "", , blob = "", status = ""] = (parts[i] ?? "").slice(1).split(" ");
    const entry = withoutGitlink(oldMode, newMode, { status, path: parts[i + 1] ?? "", blob });
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * The staged files (path to blob id) whose working-tree file holds exactly the staged bytes, found with one
 * `git hash-object` for all of them (#205). `--no-filters` hashes the file as it is on disk, so a CRLF checkout of an
 * LF blob does not count as the same. Empty when git cannot hash them; every file is then read from the index.
 */
async function sameOnDisk(
  ctx: Pick<HookContext, "cwd" | "exec">,
  blobs: ReadonlyMap<string, string>,
): Promise<Set<string>> {
  // `--stdin-paths` takes one path per line and unquotes a line that starts with a double quote.
  const plain = [...blobs.keys()].filter((p) => !/[\r\n]/.test(p) && !p.startsWith('"'));
  const present = (await Promise.all(plain.map(async (p) => ((await isFile(join(ctx.cwd, p))) ? [p] : [])))).flat();
  if (present.length === 0) return new Set();
  const args = ["hash-object", "--no-filters", "--stdin-paths"];
  const stdin = present.map((p) => `${p}\n`).join("");
  const r = await (ctx.exec ?? nodeExec)({ file: "git", args, cwd: ctx.cwd, stdin });
  const ids = r.stdout.split("\n").filter((line) => line !== "");
  if (r.code !== 0 || ids.length !== present.length) return new Set();
  return new Set(present.filter((p, i) => ids[i] === blobs.get(p)));
}

/**
 * Reads the staged version of a staged file (undefined for any other path), each file once however many checks ask.
 * A file that is the same on disk (`sameOnDisk`) is read from there; only a file whose staged version differs from
 * the working tree costs a `git show :<path>` (#205).
 */
async function stagedReader(
  ctx: Pick<HookContext, "cwd" | "exec">,
  entries: readonly StagedEntry[],
): Promise<(path: string) => Promise<string | undefined>> {
  const blobs = new Map(entries.filter((e) => e.status !== "D").map((e) => [e.path, e.blob]));
  const unchanged = await sameOnDisk(ctx, blobs);
  const texts = new Map<string, Promise<string>>();
  const fromIndex = (path: string) => git(ctx, ["show", `:${path}`]);
  const read = async (path: string) =>
    unchanged.has(path) ? ((await readIfExists(join(ctx.cwd, path))) ?? fromIndex(path)) : fromIndex(path);
  return (path) => {
    if (!blobs.has(path)) return Promise.resolve(undefined);
    let text = texts.get(path);
    if (text === undefined) {
      text = read(path);
      texts.set(path, text);
    }
    return text;
  };
}

const effectiveValues = (c: ResolvedComponent) =>
  Object.fromEntries(Object.entries(c.effective).map(([k, item]) => [k, item.value]));

/** The tools that will check the working tree rather than the staged version of these files, by language. */
function workingTreeTools(components: readonly ResolvedComponent[], files: readonly string[]): string[] {
  const tools = new Set<string>();
  for (const { owner } of assignFiles(components, files)) {
    const component = owner.kind === "component" ? owner.component : undefined;
    const language = owner.kind === "component" ? owner.component.language : owner.language;
    const target = {
      dir: component?.dir ?? "",
      language,
      effective: component ? effectiveValues(component) : {},
      categories: new Set(CODE_CATEGORIES),
    };
    for (const tool of CODE_CHECKERS[language]?.workingTreeTools(target) ?? []) tools.add(tool);
  }
  return [...tools];
}

/** `devguard fix --code` for the staged files it can fix: those with a fixable code finding (SPEC §7.4). */
function fixLine(findings: readonly Finding[], staged: ReadonlySet<string>): string {
  const listed = (f: Finding): f is Finding & { file: string } =>
    f.layer === "code" && isFixable(f) && f.file !== undefined && staged.has(f.file);
  const files = [...new Set(findings.filter(listed).map((f) => f.file))];
  return files.length === 0 ? "" : `修正程式碼：devguard fix --code ${files.join(" ")}\n`;
}

export interface StagedCheck {
  result: CheckResult;
  /** The staged files the check covered; deleted files are not among them. */
  stagedFiles: ReadonlySet<string>;
  /** Set when a partially staged file is checked in its working-tree version by some tools (SPEC §7.4). */
  warning?: string;
}

/**
 * The staged files' checks, shared by the pre-commit hook and `devguard check --staged` (SPEC §3.2, §7.1, §7.4):
 * lint and format the staged files, type-check their components, and run the dependency rules only when a dependency
 * file is staged. Formatters and single-file linters check the staged version: from disk when the file there is
 * identical, otherwise (`git show :<path>`) through stdin; nothing is stashed or restored. Undefined when nothing is
 * staged.
 */
export async function checkStaged(
  ctx: Omit<HookContext, "write" | "stdout" | "stdin">,
): Promise<StagedCheck | undefined> {
  const entries = await stagedEntries(ctx);
  if (entries.length === 0) return undefined;
  const files = entries.filter((e) => e.status !== "D").map((e) => e.path);
  const stagedFiles = new Set(files);
  const layers: CheckLayer[] = [declarationLayer];
  if (entries.some((e) => isDependencyFile(e.path))) layers.push(depsLayer);
  layers.push(codeLayer);
  const result = await runCheck(
    {
      ...ctx,
      scope: { files, full: false },
      listFiles: () => Promise.resolve(files),
      stagedText: await stagedReader(ctx, entries),
    },
    layers,
  );
  const unstaged = new Set(nulList(await git(ctx, ["diff", "--name-only", "-z"])));
  // Ignored files get no file checks, so no tool reads their working-tree version either.
  const partial = withoutIgnored(result.resolution?.ignore ?? [], files).filter((f) => unstaged.has(f));
  const tools = workingTreeTools(result.resolution?.components ?? [], partial);
  if (tools.length === 0) return { result, stagedFiles };
  const warning =
    `注意：${partial.join("、")} 有未 staged 的修改。其他檢查用的是 staged 版本，` +
    `但 ${tools.join("、")} 沒有可用的 stdin 模式，檢查的是工作目錄版本。\n`;
  return { result, stagedFiles, warning };
}

/**
 * `devguard hook git-pre-commit` (SPEC §7.4, §7.1): the staged files' checks (`checkStaged`). Only checks, never
 * fixes; on failure prints the `devguard fix --code` command. Returns the exit code (non-zero blocks the commit).
 */
export async function runPreCommit(ctx: HookContext): Promise<number> {
  const staged = await checkStaged({ ...ctx, missingTools: "report" });
  if (!staged) return 0;
  const { result, warning } = staged;
  if (warning) ctx.write(warning);
  const code = exitCodeFor(result.findings, false);
  if (result.findings.length > 0) ctx.write(renderText(result));
  if (code !== 0) ctx.write(fixLine(result.findings, staged.stagedFiles));
  return code;
}
