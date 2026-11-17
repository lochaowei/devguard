import { repoReaderSync } from "../shared/fs.ts";
import { installedNpmPackage } from "../versions/installed.ts";
import type { CodeCheckContext, CodeTarget } from "./types.ts";

/**
 * `--no-warn-ignored` (ESLint 9+) makes ESLint skip files its config ignores. ESLint 8 rejects the flag with exit 2,
 * so it is left out when the installed ESLint is older than 9; an unknown version keeps it (#212).
 */
export function eslintIgnoreFlags(target: CodeTarget, ctx: CodeCheckContext): string[] {
  const version = installedNpmPackage(target.dir, "eslint", repoReaderSync(ctx.cwd))?.version;
  const major = version === undefined ? undefined : Number.parseInt(version, 10);
  return major !== undefined && major < 9 ? [] : ["--no-warn-ignored"];
}
