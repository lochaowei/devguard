import { relative, resolve } from "node:path";
import { CODE_CATEGORIES, type CodeCategory } from "./code/types.ts";
import { normalizePath } from "./declaration/path.ts";
import type { CheckScope } from "./layers/types.ts";
import { UsageError } from "./report/failure.ts";

export interface ScopeArgs {
  /** File arguments, relative to `here` or absolute. */
  files: readonly string[];
  only?: string;
  full: boolean;
}

function isCategory(value: string): value is CodeCategory {
  return (CODE_CATEGORIES as readonly string[]).includes(value);
}

/** `check [files] [--only <類別>] [--full]` → what to check. Throws UsageError for bad combinations. */
export function checkScope(args: ScopeArgs, root: string, here: string): CheckScope {
  const { only, full } = args;
  if (only !== undefined && !isCategory(only)) {
    throw new UsageError(`不認得的類別「${only}」，可用的有 ${CODE_CATEGORIES.join("|")}`);
  }
  if (full && args.files.length > 0) throw new UsageError("--full 會檢查整個專案，不能同時指定檔案");
  const files = args.files.map((f) => {
    const path = normalizePath(relative(root, resolve(here, f)));
    if (path === "" || path.startsWith("../") || /^[A-Za-z]:/.test(path)) {
      throw new UsageError(`「${f}」不在專案目錄中`);
    }
    return path;
  });
  return { ...(files.length > 0 ? { files } : {}), ...(only === undefined ? {} : { only }), full };
}
