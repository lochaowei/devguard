import { claudeRepairs, hasClaudeSetup } from "../claude/setup.ts";
import { fixText } from "../fix/category.ts";
import { planChanges } from "../fix/plan.ts";
import type { Finding } from "../report/finding.ts";
import type { CheckLayer } from "./types.ts";

export interface ClaudeCodeLayerOptions {
  /** `install`: plan the setup even where the project has none yet. `check` / `fix` only keep an existing one current. */
  create?: boolean;
  /** How the hooks start the CLI; defaults to `devguard`. */
  command?: string;
}

export const CLAUDE_CODE_LAYER_ID = "claude-code";

/**
 * The Claude Code files devguard generates (SPEC §7.3): `.claude/settings.json` hooks, the rules for each component
 * and the `/standards-doctor` skill. A file that differs from what the standard asks for is an error `fix` repairs.
 */
export function createClaudeCodeLayer(options: ClaudeCodeLayerOptions = {}): CheckLayer {
  return {
    id: CLAUDE_CODE_LAYER_ID,
    fixable: true,
    async run({ cwd, resolution }) {
      if (!resolution?.standard) return { findings: [] };
      if (!options.create && !(await hasClaudeSetup(cwd))) return { findings: [] };
      const repairs = await claudeRepairs(cwd, resolution, options.command);
      const plan = await planChanges(cwd, repairs);
      const findings = plan.writes.map((w): Finding => {
        const own = repairs.filter((r) => r.file === w.file);
        return {
          level: "error",
          layer: "config",
          rule: "settings/claude-code",
          message: `${w.file}：${w.before === "" ? "缺少" : "與標準不一致的"} Claude Code 設定`,
          file: w.file,
          fix: fixText("重新產生 Claude Code 設定", own),
          repairs: own,
        };
      });
      return { findings };
    },
  };
}

export const claudeCodeLayer: CheckLayer = createClaudeCodeLayer();
