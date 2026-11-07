import type { ResolvedComponent } from "../declaration/resolve.ts";
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
 * devguard never rewrites them: the secret has leaked and must be changed, and where it should come from instead (an
 * environment variable, the user-level config) is the developer's choice.
 */
export async function checkCredentials(components: readonly CredentialComponent[], read: ReadFile): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const component of components) {
    for (const [name, problems] of FILES[component.language] ?? []) {
      const file = component.dir + name;
      const text = await read(file);
      if (text === undefined) continue;
      for (const p of problems(file, text)) {
        findings.push({
          level: "error",
          layer: "config",
          rule: "credentials/plaintext",
          component: component.name,
          file: p.file,
          ...(p.line === undefined ? {} : { line: p.line }),
          message: p.message,
          fix: p.fix,
        });
      }
    }
  }
  return findings;
}
