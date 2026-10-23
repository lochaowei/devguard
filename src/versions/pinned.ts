import type { Language } from "../standard/types.ts";

/**
 * Exact versions a component pins through its own dependency manager (SPEC §5.2). Self-contained line readers:
 * they only pick out names and versions, and do not validate the files.
 */
export interface Pinned {
  /** Repo-relative path of the file the versions came from. */
  file: string;
  /** Package / module / plugin name → exact version, as named by that ecosystem. */
  versions: Map<string, string>;
}

/** Reads a repo-relative path; undefined when the file does not exist. */
export type ReadRepoFile = (path: string) => string | undefined;

/** `[[package]]` tables with `name` and `version` keys: uv.lock and poetry.lock. */
export function readPackageTables(text: string): Map<string, string> {
  const versions = new Map<string, string>();
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const field = (key: string) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m").exec(block)?.[1];
    const name = field("name");
    const version = field("version");
    if (name && version) versions.set(name, version);
  }
  return versions;
}

function python(dir: string, read: ReadRepoFile): Pinned | undefined {
  for (const name of ["uv.lock", "poetry.lock"]) {
    const file = dir + name;
    const text = read(file);
    if (text !== undefined) return { file, versions: readPackageTables(text) };
  }
  return undefined;
}

/** `dir` and each parent directory, nearest first: "a/b/" → ["a/b/", "a/", ""]. */
function ancestors(dir: string): string[] {
  const parts = dir.split("/").filter((p) => p !== "");
  return parts.map((_, i) => parts.slice(0, parts.length - i).join("/") + "/").concat("");
}

/**
 * Installed packages from an npm lockfile (v2/v3 `packages`), as seen from `sub` (the component directory relative
 * to the lockfile): a copy installed in `sub` wins over the hoisted one at the root.
 */
export function readNpmLock(text: string, sub = ""): Map<string, string> {
  const packages = npmPackages(text);
  return new Map([...installedIn(packages, ""), ...installedIn(packages, sub)]);
}

function npmPackages(text: string): Record<string, { version?: unknown }> {
  try {
    return (JSON.parse(text) as { packages?: Record<string, { version?: unknown }> }).packages ?? {};
  } catch {
    return {};
  }
}

/** Packages installed directly in `<dir>node_modules/`, not nested under another package. */
function installedIn(packages: Record<string, { version?: unknown }>, dir: string): [string, string][] {
  const prefix = `${dir}node_modules/`;
  return Object.entries(packages).flatMap(([path, { version }]): [string, string][] => {
    const name = path.startsWith(prefix) ? path.slice(prefix.length) : "";
    const direct = name !== "" && !name.includes("/node_modules/");
    return direct && typeof version === "string" ? [[name, version]] : [];
  });
}

