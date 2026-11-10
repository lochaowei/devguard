import { fixText } from "../../fix/category.ts";
import type { Repair } from "../../fix/repair.ts";
import type { Finding } from "../../report/finding.ts";
import { upwards } from "../../repo/paths.ts";
import { child, descendants, parseXmlText, type XmlEl } from "../../xml/parse.ts";
import { componentBuildTool, GRADLE_FILES, type BuildTool } from "./build.ts";
import { finding, findConfig, type JavaTarget } from "./common.ts";
import type { ReadText } from "./modules.ts";
import { PMD_FILES } from "./pmd.ts";

/** The build plugins devguard runs its Java tools through (JaCoCo: the tests check, #99). */
export type JavaPlugin = "spotless" | "pmd" | "jacoco";

interface PluginNames {
  label: string;
  /** The Maven plugin's artifactId. */
  maven: string;
  /** The Gradle plugin id. */
  gradle: string;
}

export const JAVA_PLUGINS: Readonly<Record<JavaPlugin, PluginNames>> = {
  spotless: { label: "Spotless", maven: "spotless-maven-plugin", gradle: "com.diffplug.spotless" },
  pmd: { label: "PMD", maven: "maven-pmd-plugin", gradle: "pmd" },
  jacoco: { label: "JaCoCo", maven: "jacoco-maven-plugin", gradle: "jacoco" },
};

/** One build file whose plugins apply to the component. */
export interface BuildFile {
  path: string;
  /** The directory it is in: "" or ending in "/". */
  dir: string;
  text: string;
  /** A pom.xml's parsed root element. */
  xml?: XmlEl;
}

/** A `<plugin>` of a pom.xml, from `<build><plugins>` or `<build><pluginManagement><plugins>`. */
export interface MavenPlugin {
  artifactId: string;
  configuration?: XmlEl;
  pom: BuildFile;
}

/**
 * Whether the build applies a plugin. "unknown" when it may come from where devguard cannot read it: a parent POM
 * outside the repo or a Maven profile; a Gradle convention plugin (buildSrc, an included build), an `apply from`
 * script, a parent Gradle build, or a root build that declares it `apply false` for its subprojects.
 */
export type Applied = "yes" | "no" | "unknown";

/** The plugins a Java component's build applies, read from its build files (SPEC §6.4). */
export interface BuildPlugins {
  tool: BuildTool;
  /** The component's own build file first, then its parent POMs or parent Gradle builds. */
  files: BuildFile[];
  applied(plugin: JavaPlugin): Applied;
  /** Maven only: every declaration of the plugin, nearest pom first. */
  maven(plugin: JavaPlugin): MavenPlugin[];
}

/** A repo path with `.` and `..` segments resolved; undefined when it climbs above the repo root. */
function normalizePath(path: string): string | undefined {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") {
      if (out.pop() === undefined) return undefined;
    } else if (part !== "." && part !== "") out.push(part);
  }
  return out.join("/");
}

const dirOf = (path: string): string => path.slice(0, path.lastIndexOf("/") + 1);

const MAX_PARENTS = 8;

async function readPom(read: ReadText, path: string): Promise<BuildFile | undefined> {
  const text = await read(path);
  const parsed = text === undefined ? undefined : parseXmlText(text);
  return text !== undefined && parsed?.ok ? { path, dir: dirOf(path), text, xml: parsed.root } : undefined;
}

/**
 * The component's pom.xml and its parents in the repo, followed through `<parent><relativePath>` (default
 * `../pom.xml`); `external` when a parent is not in the repo. Undefined when the component's pom is missing or broken.
 */
async function readPoms(read: ReadText, dir: string): Promise<{ files: BuildFile[]; external: boolean } | undefined> {
  const own = await readPom(read, `${dir}pom.xml`);
  if (!own) return undefined;
  const files = [own];
  for (let current = own; files.length <= MAX_PARENTS;) {
    const parent = current.xml && child(current.xml, "parent");
    if (!parent) return { files, external: false };
    const path = parentPath(current, parent);
    const next = path === undefined || files.some((f) => f.path === path) ? undefined : await readPom(read, path);
    if (!next) return { files, external: true };
    files.push(next);
    current = next;
  }
  return { files, external: true };
}

