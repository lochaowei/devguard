import { ToolMissingError } from "../tools/runner.ts";

/** Bad command-line usage. */
export class UsageError extends Error {}

/**
 * What to print on stderr when the CLI itself fails (exit 2, SPEC §11). A missing tool gets here only from a command
 * that must run it (`standard upgrade --apply`'s package manager); the checks report it as a finding instead.
 */
export function failureMessage(e: unknown, usage: string): string {
  if (e instanceof ToolMissingError) return e.report();
  const message = e instanceof Error ? e.message : String(e);
  const parseArgs = (e as { code?: unknown } | null)?.code;
  if (e instanceof UsageError || (typeof parseArgs === "string" && parseArgs.startsWith("ERR_PARSE_ARGS"))) {
    return `${message}\n\n${usage}`;
  }
  return `devguard 內部錯誤：${message}\n`;
}
