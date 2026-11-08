import { nodeExec, type Exec } from "../process/exec.ts";

/**
 * Tracked files committed with LF but checked out with CRLF (`git ls-files --eol`: `i/lf w/crlf`), as on Git for
 * Windows with `core.autocrlf=true`. Empty outside a git repo or without git. Files committed with CRLF (`i/crlf`) are
 * the project's own choice and not listed.
 */
export async function crlfWorkingTreeFiles(cwd: string, exec: Exec = nodeExec): Promise<string[]> {
  let stdout: string;
  try {
    const r = await exec({ file: "git", args: ["ls-files", "--eol", "-z"], cwd });
    if (r.code !== 0) return [];
    stdout = r.stdout;
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code !== "ENOENT") throw e;
    return [];
  }
  return stdout.split("\0").flatMap((entry) => {
    const tab = entry.indexOf("\t");
    if (tab < 0) return [];
    const [index, worktree] = entry.slice(0, tab).trim().split(/\s+/);
    return index === "i/lf" && worktree === "w/crlf" ? [entry.slice(tab + 1)] : [];
  });
}

/**
 * How to check the working tree out again under the current `.gitattributes`. One command per line, so each runs as
 * is in PowerShell (5.1 has no `&&`) and Git Bash. Both discard uncommitted changes, hence the warning first.
 */
export const RECHECKOUT_HINT = [
  "以下指令會丟掉所有未提交的修改（包括 devguard fix 剛寫入的檔案），請先 commit 或 stash；",
  "然後在 repo 根目錄依序執行（PowerShell 與 Git Bash 皆可），依 .gitattributes 重新 checkout：",
  "    git rm --cached -r -q .",
  "    git reset --hard",
].join("\n");
