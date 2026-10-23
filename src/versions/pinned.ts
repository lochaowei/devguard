import type { Language } from "../standard/types.ts";
import { parseConfigText } from "../fix/edit.ts";
import { upwards } from "../repo/paths.ts";
import { isRecord } from "../shared/guards.ts";
import { child, descendants, parseXmlText } from "../xml/parse.ts";

/**
 * Exact versions a component pins through its own dependency manager (SPEC §5.2). Lockfiles and pom.xml are read with
 * the same TOML / XML parsers as the settings checks; go.mod and Gradle scripts (not TOML / XML) by line.
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
  const doc = parseConfigText("x.lock.toml", text);
  const packages = isRecord(doc) && Array.isArray(doc.package) ? doc.package : [];
  return new Map(
    packages.flatMap((p): [string, string][] =>
      isRecord(p) && typeof p.name === "string" && typeof p.version === "string" ? [[p.name, p.version]] : [],
    ),
  );
}

function python(dir: string, read: ReadRepoFile): Pinned | undefined {
  for (const name of ["uv.lock", "poetry.lock"]) {
    const file = dir + name;
    const text = read(file);
    if (text !== undefined) return { file, versions: readPackageTables(text) };
  }
  return undefined;
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

function typescript(dir: string, read: ReadRepoFile): Pinned | undefined {
  for (const base of upwards(dir)) {
    const file = base + "package-lock.json";
    const text = read(file);
    if (text !== undefined) return { file, versions: readNpmLock(text, dir.slice(base.length)) };
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

/** `<plugin>` artifactId → version in a pom.xml; `${property}` versions resolve from the POM's `<properties>`. */
export function readMavenPlugins(text: string): Map<string, string> {
  const parsed = parseXmlText(text);
  if (!parsed.ok) return new Map();
  const properties = new Map((child(parsed.root, "properties")?.children ?? []).map((e) => [e.name, e.text.trim()]));
  const versions = new Map<string, string>();
  for (const plugin of descendants(parsed.root, "plugin")) {
    const artifact = child(plugin, "artifactId")?.text.trim();
    const version = child(plugin, "version")
      ?.text.trim()
      .replace(/^\$\{([^}]+)\}$/, (whole, key: string) => properties.get(key) ?? whole);
    if (artifact && version && !version.startsWith("${")) versions.set(artifact, version);
  }
  return versions;
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
