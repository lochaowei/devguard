import { spawn } from "node:child_process";

/** A program to start: absolute path or a name looked up on PATH. */
export interface Command {
  file: string;
  args: readonly string[];
  cwd: string;
  /** Added on top of the inherited environment. */
  env?: Readonly<Record<string, string>>;
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
const NEEDS_QUOTES = /[\s"&|<>^()%!,;=]/;

function quoteForCmd(arg: string): string {
  return arg === "" || NEEDS_QUOTES.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/** `.cmd` / `.bat` files cannot be started directly; they run through `cmd.exe /d /s /c` (SPEC §3.2). */
export function toSpawnSpec(command: Command): SpawnSpec {
  if (!BATCH.test(command.file)) return command;
  const line = [`"${command.file}"`, ...command.args.map(quoteForCmd)].join(" ");
  return { ...command, file: "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}

/** The real Exec, built on child_process.spawn. */
export const nodeExec: Exec = (command) => {
  const spec = toSpawnSpec(command);
  return new Promise((resolve, reject) => {
    const child = spawn(spec.file, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
};
