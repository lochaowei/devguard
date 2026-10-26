import type { Language } from "../standard/types.ts";
import type { Finding } from "../report/finding.ts";
import type { MirrorChecker, MirrorComponent, MirrorSettings, ReadFile } from "./common.ts";
import { checkJava } from "./java.ts";
import { checkNpm } from "./npm.ts";
import { checkPoetry } from "./poetry.ts";
import { checkUv } from "./uv.ts";
import { readPythonManager } from "../tools/python-manager.ts";

export type { MirrorSettings, ReadFile } from "./common.ts";

/** Python: uv's `[[tool.uv.index]]`, or Poetry's `[[tool.poetry.source]]` when the nearest lockfile is poetry.lock. */
const checkPython: MirrorChecker = async (component, mirrors, read) => {
  const checker = (await readPythonManager(component.dir, read)) === "poetry" ? checkPoetry : checkUv;
  return checker(component, mirrors, read);
};

/** Go has no project-level mirror setting: doctor checks `go env` instead (src/environment/go-mirrors.ts). */
const CHECKERS: Partial<Record<Language, MirrorChecker>> = {
  python: checkPython,
  typescript: checkNpm,
  java: checkJava,
};

/**
 * Project-level mirror settings (SPEC §10.2): each component's package manager fetches only from the internal mirror;
 * settings that point elsewhere are errors. Credentials are only ever referenced through environment variables
 * (§10.3): a credential found in a project file is reported, its value never printed.
 */
export async function checkMirrors(
  components: readonly MirrorComponent[],
  mirrors: MirrorSettings,
  read: ReadFile,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const component of components) {
    const checker = CHECKERS[component.language];
    if (checker) findings.push(...(await checker(component, mirrors, read)));
  }
  return findings;
}