/** Where a `<parent>` is looked for: `<relativePath>`, `../pom.xml` by default; undefined when it is not in the repo. */
function parentPath(pom: BuildFile, parent: XmlEl): string | undefined {
  const relative = child(parent, "relativePath")?.text.trim() ?? "../pom.xml";
  if (relative === "") return undefined;
  return normalizePath(pom.dir + (relative.endsWith(".xml") ? relative : `${relative.replace(/\/$/, "")}/pom.xml`));
}

function pomPlugins(pom: BuildFile): MavenPlugin[] {
  const builds = pom.xml?.children.filter((c) => c.name === "build") ?? [];
  const lists = builds.flatMap((b) => {
    const management = child(b, "pluginManagement");
    return [child(b, "plugins"), management && child(management, "plugins")];
  });
  return lists
    .flatMap((l) => l?.children.filter((p) => p.name === "plugin") ?? [])
    .map((p) => ({
      artifactId: child(p, "artifactId")?.text.trim() ?? "",
      configuration: child(p, "configuration"),
      pom,
    }));
}

/** A pom.xml declares the plugin under `<profiles>`, which may or may not be active. */
const inProfiles = (pom: BuildFile, artifactId: string): boolean =>
  (pom.xml?.children.filter((c) => c.name === "profiles") ?? []).some((p) =>
    descendants(p, "plugin").some((plugin) => child(plugin, "artifactId")?.text.trim() === artifactId),
  );

async function mavenPlugins(read: ReadText, dir: string): Promise<BuildPlugins | undefined> {
  const poms = await readPoms(read, dir);
  if (!poms) return undefined;
  const declared = poms.files.flatMap(pomPlugins);
  const maven = (plugin: JavaPlugin) => declared.filter((p) => p.artifactId === JAVA_PLUGINS[plugin].maven);
  const applied = (plugin: JavaPlugin): Applied => {
    if (maven(plugin).length > 0) return "yes";
    const elsewhere = poms.external || poms.files.some((f) => inProfiles(f, JAVA_PLUGINS[plugin].maven));
    return elsewhere ? "unknown" : "no";
  };
  return { tool: "maven", files: poms.files, applied, maven };
}

/** Build script text without `//` and `/* *\/` comments; string literals (such as `"src/**\/*.java"`) are kept. */
export function withoutComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text.charAt(i);
    const end = c === '"' || c === "'" ? stringEnd(text, i) : commentEnd(text, i);
    if (end === undefined) {
      out += c;
      i++;
    } else {
      if (c === '"' || c === "'") out += text.slice(i, end);
      i = end;
    }
  }
  return out;
}

/** The index after the string literal opening at `start` (it ends at its quote, or at the end of the line). */
function stringEnd(text: string, start: number): number {
  const quote = text.charAt(start);
  let i = start + 1;
  while (i < text.length && text.charAt(i) !== quote && text.charAt(i) !== "\n") i += text.charAt(i) === "\\" ? 2 : 1;
  return Math.min(i + 1, text.length);
}

