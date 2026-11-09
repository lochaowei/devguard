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

/** How a hook devguard did not write reaches devguard: it does, it never calls it, or the call comes too late. */
export type DevguardCall = { kind: "runs" } | { kind: "missing" } | { kind: "unreachable"; after: string };

/** The script's lines with `\`-continued lines joined. */
const logicalLines = (text: string): string[] => text.replace(/\\\r?\n/g, " ").split(/\r?\n/);

/** A line with the contents of its quoted strings and its comment removed, so neither is read as code. */
const codeOf = (line: string): string => line.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '""').replace(/(^|\s)#.*$/, "$1");

/** The line's commands, each with whether it runs unconditionally (not after `&&`, `||` or `|`). */
function commandsOf(code: string): { words: string[]; unconditional: boolean }[] {
  const parts = code.split(/(&&|\|\||;;|[;&|])/);
  const out: { words: string[]; unconditional: boolean }[] = [];
  for (let k = 0; k < parts.length; k += 2) {
    const before = parts[k - 1];
    const words = (parts[k] ?? "").trim().split(/\s+/).filter(Boolean);
    out.push({ words, unconditional: before === undefined || before === ";" || before === "&" || before === ";;" });
  }
  return out;
}

const OPENS = new Set(["if", "while", "until", "{"]);
const CONTINUES = new Set(["then", "do", "else", "elif", "!"]);
const CLOSES = new Set(["fi", "done", "esac", "}"]);

/**
 * Steps over the reserved words a command starts with, tracking how deep inside `if`/`case`/loops/braces/function
 * bodies it is. Returns the command words left (none after `for`/`case`, whose heads are not commands).
 */
function stepKeywords(words: readonly string[], depth: number): { rest: readonly string[]; depth: number } {
  let i = 0;
  for (; i < words.length; i++) {
    const w = words[i] ?? "";
    if (OPENS.has(w)) depth++;
    else if (CLOSES.has(w)) depth--;
    else if (w === "for" || w === "case") return { rest: [], depth: depth + 1 };
    else if (w === "()" || w.endsWith("()")) continue;
    else if (!CONTINUES.has(w)) break;
  }
  return { rest: words.slice(i), depth };
}

/** Whether a command ends the script: `exit`, loading another script, or `exec` of a program (not redirections only). */
function endsScript([first, ...args]: readonly string[]): boolean {
  if (first === "exit" || first === "." || first === "source") return true;
  return (
    first === "exec" &&
    args
      .join(" ")
      .replace(/\d*(?:<<?|>>?)&?-?\s*[^\s<>]*/g, "")
      .trim() !== ""
  );
}

/**
 * Whether a hook devguard did not write still hands over to it (`… hook git-<name>`), counting a call only before the
 * first top-level, unconditional command that ends the script: `exit`, `exec` of a program, or `.` / `source` of
 * another script. husky 4.1.0–4.3.8 hooks end with `. "$(dirname "$0")/husky.sh"`, and husky.sh exits, so a line added
 * after it never runs (#126). Not a shell parser: a command under `if`/`case`/a loop/braces/a function, or after
 * `&&`/`||`/`|`, is not taken to end the script, so husky 4.0.x's inline hook, which exits from a function, is not
 * recognised.
 */
export function devguardCall(text: string, hook: GitHookName): DevguardCall {
  const call = new RegExp(`\\bhook git-${hook}\\b`);
  let depth = 0;
  for (const line of logicalLines(text)) {
    const code = codeOf(line);
    if (call.test(code)) return { kind: "runs" };
    for (const { words, unconditional } of commandsOf(code)) {
      const stepped = stepKeywords(words, depth);
      depth = stepped.depth;
      if (depth === 0 && unconditional && endsScript(stepped.rest)) return { kind: "unreachable", after: line.trim() };
    }
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
