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
 * `exec: false` the shell carries on afterwards (a line added to another tool's hook script, e.g. husky's).
 */
export function hookCommandLine(hook: GitHookName, command = "devguard", { exec = true } = {}): string {
  const program = command.trim().split(/\s+/)[0] ?? command;
  const missing =
    `devguard：找不到 CLI（${program}），已擋下這次 git ${hook === "pre-commit" ? "commit" : "push"}。` +
    `安裝：${CLI_INSTALL_HINT}；要暫時略過檢查可加上 --no-verify`;
  return (
    `command -v ${program} >/dev/null 2>&1 || { echo '${missing}' >&2; exit 1; }; ` +
    `${exec ? "exec " : ""}${command} hook git-${hook} "$@"`
  );
}

/** Whether a hook devguard did not write still hands over to it (`… hook git-<name>`). */
export function callsDevguard(text: string, hook: GitHookName): boolean {
  return new RegExp(`\\bhook git-${hook}\\b`).test(text);
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
