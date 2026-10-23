import type { Language } from "../standard/types.ts";
import { parseConfigText } from "../fix/edit.ts";
import { isRecord } from "../shared/guards.ts";
import { child, descendants, parseXmlText } from "../xml/parse.ts";

/** A direct dependency as written in a manifest. */
export interface Dependency {
  /** Python/npm package name, Go module path, or Maven `groupId:artifactId`. */
  name: string;
  /** Repo-relative manifest path. */
  file: string;
  line: number;
}

type Read = (path: string) => Promise<string | undefined>;

/** PEP 503 normalized name. */
const pyName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

const PY_REQ = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The name a PEP 508 requirement string starts with. */
const requirementName = (spec: unknown): string[] => {
  const name = typeof spec === "string" ? PY_REQ.exec(spec)?.[1] : undefined;
  return name ? [name] : [];
};

const requirementList = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(requirementName) : []);

/** Poetry dependency tables: the keys, except `python` itself. */
const poetryTable = (v: unknown): string[] => (isRecord(v) ? Object.keys(v).filter((k) => k !== "python") : []);

/** Direct dependency names in a parsed pyproject.toml, in file order of their tables. */
function pyprojectNames(doc: Record<string, unknown>): string[] {
  const project = isRecord(doc.project) ? doc.project : {};
  const optional = isRecord(project["optional-dependencies"]) ? project["optional-dependencies"] : {};
  const groups = isRecord(doc["dependency-groups"]) ? doc["dependency-groups"] : {};
  const tool = isRecord(doc.tool) ? doc.tool : {};
  const poetry = isRecord(tool.poetry) ? tool.poetry : {};
  const poetryGroups = isRecord(poetry.group) ? Object.values(poetry.group) : [];
  return [
    ...requirementList(project.dependencies),
    ...Object.values(optional).flatMap(requirementList),
    // Inline tables such as {include-group = "..."} are not dependencies.
    ...Object.values(groups).flatMap(requirementList),
    ...poetryTable(poetry.dependencies),
    ...poetryTable(poetry["dev-dependencies"]),
    ...poetryGroups.flatMap((g) => (isRecord(g) ? poetryTable(g.dependencies) : [])),
  ];
}

/**
 * Direct dependencies in pyproject.toml: `[project] dependencies`, optional dependencies, dependency groups and
 * Poetry dependency tables, read with the TOML parser `fix` uses. Each is located at the next line naming it.
 */
export function pyprojectDependencies(text: string, file: string): Dependency[] {
  const doc = parseConfigText("pyproject.toml", text);
  if (!isRecord(doc)) return [];
  const lines = text.split(/\r?\n/);
  const seen = new Map<string, number>();
  return pyprojectNames(doc).map((name) => {
    // A Poetry key (`name = ...`) or a requirement string, not a value such as {include-group = "name"}.
    const id = escapeRegExp(name);
    const named = new RegExp(`^\\s*(["']?)${id}\\1\\s*=|(?<!=\\s*)["']${id}(?![A-Za-z0-9_.-])`);
    const from = seen.get(name) ?? 0;
    const at = lines.findIndex((l, i) => i >= from && !l.trimStart().startsWith("#") && named.test(l));
    seen.set(name, at + 1);
    return { name, file, line: at + 1 };
  });
}

export function requirementsDependencies(text: string, file: string): Dependency[] {
  return text.split(/\r?\n/).flatMap((raw, i) => {
    const line = raw.trim();
    if (line.startsWith("-") || line.startsWith("#")) return [];
    const name = PY_REQ.exec(line)?.[1];
    return name ? [{ name, file, line: i + 1 }] : [];
  });
}

const NPM_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

export function packageJsonDependencies(text: string, file: string): Dependency[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof json !== "object" || json === null) return [];
  const lines = text.split(/\r?\n/);
  const record = json as Record<string, unknown>;
  return NPM_SECTIONS.flatMap((section) => {
    const deps = record[section];
    if (typeof deps !== "object" || deps === null) return [];
    return Object.keys(deps).map((name) => {
      const at = lines.findIndex((l) => l.includes(JSON.stringify(name)));
      return { name, file, line: at + 1 };
    });
  });
}

/** `require` directives in go.mod without `// indirect`. */
export function goModDependencies(text: string, file: string): Dependency[] {
  const deps: Dependency[] = [];
  let inBlock = false;
  text.split(/\r?\n/).forEach((raw, i) => {
    if (/\/\/\s*indirect\b/.test(raw)) return;
    const line = raw.replace(/\/\/.*$/, "").trim();
    let spec: string | undefined;
    if (inBlock) {
      if (line === ")") inBlock = false;
      else spec = line;
    } else if (/^require\s*\($/.test(line)) inBlock = true;
    else if (line.startsWith("require ")) spec = line.slice(8).trim();
    const name = spec?.split(/\s+/)[0];
    if (name) deps.push({ name: name.replace(/"/g, ""), file, line: i + 1 });
  });
  return deps;
}

/** `<dependency>` coordinates in a pom.xml, read with the XML parser the Java settings use. */
export function pomDependencies(text: string, file: string): Dependency[] {
  const parsed = parseXmlText(text);
  if (!parsed.ok) return [];
  return descendants(parsed.root, "dependency").flatMap((d) => {
    const group = child(d, "groupId")?.text.trim();
    const artifact = child(d, "artifactId")?.text.trim();
    return group && artifact ? [{ name: `${group}:${artifact}`, file, line: d.line }] : [];
  });
}

/** `"group:artifact[:version]"` coordinates in a Gradle build script. */
export function gradleDependencies(text: string, file: string): Dependency[] {
  return text.split(/\r?\n/).flatMap((raw, i) => {
    const line = raw.replace(/^\s*\/\/.*$/, "");
    return [...line.matchAll(/(["'])([\w.-]+):([\w.-]+)(?::[^"']*)?\1/g)].map((m) => ({
      name: `${m[2] ?? ""}:${m[3] ?? ""}`,
      file,
      line: i + 1,
    }));
  });
}

const READERS: Readonly<Record<Language, readonly [string, (text: string, file: string) => Dependency[]][]>> = {
  python: [
    ["pyproject.toml", pyprojectDependencies],
    ["requirements.txt", requirementsDependencies],
  ],
  typescript: [["package.json", packageJsonDependencies]],
  go: [["go.mod", goModDependencies]],
  java: [
    ["pom.xml", pomDependencies],
    ["build.gradle", gradleDependencies],
    ["build.gradle.kts", gradleDependencies],
  ],
};

/** The component's direct dependencies, from the manifests in its directory. */
export async function directDependencies(language: Language, dir: string, read: Read): Promise<Dependency[]> {
  const deps: Dependency[] = [];
  for (const [name, parse] of READERS[language]) {
    const file = dir + name;
    const text = await read(file);
    if (text !== undefined) deps.push(...parse(text, file));
  }
  return deps;
}

const DEPENDENCY_FILES = new Set([
  "pyproject.toml",
  "uv.lock",
  "poetry.lock",
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "go.mod",
  "go.sum",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.lockfile",
]);

/** A manifest or lockfile the dependency rules read; staging one makes the pre-commit hook run them (SPEC §7.1). */
export function isDependencyFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return DEPENDENCY_FILES.has(name) || /^requirements.*\.txt$/.test(name);
}

/** Whether `name` is the banned entry `banned` (Python names compare normalized; a Go entry covers its subpaths). */
export function isBanned(language: Language, name: string, banned: string): boolean {
  if (language === "python") return pyName(name) === pyName(banned);
  if (language === "go") return name === banned || name.startsWith(`${banned}/`);
  return name === banned;
}
