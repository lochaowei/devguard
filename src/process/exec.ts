import { spawn } from "node:child_process";
import { viaCmd } from "./cmd-shim.ts";

/** A program to start: absolute path or a name looked up on PATH. */
export interface Command {
  file: string;
  args: readonly string[];
  cwd: string;
  /** Added on top of the inherited environment. */
  env?: Readonly<Record<string, string>>;
  /** Inherited variables left out of the program's environment (matched ignoring case on Windows). */
  unsetEnv?: readonly string[];
  /** Written to the program's stdin; stdin is closed either way. */
  stdin?: string;
}

export interface SpawnSpec extends Command {
  windowsVerbatimArguments?: true;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Starts a process and collects its output. Rejects with an ENOENT error when the program cannot be found. */
export type Exec = (command: Command) => Promise<ExecResult>;

const BATCH = /\.(cmd|bat)$/i;

/**
 * `.cmd` / `.bat` files cannot be started directly; they run through `cmd.exe /d /s /c` (SPEC §3.2, via `viaCmd`).
 * Throws when an argument cannot pass through cmd.exe unchanged.
 */
export function toSpawnSpec(command: Command): SpawnSpec {
  return BATCH.test(command.file) ? { ...command, ...viaCmd(command.file, command.args) } : command;
}

/** The program's environment: the inherited one without `unsetEnv`, plus `env`. */
function environment(command: Command): NodeJS.ProcessEnv {
  const fold = (name: string) => (process.platform === "win32" ? name.toUpperCase() : name);
  const unset = new Set((command.unsetEnv ?? []).map(fold));
  const inherited = Object.entries(process.env).filter(([name]) => !unset.has(fold(name)));
  return { ...Object.fromEntries(inherited), ...command.env };
}

/** The real Exec, built on child_process.spawn. */
export const nodeExec: Exec = (command) =>
  new Promise((resolve, reject) => {
    const spec = toSpawnSpec(command);
    const child = spawn(spec.file, spec.args, {
      cwd: spec.cwd,
      env: environment(spec),
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.stdin.on("error", () => undefined);
    child.stdin.end(spec.stdin);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
