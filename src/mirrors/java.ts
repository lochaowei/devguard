import type { Repair } from "../fix/repair.ts";
import { child, descendants, parseXmlText, type XmlEl } from "../xml/parse.ts";
import {
  internal,
  mirrorFinding,
  redact,
  sameUrl,
  type MirrorChecker,
  type MirrorComponent,
  type MirrorProblem,
  type MirrorSettings,
  type ReadFile,
} from "./common.ts";

/** The id of the mirror in `.mvn/settings.xml`; its `<server>` must share it (SPEC §10.3). */
export const MAVEN_MIRROR_ID = "nexus";
/** Maven and Gradle (through `.mvn/settings.xml`'s `${env.*}`) read these (SPEC §10.3). */
export const MAVEN_AUTH_VARIABLES = ["NEXUS_USERNAME", "NEXUS_PASSWORD"] as const;
/** Gradle's `credentials(PasswordCredentials)` on the repository named `nexus` reads these project properties. */
export const GRADLE_AUTH_VARIABLES = ["ORG_GRADLE_PROJECT_nexusUsername", "ORG_GRADLE_PROJECT_nexusPassword"] as const;

const SETTINGS_ARG = ".mvn/settings.xml";
const ENV_REFERENCE = /^\$\{env\.[A-Za-z_][A-Za-z0-9_]*\}$/;
const SECRET_ELEMENTS = new Set(["password", "passphrase", "privateKey"]);

