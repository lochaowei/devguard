import type { Language } from "../standard/types.ts";

/** A direct dependency as written in a manifest. */
export interface Dependency {
  /** Python/npm package name, Go module path, or Maven `groupId:artifactId`. */
  name: string;
  /** Repo-relative manifest path. */
  file: string;
  line: number;
}

type Read = (path: string) => Promise<string | undefined>;

/** `dir` and each of its parents up to the repo root: "a/b/" → ["a/b/", "a/", ""]. */
export function parentDirs(dir: string): string[] {
  const parts = dir.split("/").filter((p) => p !== "");
  return parts.map((_, i) => `${parts.slice(0, parts.length - i).join("/")}/`).concat("");
}

const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length;

/** PEP 503 normalized name. */
const pyName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

const PY_REQ = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/;
const POETRY_TABLE = /^tool\.poetry\.(dependencies|dev-dependencies|group\.[^.]+\.dependencies)$/;
const ARRAY_TABLES = new Set(["project.optional-dependencies", "dependency-groups"]);

/** Requirement strings in a TOML array fragment; inline tables (`{include-group = ...}`) are skipped. */
function requirementNames(fragment: string): string[] {
  const strings = [...fragment.replace(/\{[^}]*\}/g, "").matchAll(/"([^"]*)"|'([^']*)'/g)];
  return strings.flatMap((m) => PY_REQ.exec(m[1] ?? m[2] ?? "")?.[1] ?? []);
}

/**
 * Direct dependencies in pyproject.toml: `[project] dependencies`, optional dependencies, dependency groups and
 * Poetry dependency tables. A line-based reader, enough for these tables; not a TOML parser.
 */
export function pyprojectDependencies(text: string, file: string): Dependency[] {
  const state = { table: "", inArray: false };
  return text
    .split(/\r?\n/)
    .flatMap((raw, i) =>
      pyprojectLine(state, raw.replace(/\s#.*$|^#.*$/, "").trim()).map((name) => ({ name, file, line: i + 1 })),
    );
}

/** Dependency names on one pyproject.toml line; tracks the current table and open arrays in `state`. */
function pyprojectLine(state: { table: string; inArray: boolean }, line: string): string[] {
  if (state.inArray) {
    state.inArray = !line.includes("]");
    return requirementNames(line);
  }
  const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
  if (header) {
    state.table = (header[1] ?? "").replace(/"/g, "");
    return [];
  }
  const kv = /^("[^"]+"|'[^']+'|[\w.-]+)\s*=\s*(.*)$/.exec(line);
  return kv ? pyprojectEntry(state, (kv[1] ?? "").replace(/["']/g, ""), kv[2] ?? "") : [];
}

function pyprojectEntry(state: { table: string; inArray: boolean }, key: string, value: string): string[] {
  if (POETRY_TABLE.test(state.table)) return key === "python" ? [] : [key];
  const isArray = (state.table === "project" && key === "dependencies") || ARRAY_TABLES.has(state.table);
  if (!isArray || !value.startsWith("[")) return [];
  state.inArray = !value.includes("]");
  return requirementNames(value);
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

export function pomDependencies(text: string, file: string): Dependency[] {
  const xml = text.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ""));
  return [...xml.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)].flatMap((m) => {
    const body = m[1] ?? "";
    const group = /<groupId>\s*([^<\s]+)\s*<\/groupId>/.exec(body)?.[1];
    const artifact = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(body)?.[1];
    return group && artifact ? [{ name: `${group}:${artifact}`, file, line: lineAt(xml, m.index) }] : [];
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