const PNPM_PKG = /^  ['"]?\/?((?:@[^/'":\s]+\/)?[^@/'":\s]+)@(\d[^('":\s]*)/gm;
const YARN_ENTRY =
  /^["']?((?:@[^@/"',\s]+\/)?[^@/"',\s]+)@(?:npm:)?[^:\n]+:\r?\n\s+version(?::\s+|\s+)["']?([^\s"']+)/gm;

/** Installed packages from a `pnpm-lock.yaml` (v6–v9 `packages` / `snapshots` entries). */
export function readPnpmLock(text: string): Map<string, string> {
  const versions = new Map<string, string>();
  for (const [, name = "", version = ""] of text.matchAll(PNPM_PKG)) {
    if (name && version) versions.set(name, version);
  }
  return versions;
}

/** Installed packages from a `yarn.lock` (v1 classic and Berry). */
export function readYarnLock(text: string): Map<string, string> {
  const versions = new Map<string, string>();
  for (const [, name = "", version = ""] of text.matchAll(YARN_ENTRY)) {
    if (name && version) versions.set(name, version);
  }
  return versions;
}

function typescript(dir: string, read: ReadRepoFile): Pinned | undefined {
  for (const base of ancestors(dir)) {
    for (const name of ["package-lock.json", "npm-shrinkwrap.json"]) {
      const file = base + name;
      const text = read(file);
      if (text !== undefined) return { file, versions: readNpmLock(text, dir.slice(base.length)) };
    }
    for (const [name, reader] of [
      ["pnpm-lock.yaml", readPnpmLock],
      ["yarn.lock", readYarnLock],
    ] as const) {
      const file = base + name;
      const text = read(file);
      if (text !== undefined) return { file, versions: reader(text) };
    }
  }
  return undefined;
}

/** The arguments of each `verb` directive in go.mod, single-line and block form, comments stripped. */
function goDirectives(text: string, verb: string): string[][] {
  const found: string[][] = [];
  let inBlock = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (inBlock) {
      if (line === ")") inBlock = false;
      else if (line !== "") found.push(line.split(/\s+/));
    } else if (new RegExp(`^${verb}\\s*\\($`).test(line)) inBlock = true;
    else if (line.startsWith(`${verb} `)) found.push(line.slice(verb.length).trim().split(/\s+/));
  }
  return found;
}

/** Each `tool` in go.mod → the required version of the longest module path that contains it. */
export function readGoModTools(text: string): Map<string, string> {
  const required = goDirectives(text, "require").filter((r) => r.length >= 2);
  const versions = new Map<string, string>();
  for (const [tool] of goDirectives(text, "tool")) {
    if (!tool) continue;
    const owner = required
      .filter(([mod]) => mod === tool || tool.startsWith(`${mod ?? ""}/`))
      .sort((a, b) => (b[0] ?? "").length - (a[0] ?? "").length)[0];
    if (owner?.[1]) versions.set(tool, owner[1]);
  }
  return versions;
}

function go(dir: string, read: ReadRepoFile): Pinned | undefined {
  const file = dir + "go.mod";
  const text = read(file);
  return text === undefined ? undefined : { file, versions: readGoModTools(text) };
}

const tag = (xml: string, name: string): string | undefined =>
  new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(xml)?.[1];

/** `<plugin>` artifactId → version in a pom.xml; `${property}` versions resolve from `<properties>`. */
export function readMavenPlugins(text: string): Map<string, string> {
  const xml = text.replace(/<!--[\s\S]*?-->/g, "");
  const properties = mavenProperties(xml);
  const versions = new Map<string, string>();
  for (const [, body = ""] of xml.matchAll(/<plugin>([\s\S]*?)<\/plugin>/g)) {
    const own = body.replace(/<(dependencies|configuration|executions)>[\s\S]*?<\/\1>/g, "");
    const artifact = tag(own, "artifactId");
    const version = tag(own, "version")?.replace(
      /^\$\{([^}]+)\}$/,
      (whole, key: string) => properties.get(key) ?? whole,
    );
    if (artifact && version && !version.startsWith("${")) versions.set(artifact, version);
  }
  return versions;
}

function mavenProperties(xml: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const block of xml.match(/<properties>[\s\S]*?<\/properties>/g) ?? []) {
    for (const [, key = "", value = ""] of block.matchAll(/<([\w.-]+)>\s*([^<]*?)\s*<\/\1>/g))
      properties.set(key, value);
  }
  return properties;
}

const GRADLE_PLUGIN = /\bid\s*\(?\s*["']([^"']+)["']\s*\)?\s*version\s*\(?\s*["']([^"']+)["']/g;
const GRADLE_TOOL = /\b(checkstyle|pmd|jacoco|spotbugs)\s*\{[^}]*?\btoolVersion\b\s*=?\s*\(?\s*["']([^"']+)["']/g;

/** Plugin id → version from the `plugins {}` block, and `toolVersion` of checkstyle / pmd / jacoco / spotbugs. */
export function readGradleBuild(text: string): Map<string, string> {
  const versions = new Map<string, string>();
  for (const [, id = "", version = ""] of text.matchAll(GRADLE_PLUGIN)) versions.set(id, version);
  for (const [, tool = "", version = ""] of text.matchAll(GRADLE_TOOL)) versions.set(tool, version);
  return versions;
}

function java(dir: string, read: ReadRepoFile): Pinned | undefined {
  const readers: [string, (text: string) => Map<string, string>][] = [
    ["pom.xml", readMavenPlugins],
    ["build.gradle.kts", readGradleBuild],
    ["build.gradle", readGradleBuild],
  ];
  for (const [name, reader] of readers) {
    const file = dir + name;
    const text = read(file);
    if (text !== undefined) return { file, versions: reader(text) };
  }
  return undefined;
}

const READERS: Readonly<Record<Language, (dir: string, read: ReadRepoFile) => Pinned | undefined>> = {
  python,
  typescript,
  go,
  java,
};

/**
 * The versions pinned for the component in `dir` (normalized: "" or ending in "/"); undefined when the component
 * has no lockfile or build file to read them from.
 */
export function pinnedVersions(language: Language, dir: string, read: ReadRepoFile): Pinned | undefined {
  return READERS[language](dir, read);
}