/** `.mvn/settings.xml` as devguard generates it: one mirror of everything, plus a `<server>` when auth is env. */
export function mavenSettingsXml(mirrors: MirrorSettings): string {
  const [user, password] = MAVEN_AUTH_VARIABLES;
  const servers =
    mirrors.auth === "env"
      ? `  <servers>
    <server>
      <id>${MAVEN_MIRROR_ID}</id>
      <username>\${env.${user}}</username>
      <password>\${env.${password}}</password>
    </server>
  </servers>
`
      : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
          xsi:schemaLocation="http://maven.apache.org/SETTINGS/1.2.0 https://maven.apache.org/xsd/settings-1.2.0.xsd">
  <mirrors>
    <mirror>
      <id>${MAVEN_MIRROR_ID}</id>
      <mirrorOf>*</mirrorOf>
      <url>${mirrors.maven}</url>
    </mirror>
  </mirrors>
${servers}</settings>
`;
}

const text = (el: XmlEl | undefined): string => el?.text ?? "";

const REGENERATE = "devguard fix 會重新產生";

/** The `mirrorOf *` mirror must be the Maven mirror; every other `<url>` must stay on the mirror's host. */
function sourceProblems(root: XmlEl, file: string, mirrors: MirrorSettings): MirrorProblem[] {
  const problems: MirrorProblem[] = [];
  const all = descendants(root, "mirror").find((m) => text(child(m, "mirrorOf")).split(",").includes("*"));
  const allUrl = all && child(all, "url");
  if (!all) {
    const message = `${file} 沒有代理所有來源（mirrorOf *）的 mirror`;
    problems.push({ rule: "missing", message, detail: REGENERATE });
  } else if (!sameUrl(text(allUrl), mirrors.maven)) {
    const message = `${file} 的 mirror 指向 ${redact(text(allUrl))}，不是內部鏡像`;
    problems.push({ rule: "external", message, detail: REGENERATE, line: all.line });
  }
  for (const url of descendants(root, "url").filter((u) => u !== allUrl && !internal(u.text, mirrors.maven))) {
    const message = `${file} 指向外部來源 ${redact(url.text)}`;
    problems.push({ rule: "external", message, detail: REGENERATE, line: url.line });
  }
  return problems;
}

/** Passwords and passphrases must be `${env.*}` references; the value itself is never printed. */
function secretProblems(root: XmlEl, file: string): MirrorProblem[] {
  const secrets = descendants(root).filter((e) => SECRET_ELEMENTS.has(e.name) && !ENV_REFERENCE.test(e.text));
  return secrets.map((secret) => ({
    rule: "plaintext-credentials",
    message: `${file} 第 ${String(secret.line)} 行的 <${secret.name}> 直接寫入了帳密；帳密不得進 repo`,
    detail: `${REGENERATE}，並更換已外洩的帳密`,
    line: secret.line,
  }));
}

/** With `mirrors.auth: env`, a `<server>` shares the mirror's id (SPEC §10.3). */
function authProblems(root: XmlEl, file: string, mirrors: MirrorSettings): MirrorProblem[] {
  const all = descendants(root, "mirror").find((m) => text(child(m, "mirrorOf")).split(",").includes("*"));
  if (mirrors.auth !== "env" || !all) return [];
  const mirrorId = text(child(all, "id"));
  if (descendants(root, "server").some((s) => text(child(s, "id")) === mirrorId)) return [];
  const message = `mirrors.auth 為 env，但 ${file} 沒有 id 為 ${mirrorId} 的 <server>`;
  return [{ rule: "auth-missing", message, detail: `${REGENERATE}（帳密來自 ${MAVEN_AUTH_VARIABLES.join(" / ")}）` }];
}

function settingsProblems(xml: string | undefined, file: string, mirrors: MirrorSettings): MirrorProblem[] {
  if (xml === undefined) {
    return [{ rule: "missing", message: `找不到 ${file}`, detail: `建立 ${file}（${REGENERATE}）` }];
  }
  const parsed = parseXmlText(xml);
  if (!parsed.ok) {
    return [{ rule: "missing", message: `${file} 無法解析：${parsed.message}`, detail: REGENERATE, line: parsed.line }];
  }
  return [
    ...sourceProblems(parsed.root, file, mirrors),
    ...secretProblems(parsed.root, file),
    ...authProblems(parsed.root, file, mirrors),
  ];
}

/** The lines of `.mvn/maven.config`, without any `--settings` / `-s` already there. */
function otherArgs(config: string): string[] {
  return config.split(/\r?\n/).flatMap((line) => {
    const args = line.split(/\s+/).filter((a) => a !== "");
    const kept: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] ?? "";
      if (arg === "-s" || arg === "--settings") i++;
      else if (!/^(-s|--settings=)/.test(arg)) kept.push(arg);
    }
    return kept.length > 0 ? [kept.join(" ")] : [];
  });
}

function usesSettings(config: string): boolean {
  const args = config.split(/\s+/).map((a) => a.replace(/^\.\//, ""));
  return args.some((a, i) => (a === "-s" || a === "--settings") && args[i + 1]?.replace(/^\.\//, "") === SETTINGS_ARG);
}

async function checkMaven(component: MirrorComponent, mirrors: MirrorSettings, read: ReadFile) {
  const settingsFile = `${component.dir}.mvn/settings.xml`;
  const configFile = `${component.dir}.mvn/maven.config`;
  const settings: Repair[] = [{ op: "generate", file: settingsFile, content: mavenSettingsXml(mirrors) }];
  const findings = settingsProblems(await read(settingsFile), settingsFile, mirrors).map((p) =>
    mirrorFinding(component, settingsFile, { ...p, repairs: settings }),
  );
  const config = (await read(configFile)) ?? "";
  if (!usesSettings(config)) {
    const content = [...otherArgs(config), `--settings ${SETTINGS_ARG}`].join("\n") + "\n";
    findings.push(
      mirrorFinding(component, configFile, {
        rule: "missing",
        message: `${configFile} 沒有 --settings ${SETTINGS_ARG}，Maven 不會使用內部鏡像`,
        detail: `在 ${configFile} 加上 --settings ${SETTINGS_ARG}`,
        repairs: [{ op: "generate", file: configFile, content }],
      }),
    );
  }
  return findings;
}

/** `settings.gradle` / `.kts` repositories as a person should paste them (build scripts are never written, §9.2). */
export function gradleSnippet(mirrors: MirrorSettings, kotlin: boolean): string {
  const credentials =
    mirrors.auth === "env"
      ? `\n            credentials(${kotlin ? "PasswordCredentials::class" : "PasswordCredentials"})`
      : "";
  const repo = `        maven {
            name = "${MAVEN_MIRROR_ID}"
            url = uri("${mirrors.maven}")${credentials}
        }`;
  return `pluginManagement {
    repositories {
${repo}
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
${repo}
    }
}`;
}

/** Repositories Gradle knows by name, all outside the company. */
const BUILT_IN_REPOSITORIES = /\b(mavenCentral|google|jcenter|gradlePluginPortal)\s*\(/;
const URL_LITERAL = /https?:\/\/[^\s"')]+/g;

function externalLines(file: string, script: string, mirror: string): MirrorProblem[] {
  return script.split(/\r?\n/).flatMap((line, i) => {
    const urls = [...line.matchAll(URL_LITERAL)].map((m) => m[0]).filter((u) => !internal(u, mirror));
    const named = BUILT_IN_REPOSITORIES.exec(line)?.[1];
    const source = named ? `${named}()` : urls[0] && redact(urls[0]);
    if (!source || line.trim().startsWith("//")) return [];
    const message = `${file} 第 ${String(i + 1)} 行的 repository 指向外部來源 ${source}`;
    return [{ rule: "external", message, detail: "移除該 repository，改用內部鏡像", line: i + 1 } as const];
  });
}

async function checkGradle(component: MirrorComponent, mirrors: MirrorSettings, read: ReadFile) {
  const kotlin = (await read(`${component.dir}build.gradle.kts`)) !== undefined;
  const names = ["settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts"];
  const scripts = new Map<string, string>();
  for (const name of names) {
    const content = await read(component.dir + name);
    if (content !== undefined) scripts.set(component.dir + name, content);
  }
  const findings = [...scripts].flatMap(([file, script]) =>
    externalLines(file, script, mirrors.maven).map((p) => mirrorFinding(component, file, p)),
  );
  const settingsFile =
    [...scripts.keys()].find((f) => /settings\.gradle(\.kts)?$/.test(f)) ??
    `${component.dir}settings.gradle${kotlin ? ".kts" : ""}`;
  const settings = scripts.get(settingsFile) ?? "";
  const url = mirrors.maven.replace(/\/+$/, "");
  if (!settings.includes("dependencyResolutionManagement") || !settings.includes(url)) {
    const snippet = gradleSnippet(mirrors, settingsFile.endsWith(".kts"));
    findings.push(
      mirrorFinding(component, settingsFile, {
        rule: "missing",
        message: `${settingsFile} 的 dependencyResolutionManagement 沒有使用內部鏡像 ${mirrors.maven}`,
        detail: `在 ${settingsFile} 加上 repositories 片段`,
        repairs: [{ op: "snippet", file: settingsFile, text: snippet }],
      }),
    );
  }
  return findings;
}

/** Maven when the component has a pom.xml, Gradle when it has a Gradle script, otherwise what the declaration says. */
export async function isGradle(component: MirrorComponent, read: ReadFile): Promise<boolean> {
  if ((await read(`${component.dir}pom.xml`)) !== undefined) return false;
  for (const name of ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"]) {
    if ((await read(component.dir + name)) !== undefined) return true;
  }
  return component.effective["build.tool"]?.value === "gradle";
}

/** Java: Maven's CLI-owned `.mvn/` files, or Gradle's repositories printed as a snippet (SPEC §10.2). */
export const checkJava: MirrorChecker = async (component, mirrors, read) =>
  (await isGradle(component, read)) ? checkGradle(component, mirrors, read) : checkMaven(component, mirrors, read);