/** The index after the comment starting at `start`, if one does; a line comment keeps its newline. */
function commentEnd(text: string, start: number): number | undefined {
  const opener = text.slice(start, start + 2);
  const closer = opener === "//" ? "\n" : opener === "/*" ? "*/" : undefined;
  if (closer === undefined) return undefined;
  const end = text.indexOf(closer, start + 2);
  if (end === -1) return text.length;
  return closer === "\n" ? end : end + 2;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * How a Gradle build script names the plugin: `id("…")` / `id '…'`, `apply plugin: '…'` (Groovy) or
 * `apply(plugin = "…")` (Kotlin), a core plugin by its bare name in `plugins {}`, or a version-catalog alias whose
 * last name part is the tool's (`alias(libs.plugins.spotless)`). "declared" when every mention is `apply false`.
 */
function gradleMention(code: string, plugin: JavaPlugin): "applied" | "declared" | "absent" {
  const id = escape(JAVA_PLUGINS[plugin].gradle);
  const quoted = `["']${id}["']`;
  const patterns = [
    `\\bid\\s*\\(?\\s*${quoted}`,
    `\\bapply\\s*\\(?\\s*plugin\\s*[:=]\\s*${quoted}`,
    `\\balias\\s*\\(\\s*libs\\.plugins\\.(?:[\\w-]+\\.)*${plugin}\\s*\\)`,
    ...(plugin === "spotless" ? [] : [`\\bplugins\\s*\\{[^}]*?(?:^|[\\s;])\`?${id}\`?[ \\t]*(?=$|[;}])`]),
  ];
  const lines = patterns.flatMap((p) =>
    [...code.matchAll(new RegExp(p, "gim"))].map((m) => {
      const end = code.indexOf("\n", m.index + m[0].length);
      return code.slice(m.index, end === -1 ? undefined : end);
    }),
  );
  if (lines.length === 0) return "absent";
  return lines.every((l) => /\bapply\s*\(?\s*false\b/.test(l)) ? "declared" : "applied";
}

const GRADLE_SETTINGS = ["settings.gradle", "settings.gradle.kts"];

async function readAll(read: ReadText, paths: readonly string[]): Promise<BuildFile[]> {
  const files: BuildFile[] = [];
  for (const path of paths) {
    const text = await read(path);
    if (text !== undefined) files.push({ path, dir: dirOf(path), text });
  }
  return files;
}

/** The Gradle root project's directory: the nearest one at or above `dir` with a settings script. */
async function gradleRoot(read: ReadText, dir: string): Promise<{ dir: string; settings?: string }> {
  for (const d of upwards(dir)) {
    const [settings] = await readAll(
      read,
      GRADLE_SETTINGS.map((s) => d + s),
    );
    if (settings) return { dir: d, settings: settings.text };
  }
  return { dir };
}

async function gradlePlugins(read: ReadText, dir: string): Promise<BuildPlugins | undefined> {
  const own = await readAll(
    read,
    GRADLE_FILES.map((f) => dir + f),
  );
  if (own.length === 0) return undefined;
  const root = await gradleRoot(read, dir);
  const above = upwards(dir).slice(1, upwards(dir).indexOf(root.dir) + 1);
  const parents = await readAll(
    read,
    above.flatMap((d) => GRADLE_FILES.map((f) => d + f)),
  );
  const buildSrc = await readAll(
    read,
    GRADLE_FILES.map((f) => `${root.dir}buildSrc/${f}`),
  );
  const ownCode = own.map((f) => withoutComments(f.text)).join("\n");
  // Plugins applied from code devguard does not read: convention plugins and `apply from` scripts.
  const conventions =
    buildSrc.length > 0 ||
    /\bincludeBuild\b/.test(withoutComments(root.settings ?? "")) ||
    /\bapply\s*\(?\s*from\b/.test(ownCode);
  const applied = (plugin: JavaPlugin): Applied => {
    const mention = gradleMention(ownCode, plugin);
    if (mention === "applied") return "yes";
    const inParent = parents.some((f) => gradleMention(withoutComments(f.text), plugin) !== "absent");
    return mention === "declared" || inParent || conventions ? "unknown" : "no";
  };
  return { tool: "gradle", files: [...own, ...parents], applied, maven: () => [] };
}

/**
 * The plugins of the component in `dir` built with `tool`, read from its build file and its parents (a multi-module
 * root pom, a parent Gradle build). Undefined when the component has no build file, or a pom.xml that does not parse.
 */
export function readBuildPlugins(read: ReadText, dir: string, tool: BuildTool): Promise<BuildPlugins | undefined> {
  return tool === "maven" ? mavenPlugins(read, dir) : gradlePlugins(read, dir);
}

/** The lower bound of the declared `tools.<name>` range, as a full version ("2.44" → "2.44.0"). */
function minVersion(t: JavaTarget, tool: string): string | undefined {
  const key = `tools.${tool}`;
  const range = t.component.effective[key]?.value ?? t.defs[key]?.value;
  const bound = typeof range === "string" ? /^>=\s*(\d+(?:\.\d+)*)/.exec(range)?.[1] : undefined;
  if (bound === undefined) return undefined;
  const parts = bound.split(".");
  while (parts.length < 3) parts.push("0");
  return parts.join(".");
}

/** The plugins the settings check asks for. */
const CHECKED_PLUGINS = ["spotless", "pmd"] as const;
type CheckedPlugin = (typeof CHECKED_PLUGINS)[number];
/** The plugins devguard points at a config file it owns. */
type ConfiguredPlugin = Exclude<CheckedPlugin, "spotless">;
const CONFIGURED_PLUGINS: readonly ConfiguredPlugin[] = ["pmd"];

/** The repo path of the config devguard checks for the tool: the one found, or where `fix` generates it. */
function configFile(t: JavaTarget): string {
  return findConfig(t, PMD_FILES) ?? t.component.dir + PMD_FILES[0];
}

/** `path` relative to the directory `from` (both repo-relative, `from` normalized). */
function relativeTo(from: string, path: string): string {
  const up = from === "" ? [] : from.slice(0, -1).split("/");
  const parts = path.split("/");
  let common = 0;
  while (common < up.length && common < parts.length - 1 && up[common] === parts[common]) common++;
  return [...up.slice(common).map(() => ".."), ...parts.slice(common)].join("/");
}

/** The directory Maven's `${maven.multiModuleProjectDirectory}` points to: the nearest one above with `.mvn/`. */
function mavenRoot(t: JavaTarget): string {
  const dirs = upwards(t.component.dir);
  return dirs.find((d) => [...t.files].some((f) => f.startsWith(`${d}.mvn/`))) ?? t.component.dir;
}

const mavenConfigPath = (t: JavaTarget, file: string): string =>
  `\${maven.multiModuleProjectDirectory}/${relativeTo(mavenRoot(t), file)}`;

/** The `<configuration>` elements that point a Maven plugin at devguard's config. */
function mavenConfigXml(t: JavaTarget): string[] {
  const path = mavenConfigPath(t, configFile(t));
  return ["<rulesets>", `  <ruleset>${path}</ruleset>`, "</rulesets>"];
}

/** The settings that point a Gradle plugin at devguard's config, indented for its extension block. */
function gradleConfigLines(t: JavaTarget, kotlin: boolean): string[] {
  const path = relativeTo(t.component.dir, configFile(t));
  return [`    ruleSetFiles = files("${path}")`, `    ruleSets = ${kotlin ? "listOf()" : "[]"}`];
}

const indent = (lines: readonly string[], by: string): string[] => lines.map((l) => by + l);

function mavenPluginXml(t: JavaTarget, plugin: CheckedPlugin): string[] {
  const { maven } = JAVA_PLUGINS[plugin];
  const group = plugin === "spotless" ? "com.diffplug.spotless" : "org.apache.maven.plugins";
  const version = minVersion(t, maven);
  const configuration = plugin === "spotless" ? ["<java>", "  <palantirJavaFormat/>", "</java>"] : mavenConfigXml(t);
  return [
    "<plugin>",
    `  <groupId>${group}</groupId>`,
    `  <artifactId>${maven}</artifactId>`,
    ...(version ? [`  <version>${version}</version>`] : []),
    "  <configuration>",
    ...indent(configuration, "    "),
    "  </configuration>",
    "</plugin>",
  ];
}

function gradlePluginLines(t: JavaTarget, plugin: CheckedPlugin, kotlin: boolean): string[] {
  if (plugin === "spotless") {
    const version = minVersion(t, "spotless-gradle-plugin");
    return [
      "plugins {",
      `    id("com.diffplug.spotless")${version ? ` version "${version}"` : ""}`,
      "}",
      "spotless {",
      "    java {",
      "        palantirJavaFormat()",
      "    }",
      "}",
    ];
  }
  const version = minVersion(t, plugin);
  return [
    "plugins {",
    `    id("${plugin}")`,
    "}",
    `${plugin} {`,
    ...(version ? [`    toolVersion = "${version}"`] : []),
    ...gradleConfigLines(t, kotlin),
    "}",
  ];
}

/** Why devguard needs the plugin, per tool. */
const NEEDED_FOR: Record<CheckedPlugin, string> = {
  spotless: "無法檢查格式",
  pmd: "無法執行 PMD",
};

function snippetFinding(t: JavaTarget, rule: string, file: string, message: string, text: string): Finding {
  const repairs: Repair[] = [{ op: "snippet", file, text }];
  return finding(t, "error", rule, message, {
    file,
    fix: fixText(`在 ${file} 加入片段`, repairs),
    repairs,
  });
}

/**
 * A config location from a build file as a repo path. `roots` maps the variables a location may start with to their
 * directory; one without is relative to the component, where the build runs (an inherited Maven `<configLocation>` and
 * a Gradle `file()` resolve per module). Undefined when it depends on anything else; a URL or an absolute path comes
 * back as it is, and so never matches a repo file.
 */
function resolveLocation(location: string, base: string, roots: Readonly<Record<string, string>>): string | undefined {
  let value = location.trim().replace(/\\/g, "/");
  let dir = base;
  const variable = /^\$\{?([\w.]+)\}?(?:\/|$)/.exec(value);
  if (variable) {
    const root = roots[variable[1] ?? ""];
    if (root === undefined) return undefined;
    dir = root;
    value = value.slice(variable[0].length);
  }
  if (value.includes("$")) return undefined;
  if (/^([a-z][\w+.-]*:|\/)/i.test(value)) return value;
  return normalizePath(dir + value) ?? value;
}

type Pointing = "yes" | "no" | "unknown";

/** Whether any of the locations is `expected`; "unknown" when one of them cannot be resolved. */
function pointsAt(
  locations: readonly string[],
  base: string,
  roots: Readonly<Record<string, string>>,
  expected: string,
): Pointing {
  const resolved = locations.map((l) => resolveLocation(l, base, roots));
  if (resolved.includes(expected)) return "yes";
  return resolved.includes(undefined) ? "unknown" : "no";
}

/** Where Maven's PMD plugin reads its config: `<rulesets>`. */
function mavenLocations(plugins: BuildPlugins): string[] {
  return plugins.maven("pmd").flatMap(({ configuration }) => {
    if (!configuration) return [];
    return (child(configuration, "rulesets")?.children.filter((e) => e.name === "ruleset") ?? []).map((e) => e.text);
  });
}

/**
 * The string literals given to any of `settings` in the Gradle build scripts: `configFile = file("…")`,
 * `ruleSetFiles = files("…")` or Groovy's `ruleSetFiles file('…')`. `rootProject.file(…)` and `rootDir` are relative
 * to the root project.
 */
function gradleLocations(plugins: BuildPlugins, settings: readonly string[]): string[] {
  const assignment = new RegExp(`\\b(${settings.join("|")})\\b(?:\\s*\\.\\s*set\\b)?[ \\t]*[=(]?[ \\t]*([^\\n]*)`, "g");
  return plugins.files.flatMap((f) =>
    [...withoutComments(f.text).matchAll(assignment)].flatMap(([, , rest = ""]) => {
      const fromRoot = /\brootProject\b|\brootDir\b/.test(rest);
      return [...rest.matchAll(/["']([^"']+)["']/g)].map(
        ([, value = ""]) => `${fromRoot && !value.startsWith("$") ? "${rootDir}/" : ""}${value}`,
      );
    }),
  );
}

/** The Gradle root project's directory, from the committed files. */
function committedGradleRoot(t: JavaTarget): string {
  return upwards(t.component.dir).find((d) => GRADLE_SETTINGS.some((s) => t.files.has(d + s))) ?? t.component.dir;
}

/**
 * Whether the plugin reads devguard's config, per the build files; "unknown" when devguard cannot tell.
 */
function configPointing(t: JavaTarget, plugins: BuildPlugins): Pointing {
  const expected = configFile(t);
  const base = t.component.dir;
  if (plugins.tool === "maven") {
    const roots = {
      "project.basedir": base,
      basedir: base,
      "maven.multiModuleProjectDirectory": mavenRoot(t),
      "session.executionRootDirectory": base,
    };
    return pointsAt(mavenLocations(plugins), base, roots, expected);
  }
  const rootDir = committedGradleRoot(t);
  const roots = {
    rootDir,
    "project.rootDir": rootDir,
    "rootProject.projectDir": rootDir,
    projectDir: base,
    "project.projectDir": base,
  };
  return pointsAt(gradleLocations(plugins, ["ruleSetFiles", "ruleSetConfig"]), base, roots, expected);
}

/** What the plugin does when it is not pointed at devguard's config; `{file}` is that config. */
const NOT_POINTED: Record<BuildTool, Record<ConfiguredPlugin, string>> = {
  maven: {
    pmd: "maven-pmd-plugin 的 rulesets 沒有指向 {file}：PMD 不會用 devguard 的規則集（沒有設定時用 plugin 的預設規則）",
  },
  gradle: {
    pmd: "pmd 沒有以 ruleSetFiles 指向 {file}：PMD 不會用 devguard 的規則集（沒有設定時用 Gradle 的預設規則）",
  },
};

function configFinding(t: JavaTarget, file: string, tool: BuildTool, plugin: ConfiguredPlugin, kotlin: boolean) {
  const message = `${file}：${NOT_POINTED[tool][plugin].replace("{file}", configFile(t))}`;
  const lines =
    tool === "maven"
      ? [`在 ${JAVA_PLUGINS[plugin].maven} 的 <configuration> 加上：`, ...mavenConfigXml(t)]
      : [`${plugin} {`, ...gradleConfigLines(t, kotlin), "}"];
  return snippetFinding(t, "settings/java-plugin-config", file, message, lines.join("\n"));
}

/**
 * The build must apply Spotless and PMD, the plugins the code check runs (SPEC §6.4, #98); a plugin in a
 * parent POM in the repo counts. PMD must read devguard's config files. Build files are only printed a
 * snippet (§9.2). Nothing is reported when devguard cannot tell (`Applied` "unknown", an unresolvable location).
 */
export async function checkBuildPlugins(t: JavaTarget): Promise<Finding[]> {
  const tool = await componentBuildTool(t.component, (p) => t.files.has(p));
  const read = async (p: string) => (t.files.has(p) ? t.read(p) : undefined);
  const plugins = await readBuildPlugins(read, t.component.dir, tool);
  const own = plugins?.files[0];
  if (!plugins || !own) return [];
  const kotlin = own.path.endsWith(".kts");
  const missing = CHECKED_PLUGINS.filter((p) => plugins.applied(p) === "no").map((plugin) =>
    missingFinding(t, own.path, tool, plugin, kotlin),
  );
  const misconfigured = CONFIGURED_PLUGINS.filter(
    (p) => plugins.applied(p) === "yes" && configPointing(t, plugins) === "no",
  ).map((plugin) => {
    const file = tool === "maven" ? (plugins.maven(plugin)[0]?.pom ?? own).path : own.path;
    return configFinding(t, file, tool, plugin, kotlin);
  });
  return [...missing, ...misconfigured];
}

function missingFinding(t: JavaTarget, file: string, tool: BuildTool, plugin: CheckedPlugin, kotlin: boolean) {
  const names = JAVA_PLUGINS[plugin];
  const id = tool === "maven" ? names.maven : names.gradle;
  const lines =
    tool === "maven"
      ? ["加在 <build><plugins> 底下：", ...mavenPluginXml(t, plugin)]
      : gradlePluginLines(t, plugin, kotlin);
  const message = `${file} 沒有套用 ${names.label} plugin（${id}），devguard ${NEEDED_FOR[plugin]}`;
  return snippetFinding(t, "settings/java-plugin-missing", file, message, lines.join("\n"));
}
