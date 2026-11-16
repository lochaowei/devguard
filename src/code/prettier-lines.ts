import { ToolMissingError, typescriptToolRequest } from "../tools/runner.ts";
import { firstDifferentLine } from "./support.ts";
import type { CodeCheckContext, CodeTarget } from "./types.ts";

/**
 * Formats the files named on stdin (a JSON array, relative to the working directory) with the project's Prettier, as
 * the Prettier CLI does (the file's resolved config, `.editorconfig` included), and prints a JSON array with the
 * formatted text of each, or null for a file that could not be formatted. Passed to `node -e` as one argument: kept on
 * one line and free of double quotes, so it reaches Node unchanged on every platform.
 */
const FORMAT_SCRIPT = [
  "const { readFile } = await import('node:fs/promises');",
  "const loaded = await import('prettier');",
  "const prettier = loaded.default ?? loaded;",
  "let input = '';",
  "process.stdin.setEncoding('utf8');",
  "for await (const chunk of process.stdin) input += chunk;",
  "const formatted = [];",
  "for (const file of JSON.parse(input)) {",
  "try {",
  "const options = await prettier.resolveConfig(file, { editorconfig: true });",
  "formatted.push(await prettier.format(await readFile(file, 'utf8'), { ...options, filepath: file }));",
  "} catch { formatted.push(null); }",
  "}",
  "process.stdout.write(JSON.stringify(formatted));",
].join(" ");

/** The formatted text of each file, in order (null for one that failed); empty when the run gave no usable answer. */
async function formatAll(target: CodeTarget, ctx: CodeCheckContext, files: readonly string[]): Promise<unknown[]> {
  const request = typescriptToolRequest(target, "node");
  const args = ["--input-type=module", "-e", FORMAT_SCRIPT];
  try {
    const result = await ctx.tools.run({ ...request, args, stdin: JSON.stringify(files) });
    const formatted: unknown = result.code === 0 ? JSON.parse(result.stdout) : undefined;
    return Array.isArray(formatted) ? (formatted as unknown[]) : [];
  } catch (e) {
    // Locating the line is a convenience: without Node on PATH, or with output that is not JSON, the line is 1.
    if (e instanceof ToolMissingError || e instanceof SyntaxError) return [];
    throw e;
  }
}

/**
 * The first line Prettier would change in each file it listed as unformatted, in order; 1 where that cannot be told.
 *
 * `prettier --list-different` only names the files. Formatting them again to find the line takes one Node process for
 * all of them, through Prettier's API, rather than one `prettier <file>` each: a Prettier start costs about 0.3 s, so
 * the per-file runs made `check` and the pre-commit hook slower with every format finding (#209).
 */
export async function prettierFirstLines(
  target: CodeTarget,
  ctx: CodeCheckContext,
  files: readonly { file: string; repoPath: string }[],
): Promise<number[]> {
  if (files.length === 0) return [];
  const formatted = await formatAll(
    target,
    ctx,
    files.map((f) => f.file),
  );
  return Promise.all(
    files.map(async ({ repoPath }, i) => {
      const expected = formatted[i];
      if (typeof expected !== "string") return 1;
      const original = await ctx.readText(repoPath);
      return original === undefined ? 1 : firstDifferentLine(original, expected);
    }),
  );
}
