import type { Resolution } from "../declaration/resolve.ts";
import type { Exec } from "../process/exec.ts";
import type { Finding } from "../report/finding.ts";
import { workspaceExtensions } from "../vscode/workspace.ts";
import type { EnvironmentCheck } from "./types.ts";
import { isEnoent } from "../shared/fs.ts";

const LIST_ARGS = ["--list-extensions", "--show-versions"] as const;

/** `publisher.name@version` lines → lower-cased ids. */
const installedIds = (stdout: string): Set<string> =>
  new Set(
    stdout
      .split(/\r?\n/)
      .map((l) =>
        l
          .trim()
          .replace(/@[^@]*$/, "")
          .toLowerCase(),
      )
      .filter((id) => id !== ""),
  );

function marketplace(resolution: Resolution): string {
  const value = resolution.global["mirrors.vscode"]?.value;
  return typeof value === "string" ? value.replace(/\/+$/, "") : "";
}

/** The installed extension ids, or a hint when the `code` command cannot be run. */
async function listInstalled(exec: Exec, file: string, cwd: string): Promise<Set<string> | Finding> {
  try {
    const result = await exec({ file, args: LIST_ARGS, cwd });
    if (result.code === 0) return installedIds(result.stdout);
    return {
      level: "hint",
      layer: "environment",
      rule: "environment/vscode-cli-failed",
      message: `無法列出 VS Code 擴充套件（${file} ${LIST_ARGS.join(" ")} 結束碼 ${String(result.code)}）`,
    };
  } catch (e) {
    if (!isEnoent(e)) throw e;
    return {
      level: "hint",
      layer: "environment",
      rule: "environment/vscode-cli-missing",
      message: "找不到 code 指令，無法確認 VS Code 擴充套件是否已安裝",
      fix: "在 VS Code 執行「Shell Command: Install 'code' command in PATH」，或確認 VS Code 的 bin 目錄在 PATH 中",
    };
  }
}

export interface VscodeExtensionsCheckOptions {
  /** Decides between `code.cmd` (Windows) and `code`; defaults to this machine. */
  platform?: NodeJS.Platform;
}

/**
 * SPEC §7.2 環境檢查: `code --list-extensions --show-versions` (on Windows `code.cmd`, which starts through cmd.exe).
 * It only tells installed from not installed: disabled extensions are listed too, and only the default profile is
 * covered. A missing recommended extension is an error, an installed unwanted one a hint.
 */
export function createVscodeExtensionsCheck(options: VscodeExtensionsCheckOptions = {}): EnvironmentCheck {
  const file = (options.platform ?? process.platform) === "win32" ? "code.cmd" : "code";
  return {
    id: "vscode-extensions",
    async run({ cwd, exec, resolution }) {
      if (!resolution?.standard || resolution.components.length === 0) return [];
      const { recommended, unwanted } = workspaceExtensions(resolution);
      const installed = await listInstalled(exec, file, cwd);
      if (!(installed instanceof Set)) return [installed];
      const url = marketplace(resolution);
      const findings: Finding[] = recommended
        .filter((id) => !installed.has(id.toLowerCase()))
        .map((id) => ({
          level: "error",
          layer: "environment",
          rule: "environment/vscode-extension-missing",
          message: `VS Code 沒有安裝推薦的擴充套件 ${id}（若已安裝但被停用，請在 VS Code 中啟用）`,
          fix: `請從公司內部 marketplace 安裝 ${id}：${url}/items?itemName=${id}`,
        }));
      for (const id of unwanted.filter((u) => installed.has(u.toLowerCase()))) {
        findings.push({
          level: "hint",
          layer: "environment",
          rule: "environment/vscode-extension-unwanted",
          message: `VS Code 安裝了標準不推薦的擴充套件 ${id}，可能與專案的工具衝突`,
          fix: `在這個 workspace 停用或解除安裝 ${id}`,
        });
      }
      return findings;
    },
  };
}

export const vscodeExtensionsCheck: EnvironmentCheck = createVscodeExtensionsCheck();
