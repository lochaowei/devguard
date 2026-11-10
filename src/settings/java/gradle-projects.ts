import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { normalizeDir } from "../../declaration/path.ts";
import { GRADLE_FILES } from "./build.ts";
import type { ReadText } from "./modules.ts";
import { readBuildPlugins, withoutComments, type Applied, type JavaPlugin } from "./plugins.ts";

/** The names of the subdirectories of a repo-relative directory ("" is the repo root); empty when it cannot be read. */
export type ListDirs = (repoDir: string) => Promise<string[]>;

/** `ListDirs` over the working tree under `cwd`. */
export function listDirsIn(cwd: string): ListDirs {
  return async (repoDir) => {
    try {
      const entries = await readdir(join(cwd, repoDir), { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  };
}

const SETTINGS_FILES = ["settings.gradle", "settings.gradle.kts"];

/** Directories the fallback scan never enters: build output, caches, installed dependencies. */
const NOT_SCANNED = new Set([".git", ".gradle", "build", "node_modules", "buildSrc"]);

const MAX_SCAN_DEPTH = 6;

const literals = (list: string): string[] => [...list.matchAll(/["']([^"']*)["']/g)].map((m) => m[1] ?? "");

/** The project directories `settings.gradle(.kts)` names, or undefined when it names them in a way devguard cannot read. */
function settingsProjects(settings: string): string[] | undefined {
  const code = withoutComments(settings);
  // include ':a', ':b:c'   include(":a", ":b")   (a list may continue on the next line after a comma)
  const included = [...code.matchAll(/\binclude\s*\(?\s*((?:["'][^"']*["']\s*,\s*)*["'][^"']*["'])/g)].flatMap((m) =>
    literals(m[1] ?? ""),
  );
  const names = included.map((p) => p.replace(/^:/, "")).filter((p) => p !== "");
  // Every `include` call must have been read: `include(*names)` or `include(projectName)` cannot be.
  const calls = [...code.matchAll(/\binclude\b/g)].length;
  const read = [...code.matchAll(/\binclude\s*\(?\s*["']/g)].length;
  if (calls !== read) return undefined;
  const dirs = new Map(names.map((n) => [`:${n}`, n.split(":").join("/")]));
  // project(':x').projectDir = file('lib')   project(":x").projectDir = File(settingsDir, "lib")
  const moves = [...code.matchAll(/\bproject\s*\(\s*["']([^"']+)["']\s*\)\s*\.\s*projectDir\s*=\s*([^\n;]+)/g)];
  for (const m of moves) {
    const target =
      /^\s*(?:new\s+)?(?:file\s*\(\s*["']([^"']+)["']\s*\)|File\s*\(\s*settingsDir\s*,\s*["']([^"']+)["']\s*\))/.exec(
        m[2] ?? "",
      );
    const to = target?.[1] ?? target?.[2];
    if (to === undefined || to.split("/").includes("..")) return undefined;
    dirs.set(m[1] ?? "", to);
  }
  return [...dirs.values()];
}

async function hasBuildFile(read: ReadText, dir: string): Promise<boolean> {
  for (const f of [...GRADLE_FILES, ...SETTINGS_FILES]) if ((await read(dir + f)) !== undefined) return true;
  return false;
}

/** Every directory under `dir` with a build script, except sub-builds with a settings script of their own. */
async function scanned(read: ReadText, subdirs: ListDirs, dir: string, depth = 0): Promise<string[]> {
  if (depth >= MAX_SCAN_DEPTH) return [];
  const found: string[] = [];
  for (const name of await subdirs(dir)) {
    if (NOT_SCANNED.has(name)) continue;
    const sub = `${dir}${name}/`;
    let own = false;
    for (const s of SETTINGS_FILES) own ||= (await read(sub + s)) !== undefined;
    if (own) continue;
    for (const f of GRADLE_FILES) if ((await read(sub + f)) !== undefined) found.push(sub);
    found.push(...(await scanned(read, subdirs, sub, depth + 1)));
  }
  return [...new Set(found)];
}

/**
 * The directories of a Gradle build that write their own `build/` reports: the build in `dir` itself plus the
 * subprojects `settings.gradle(.kts)` includes, in the directory `include` implies or the one `projectDir` moves it to
 * (SPEC §4.1). When the settings script names them in a way devguard cannot read, every directory below `dir` with a
 * build script is taken instead, leaving out `build/`, `.gradle/` and builds with a settings script of their own.
 * Normalized repo-relative directories ("" or ending in "/"), `dir` first.
 */
export async function gradleReportDirs(read: ReadText, subdirs: ListDirs, dir: string): Promise<string[]> {
  let settings: string | undefined;
  for (const s of SETTINGS_FILES) settings ??= await read(dir + s);
  if (settings === undefined) return [dir];
  const named = settingsProjects(settings);
  const subprojects = named?.map((p) => normalizeDir(`${dir}${p}`)) ?? (await scanned(read, subdirs, dir));
  const dirs = new Set([dir, ...subprojects]);
  // A project the settings script names but whose directory holds no build script writes no reports.
  const existing: string[] = [];
  for (const d of dirs) if (d === dir || (await hasBuildFile(read, d))) existing.push(d);
  return existing;
}

/**
 * Whether any of the Gradle projects in `dirs` applies a plugin: "yes" if one does, else "unknown" if one may, else "no".
 * A multi-project build often applies JaCoCo or PMD only in its subprojects.
 */
export async function gradleApplied(read: ReadText, dirs: readonly string[], plugin: JavaPlugin): Promise<Applied> {
  const answers = (await Promise.all(dirs.map((d) => readBuildPlugins(read, d, "gradle"))))
    .filter((p) => p !== undefined)
    .map((p) => p.applied(plugin));
  if (answers.includes("yes")) return "yes";
  return answers.length === 0 || answers.includes("unknown") ? "unknown" : "no";
}
