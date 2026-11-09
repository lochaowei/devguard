import { join } from "node:path";
import { isDirectory } from "../shared/fs.ts";
import { pythonEnvironmentDirs } from "../tools/runner.ts";
import type { Finding } from "../report/finding.ts";
import type { EnvironmentCheck } from "./types.ts";

/**
 * SPEC §7.2: `fix` writes `python.defaultInterpreterPath` as `${workspaceFolder}/<dir>.venv` (a committed file, so
 * never a personal path). When that directory is missing but the project environment devguard runs tools in (e.g. from
 * `UV_PROJECT_ENVIRONMENT`, #66) exists elsewhere, the Ruff / mypy extensions (`importStrategy: fromEnvironment`) find
 * no tools; hint that VS Code needs another interpreter (#115). With no environment anywhere the tool check reports it.
 */
export const vscodeInterpreterCheck: EnvironmentCheck = {
  id: "vscode-interpreter",
  async run({ cwd, env, resolution }) {
    // The interpreter setting follows the first Python component only (see managedWorkspace).
    const component = resolution?.components.find((c) => c.language === "python");
    if (!component) return [];
    const dir = component.dir.replace(/\/$/, "");
    const interpreter = join(cwd, dir, ".venv");
    if (await isDirectory(interpreter)) return [];
    const environments = pythonEnvironmentDirs(cwd, component.dir, { processEnv: env });
    for (const candidate of environments) {
      if (!(await isDirectory(candidate))) continue;
      const finding: Finding = {
        level: "hint",
        layer: "environment",
        rule: "environment/vscode-interpreter",
        message: `VS Code 的 python.defaultInterpreterPath 指向 ${interpreter}，這個目錄不存在；devguard 實際使用的專案環境是 ${candidate}，Ruff／mypy 擴充套件會找不到工具`,
        fix: `在 VS Code 執行「Python: Select Interpreter」選擇 ${candidate}，或在使用者設定（不要提交到 repo）把 python.defaultInterpreterPath 指向它`,
      };
      return [finding];
    }
    return [];
  },
};
