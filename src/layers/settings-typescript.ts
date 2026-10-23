import { join } from "node:path";
import { SettingsJudge } from "../settings/judge.ts";
import { checkBiome } from "../settings/typescript/biome.ts";
import { checkCoverage } from "../settings/typescript/coverage.ts";
import { checkEslint } from "../settings/typescript/eslint.ts";
import { checkPrettier } from "../settings/typescript/prettier.ts";
import { checkTsconfig } from "../settings/typescript/tsconfig.ts";
import type { CheckLayer } from "./types.ts";

async function checkComponent(root: string, judge: SettingsJudge): Promise<void> {
  await checkTsconfig(root, judge);
  const lintTool = judge.declared("lint.tool");
  if (lintTool === "eslint+prettier") {
    await checkEslint(root, judge);
    await checkPrettier(root, judge);
  } else if (lintTool === "biome") {
    await checkBiome(root, judge);
  }
  await checkCoverage(root, judge);
}

/** Settings check for TypeScript components: tool config files vs the declared standard (SPEC §6.3, §8). */
export const typescriptSettingsLayer: CheckLayer = {
  id: "settings-typescript",
  fixable: true,
  async run({ cwd, resolution }) {
    const standard = resolution?.standard;
    if (!standard) return { findings: [] };
    const findings = [];
    for (const component of resolution.components) {
      if (component.language !== "typescript") continue;
      const judge = new SettingsJudge(standard, component);
      await checkComponent(join(cwd, component.dir), judge);
      findings.push(...judge.findings);
    }
    return { findings };
  },
};
