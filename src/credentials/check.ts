import type { ResolvedComponent } from "../declaration/resolve.ts";
import { upwards } from "../repo/paths.ts";
import type { Finding } from "../report/finding.ts";
import type { Language } from "../standard/types.ts";
import { mavenSettingsProblems } from "./maven.ts";
import { npmrcProblems } from "./npm.ts";
import { pyprojectProblems } from "./python.ts";
import type { CredentialProblem, ReadFile } from "./types.ts";

export type { ReadFile } from "./types.ts";

export type CredentialComponent = Pick<ResolvedComponent, "dir" | "language" | "name">;

/** The project files of each language that may hold a package source's credentials, and how to read them. */
const FILES: Partial<Record<Language, readonly [string, (file: string, text: string) => CredentialProblem[]][]>> = {
  python: [["pyproject.toml", pyprojectProblems]],
  typescript: [[".npmrc", npmrcProblems]],
  java: [[".mvn/settings.xml", mavenSettingsProblems]],
};

/**
 * Credentials written into committed project files (SPEC §10): each one is an error, reported without its value.
 * Each component's files are looked up in its directory and every directory above it, as the tools do (the root
 * `.npmrc` of an npm workspace, the root `pyproject.toml` of a uv workspace, the `.mvn/` of a multi-module build); a
 * file several components share is reported once, under the first of them. devguard never rewrites credentials: the
 * secret has leaked and must be changed, and where it should come from instead is the developer's choice.
 */
export async function checkCredentials(components: readonly CredentialComponent[], read: ReadFile): Promise<Finding[]> {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const component of components) {
    for (const [name, problems] of FILES[component.language] ?? []) {
      for (const file of upwards(component.dir).map((dir) => dir + name)) {
        if (seen.has(file)) continue;
        seen.add(file);
        const text = await read(file);
        if (text === undefined) continue;
        findings.push(...problems(file, text).map((p) => finding(component, p)));
      }
    }
  }
  return findings;
}

function finding(component: CredentialComponent, p: CredentialProblem): Finding {
  return {
    level: "error",
    layer: "config",
    rule: "credentials/plaintext",
    component: component.name,
    file: p.file,
    ...(p.line === undefined ? {} : { line: p.line }),
    message: p.message,
    fix: p.fix,
  };
}
