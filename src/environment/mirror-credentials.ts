import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedComponent } from "../declaration/resolve.ts";
import { GRADLE_AUTH_VARIABLES, isGradle, MAVEN_AUTH_VARIABLES } from "../mirrors/java.ts";
import { NPM_AUTH_VARIABLE, npmrcVariables } from "../mirrors/npm.ts";
import { PYTHON_MANAGERS, readPythonManager } from "../tools/python-manager.ts";
import type { Finding } from "../report/finding.ts";
import type { EnvironmentCheck, EnvironmentContext } from "./types.ts";
import { readIfExists } from "../shared/fs.ts";

type Env = EnvironmentContext["env"];

/** Presence only: the value is never kept, compared with anything or printed (SPEC §10.3). */
const isSet = (env: Env, name: string): boolean => (env[name] ?? "") !== "";

async function exists(path: string | undefined): Promise<boolean> {
  if (path === undefined) return false;
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const windows = process.platform === "win32";

/** Where Go reads credentials: `NETRC`, else `%USERPROFILE%\_netrc` on Windows (`$HOME/.netrc` elsewhere). */
function netrcPath(env: Env): string | undefined {
  if (isSet(env, "NETRC")) return env.NETRC;
  const home = windows ? env.USERPROFILE : env.HOME;
  return home ? join(home, windows ? "_netrc" : ".netrc") : undefined;
}

/** `GRADLE_USER_HOME/gradle.properties`, by default under the user's `.gradle`. */
function gradleProperties(env: Env): string | undefined {
  const home = env.GRADLE_USER_HOME ?? (windows ? env.USERPROFILE : env.HOME);
  if (!home) return undefined;
  return join(home, ...(env.GRADLE_USER_HOME ? [] : [".gradle"]), "gradle.properties");
}

const setx = (names: readonly string[]): string =>
  `${names.map((n) => `setx ${n} "<值>"`).join("；")}（設定使用者環境變數，之後重新開啟終端機）`;

function missingVariables(names: readonly string[], why: string): Finding {
  return {
    level: "error",
    layer: "environment",
    rule: "mirrors/credentials-missing",
    message: `mirrors.auth 為 env，但沒有設定環境變數 ${names.join("、")}（${why}）`,
    fix: setx(names),
  };
}

/** The variables a component's tool reads its mirror credentials from, and what they are for. */
async function variablesFor(ctx: EnvironmentContext, component: ResolvedComponent): Promise<[string[], string]> {
  const read = (file: string) => readIfExists(join(ctx.cwd, file));
  switch (component.language) {
    case "python": {
      const { auth } = PYTHON_MANAGERS[await readPythonManager(component.dir, read)];
      return [[...auth.variables], auth.purpose];
    }
    case "typescript": {
      const referenced = npmrcVariables((await read(`${component.dir}.npmrc`)) ?? "");
      return [referenced.length > 0 ? referenced : [NPM_AUTH_VARIABLE], `${component.dir}.npmrc 引用`];
    }
    case "java":
      return (await isGradle(component, read))
        ? [[...GRADLE_AUTH_VARIABLES], "Gradle 的 nexus repository"]
        : [[...MAVEN_AUTH_VARIABLES], "Maven 的 .mvn/settings.xml"];
    case "go":
      return [[], ""];
  }
}

async function goNetrc(env: Env): Promise<Finding | undefined> {
  const path = netrcPath(env);
  if (await exists(path)) return undefined;
  const where = isSet(env, "NETRC") ? `NETRC 指向的 ${path ?? ""}` : (path ?? "%USERPROFILE%\\_netrc");
  return {
    level: "error",
    layer: "environment",
    rule: "mirrors/netrc-missing",
    message: `mirrors.auth 為 env，但找不到 Go 讀取帳密的 netrc 檔：${where}`,
    fix: "建立該檔案，寫入 machine <Nexus 主機名稱> login <帳號> password <密碼>（只寫主機名稱，僅適用 HTTPS）",
  };
}

/** A component's missing credentials, each variable (or the netrc file) reported once per repo. */
async function componentProblem(
  ctx: EnvironmentContext,
  component: ResolvedComponent,
  reported: Set<string>,
): Promise<Finding | undefined> {
  if (component.language === "go") {
    if (reported.has("netrc")) return undefined;
    reported.add("netrc");
    return goNetrc(ctx.env);
  }
  const [names, why] = await variablesFor(ctx, component);
  const missing = names.filter((n) => !isSet(ctx.env, n) && !reported.has(n));
  if (missing.length === 0) return undefined;
  if (names[0] === GRADLE_AUTH_VARIABLES[0] && (await exists(gradleProperties(ctx.env)))) return undefined;
  for (const n of missing) reported.add(n);
  return missingVariables(missing, why);
}

/**
 * `mirrors.auth: env` (SPEC §10.3): the credentials each component's tool needs are in the environment (or the netrc
 * / gradle.properties file exists). Only presence is checked; values are never read into a finding or printed.
 */
export const mirrorCredentialsCheck: EnvironmentCheck = {
  id: "mirror-credentials",
  async run(ctx) {
    const resolution = ctx.resolution;
    if (resolution?.global["mirrors.auth"]?.value !== "env") return [];
    const findings: Finding[] = [];
    const reported = new Set<string>();
    for (const component of resolution.components) {
      const found = await componentProblem(ctx, component, reported);
      if (found) findings.push(found);
    }
    return findings;
  },
};
