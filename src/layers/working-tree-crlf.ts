import { nodeExec, type Exec } from "../process/exec.ts";
import { crlfWorkingTreeFiles, RECHECKOUT_HINT } from "../repo/eol.ts";
import type { CheckLayer } from "./types.ts";

export const WORKING_TREE_CRLF_RULE = "environment/working-tree-crlf";

/** How many affected files the message names as examples. */
const EXAMPLES = 5;

/**
 * A working tree checked out with CRLF over an LF index makes formatters (gofmt, Prettier, Biome...) and
 * `go mod tidy -diff` report nearly every file at line 1. This layer explains why, once for the repo, as a hint; those
 * findings are still reported as they are (#84). The pre-commit hook checks the staged (LF) version, so it skips this.
 */
export function createWorkingTreeCrlfLayer(exec: Exec = nodeExec): CheckLayer {
  return {
    id: "working-tree-crlf",
    async run({ cwd, stagedText }) {
      if (stagedText) return { findings: [] };
      const files = await crlfWorkingTreeFiles(cwd, exec);
      if (files.length === 0) return { findings: [] };
      const examples = files.slice(0, EXAMPLES).join("、") + (files.length > EXAMPLES ? "…" : "");
      return {
        findings: [
          {
            level: "hint",
            layer: "environment",
            rule: WORKING_TREE_CRLF_RULE,
            message:
              `工作目錄有 ${String(files.length)} 個檔案是 CRLF，但 git 裡是 LF（例如 ${examples}）。` +
              "格式工具與 go mod tidy -diff 會因此把這些檔案報成格式錯誤；pre-commit 檢查 staged 的版本，不會。",
            fix: RECHECKOUT_HINT,
          },
        ],
      };
    },
  };
}

export const workingTreeCrlfLayer: CheckLayer = createWorkingTreeCrlfLayer();
