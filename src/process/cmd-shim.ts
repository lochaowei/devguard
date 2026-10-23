/**
 * `.cmd` / `.bat` files cannot be started as processes; they must go through `cmd.exe` (SPEC §3.2).
 * This builds the `cmd.exe /d /s /c ""<file>" "<arg>" …"` command line: `/d` skips AutoRun and
 * `/s` strips only the outer pair of quotes.
 */
export interface CmdInvocation {
  file: "cmd.exe";
  args: string[];
  /** Must be passed to `spawn` so the runtime does not re-escape the quotes. */
  windowsVerbatimArguments: true;
}

/**
 * Inside double quotes cmd.exe still expands `%VAR%` and cannot escape a literal `"`, so such
 * arguments would reach the script altered. Refuse them instead of passing something else.
 */
function quote(value: string): string {
  if (/["%\r\n]/.test(value)) throw new Error(`這個參數無法透過 cmd.exe 原樣傳遞：${value}`);
  return `"${value}"`;
}

export function viaCmd(file: string, args: readonly string[]): CmdInvocation {
  const line = [file, ...args].map(quote).join(" ");
  return { file: "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}
