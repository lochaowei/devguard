import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { checkWrapper } from "../settings/java/build.ts";
import { checkCheckstyle } from "../settings/java/checkstyle.ts";
import type { JavaTarget } from "../settings/java/common.ts";
import { checkPmd } from "../settings/java/pmd.ts";
import { checkLombok } from "../settings/java/lombok.ts";
import { checkJavaVersion } from "../settings/java/version.ts";
import type { CheckLayer } from "./types.ts";

/** Settings check for Java components: build wrapper, Checkstyle, PMD and the Java version (SPEC §6.4, §8). */
export const javaSettingsLayer: CheckLayer = {
  id: "settings-java",
  async run(ctx) {
    const { resolution, cwd } = ctx;
    const components = resolution?.components.filter((c) => c.language === "java") ?? [];
    if (!resolution?.standard || components.length === 0) return { findings: [] };
    const defs = resolution.standard.languages.java;
    const files = new Set(await ctx.files());
    const read = (path: string) => readFile(join(cwd, path), "utf8");
    const findings = [];
    for (const component of components) {
      const t: JavaTarget = { component, defs, files, read };
      findings.push(
        ...checkWrapper(t),
        ...(await checkJavaVersion(t)),
        ...(await checkCheckstyle(t)),
        ...(await checkPmd(t)),
        ...(await checkLombok(t)),
      );
    }
    return { findings };
  },
};
