import { createHash } from "node:crypto";
import { CLI_INSTALL_HINT } from "../distribution.ts";
import { withGeneratedHeader } from "../fix/plan.ts";

/** The git hooks devguard installs; each calls `devguard hook git-<name>` (SPEC §3.2, §7.4). */
export type GitHookName = "pre-commit" | "pre-push";

export interface HookFileOptions {
  /** How the hook starts the CLI. Defaults to `devguard`; tests use `node "<repo>/src/cli.ts"`. */
  command?: string;
}

const MARKER = /^# devguard-hook (\S+) sha256=([0-9a-f]{64})$/m;

const checksum = (body: string): string => createHash("sha256").update(body).digest("hex");

/** The file without its marker line, LF line ends: what the checksum covers. */
const checksummed = (text: string): string => text.replace(/\r\n/g, "\n").replace(/^# devguard-hook .*\n/m, "");

/**
 * The single command line: stop with the install command when the CLI is missing, otherwise hand over to it. With
 * `exec: false` the shell carries on afterwards when devguard passes and ends the hook with devguard's status when it
 * fails (a line added to another tool's hook script, e.g. husky's).
 */
export function hookCommandLine(hook: GitHookName, command = "devguard", { exec = true } = {}): string {
  const program = command.trim().split(/\s+/)[0] ?? command;
  const missing =
    `devguard：找不到 CLI（${program}），已擋下這次 git ${hook === "pre-commit" ? "commit" : "push"}。` +
    `安裝：${CLI_INSTALL_HINT}；要暫時略過檢查可加上 --no-verify`;
  const call = `${command} hook git-${hook} "$@"`;
  return (
    `command -v ${program} >/dev/null 2>&1 || { echo '${missing}' >&2; exit 1; }; ` +
    (exec ? `exec ${call}` : `${call} || exit $?`)
  );
}

/** Where the line goes in a hook devguard did not write: anything later may never run (#126). */
export const FOREIGN_HOOK_PLACEMENT = "加在這個 hook 的開頭（#! 那一行之後的下一行）";

/** The line to add to a hook devguard did not write (`FOREIGN_HOOK_PLACEMENT` says where). */
export const foreignHookLine = (hook: GitHookName, command?: string): string =>
  hookCommandLine(hook, command, { exec: false });

/**
 * How a hook devguard did not write reaches devguard: it does, it never calls it, the call comes too late, or the call
 * comes after loading another script, which ends the hook if that script exits (#163).
 */
export type DevguardCall =
  | { kind: "runs" }
  | { kind: "missing" }
  | { kind: "unreachable"; after: string }
  | { kind: "uncertain"; after: string };

/** The script's lines with `\`-continued lines joined. */
const logicalLines = (text: string): string[] => text.replace(/\\\r?\n/g, " ").split(/\r?\n/);

/** A line with the contents of its quoted strings and its comment removed, so neither is read as code. */
const codeOf = (line: string): string => line.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '""').replace(/(^|\s)#.*$/, "$1");

interface Command {
  words: string[];
  /** Not after `&&`, `||` or `|`. */
  unconditional: boolean;
  /** Followed by `&`: runs in the background, so an `exit` there does not end the script. */
  background: boolean;
}

/** The line's commands in order; `&` in a redirection (`2>&1`, `>&2`, `&>`) does not separate commands. */
function commandsOf(code: string): Command[] {
  const parts = code.split(/(&&|\|\||;;|;|(?<![<>])&(?!>)|\|)/);
  const out: Command[] = [];
  for (let k = 0; k < parts.length; k += 2) {
    const before = parts[k - 1];
    const words = (parts[k] ?? "").trim().split(/\s+/).filter(Boolean);
    const unconditional = before === undefined || before === ";" || before === "&" || before === ";;";
    out.push({ words, unconditional, background: parts[k + 1] === "&" });
  }
  return out;
}

/**
 * What a command sits in: a function body (runs only when called), a compound command or a group run under a
 * condition (`if`/loops/`case`, `&& { … }`), or a group run unconditionally (`{ …; }`, as if it were not there).
 */
type Frame = "function" | "conditional" | "group";

interface Scan {
  frames: Frame[];
  /** A function's name was read and its body's `{` is still to come. */
  functionHeader: boolean;
  /** End markers of the here-documents whose lines come next. */
  heredocs: string[];
  /** The first top-level line that loads another script (not husky.sh), if any. */
  loaded?: string;
  /** husky 4.0.x's inline hook (see `isHusky40`). */
  husky40: boolean;
}

const OPENS = new Set(["if", "while", "until"]);
const HEADS = new Set(["for", "case", "select"]);
const CONTINUES = new Set(["then", "do", "else", "elif", "!"]);
const CLOSES = new Set(["fi", "done", "esac", "}"]);

/** How many words a function definition's header takes at `i` (`function f`, `f()`, `f ()`); 0 when there is none. */
function functionHeaderAt(words: readonly string[], i: number): number {
  const w = words[i] ?? "";
  if (w === "function") return words[i + 2] === "()" ? 3 : 2;
  if (words[i + 1] === "()") return 2;
  return /^[\w.:-]+\(\)$/.test(w) ? 1 : 0;
}

/** Opens or closes the frame for a reserved word; false when `w` is not one that steps over. */
function stepWord(w: string, scan: Scan, unconditional: boolean): boolean {
  if (w === "{") scan.frames.push(scan.functionHeader ? "function" : unconditional ? "group" : "conditional");
  else if (OPENS.has(w)) scan.frames.push("conditional");
  else if (CLOSES.has(w)) scan.frames.pop();
  else if (!CONTINUES.has(w)) return false;
  scan.functionHeader = false;
  return true;
}

/**
 * Steps over the function headers and reserved words a command starts with, opening and closing frames. Returns the
 * command words left (none after `for`/`case`/`select`, whose heads are not commands).
 */
function stepKeywords(words: readonly string[], scan: Scan, unconditional: boolean): readonly string[] {
  let i = 0;
  while (i < words.length) {
    const header = functionHeaderAt(words, i);
    if (header > 0) {
      scan.functionHeader = true;
      i += header;
    } else if (HEADS.has(words[i] ?? "")) {
      scan.frames.push("conditional");
      return [];
    } else if (stepWord(words[i] ?? "", scan, unconditional)) i++;
    else break;
  }
  return words.slice(i);
}

const PREFIXES = new Set(["exec", "command", "env", "time", "nice"]);
/** Commands that only print or ignore their arguments: `echo please run devguard hook git-pre-commit` is no call. */
const NOT_CALLS = new Set(["echo", "printf", ":", "true", "false", "test", "["]);

/** Whether the command runs `… hook git-<name>`: the words, after the program, include `hook git-<name>`. */
function isCall(words: readonly string[], hook: GitHookName): boolean {
  let i = 0;
  while (i < words.length && (PREFIXES.has(words[i] ?? "") || /^\w+=/.test(words[i] ?? ""))) i++;
  const program = words[i];
  if (program === undefined || NOT_CALLS.has(program)) return false;
  return words.some((w, k) => k > i && w === "hook" && words[k + 1] === `git-${hook}`);
}

/**
 * Whether a top-level command ends the script: `exit`, `exec` of a program (not redirections only) or loading husky.sh
 * (husky 4.1.0–4.3.8, #126). Loading any other script may end it ("may"): `. ~/.nvm/nvm.sh` returns, but nothing here
 * reads the loaded script.
 */
function ending([first, ...args]: readonly string[], line: string): "ends" | "may" | undefined {
  if (first === "exit") return "ends";
  if (first === "." || first === "source") return /\bhusky\.sh\b/.test(line) ? "ends" : "may";
  const redirectsOnly =
    args
      .join(" ")
      .replace(/\d*(?:<<?|>>?)&?-?\s*[^\s<>]*/g, "")
      .trim() === "";
  return first === "exec" && !redirectsOnly ? "ends" : undefined;
}

/**
 * husky 4.0.0–4.0.10 wrote the whole hook script inline (src/installer/getScript.ts, marked `# husky`): it ends with
 * `case $packageManager in … run_command …;; esac`, and `run_command` exits with husky's status, so a line added at the
 * end never runs. 4.1.0 onwards load husky.sh instead; husky 1–3 end with an `if` that runs husky and do not exit.
 */
const isHusky40 = (text: string): boolean =>
  /^# husky\r?$/m.test(text) && /^run_command \(\) \{\r?$/m.test(text) && /^case \$packageManager in\r?$/m.test(text);

/** The end markers of the here-documents a line starts (`<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`; not `<<<`). */
function heredocsOf(line: string): string[] {
  if (!/(?<!<)<<(?!<)/.test(codeOf(line))) return [];
  return [...line.matchAll(/(?<!<)<<(-?)\s*(['"]?)([\w.-]+)\2/g)].map((m) => `${m[1] ?? ""}${m[3] ?? ""}`);
}

/** Whether the line ends the next here-document (`-EOF` marks a `<<-` one, whose end may be indented by tabs). */
function endsHeredoc(line: string, marker: string): boolean {
  return marker.startsWith("-") ? line.replace(/^\t+/, "") === marker.slice(1) : line === marker;
}

/** Whether the command runs whenever the script reaches it: at the top level or in groups that are. */
const atTop = (scan: Scan, { unconditional, background }: Command): boolean =>
  unconditional && !background && scan.frames.every((f) => f === "group");

/** husky 4.0.x's closing `case $packageManager`, read before stepping over `case` (see `isHusky40`). */
const endsHusky40 = (command: Command, line: string, scan: Scan): boolean =>
  scan.husky40 && atTop(scan, command) && /^\s*case \$packageManager in\b/.test(line);

/** What one command of `line` says about the call, or undefined to read on. */
function scanCommand(command: Command, line: string, scan: Scan, hook: GitHookName): DevguardCall | undefined {
  if (endsHusky40(command, line, scan)) return { kind: "unreachable", after: line.trim() };
  const rest = stepKeywords(command.words, scan, command.unconditional);
  if (scan.frames.includes("function")) return undefined;
  if (isCall(rest, hook)) return scan.loaded ? { kind: "uncertain", after: scan.loaded } : { kind: "runs" };
  if (!atTop(scan, command)) return undefined;
  const end = ending(rest, line);
  if (end === "ends") return { kind: "unreachable", after: line.trim() };
  if (end === "may") scan.loaded ??= line.trim();
  return undefined;
}

/** What one line says about the call, or undefined to read on. */
function scanLine(line: string, scan: Scan, hook: GitHookName): DevguardCall | undefined {
  for (const command of commandsOf(codeOf(line))) {
    const found = scanCommand(command, line, scan, hook);
    if (found) return found;
  }
  scan.heredocs.push(...heredocsOf(line));
  return undefined;
}

/**
 * Whether a hook devguard did not write still hands over to it (`… hook git-<name>` as a command), counting a call only
 * before the first top-level, unconditional command that ends the script: `exit`, `exec` of a program, loading
 * husky.sh (see `ending`), or husky 4.0.x's closing `case` (see `isHusky40`). A call after loading another script is `uncertain`. Not a
 * shell parser: here-documents are skipped and a function body's calls and exits do not count, but a function is never
 * followed into where it is called, and a command under `if`/`case`/a loop or after `&&`/`||`/`|` is not taken to end
 * the script.
 */
export function devguardCall(text: string, hook: GitHookName): DevguardCall {
  const scan: Scan = { frames: [], functionHeader: false, heredocs: [], husky40: isHusky40(text) };
  for (const line of logicalLines(text)) {
    const marker = scan.heredocs[0];
    if (marker !== undefined) {
      if (endsHeredoc(line, marker)) scan.heredocs.shift();
      continue;
    }
    const found = scanLine(line, scan, hook);
    if (found) return found;
  }
  return { kind: "missing" };
}

/**
 * The hook file devguard writes: one line of POSIX sh run by Git for Windows' sh, a "由 CLI 產生" header and a marker
 * line `# devguard-hook <name> sha256=<checksum of the rest of the file>` (SPEC §7.4).
 */
export function renderHookFile(hook: GitHookName, options: HookFileOptions = {}): string {
  const body = withGeneratedHeader(hook, `#!/bin/sh\n${hookCommandLine(hook, options.command)}\n`);
  const [shebang, header, ...rest] = body.split("\n");
  return [shebang, header, `# devguard-hook ${hook} sha256=${checksum(body)}`, ...rest].join("\n");
}

export type HookFileStatus =
  | { kind: "devguard"; hook: string; intact: boolean }
  /** Not written by devguard: a hand-written hook or another tool's. */
  | { kind: "foreign" };

/** Whether a hook file is devguard's and unmodified (for `install` and the doctor's "hook installed" check). */
export function inspectHookFile(text: string): HookFileStatus {
  const marker = MARKER.exec(text.replace(/\r\n/g, "\n"));
  if (!marker) return { kind: "foreign" };
  return { kind: "devguard", hook: marker[1] ?? "", intact: checksum(checksummed(text)) === marker[2] };
}
