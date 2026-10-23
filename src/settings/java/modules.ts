import { normalizeDir } from "../../declaration/path.ts";
import { child, descendants, parseXmlText } from "../../xml/parse.ts";

/** Reads a repo-relative file; undefined when it does not exist. */
export type ReadText = (repoPath: string) => Promise<string | undefined>;

const MAX_DEPTH = 8;

/** A pom.xml's `<modules>` and whether it only aggregates them (`<packaging>pom</packaging>`). */
async function readPom(read: ReadText, dir: string): Promise<{ modules: string[]; aggregator: boolean } | undefined> {
  const text = await read(`${dir}pom.xml`);
  const parsed = text === undefined ? undefined : parseXmlText(text);
  if (!parsed?.ok) return undefined;
  const modules = descendants(parsed.root, "module")
    .map((m) => m.text.trim())
    .filter((m) => m !== "");
  return { modules, aggregator: child(parsed.root, "packaging")?.text.trim() === "pom" };
}

/**
 * The directories of a Maven build that write their own `target/` reports: the build in `dir` itself, or, for an
 * aggregator (`<packaging>pom</packaging>` with `<modules>`), each of its modules, recursively. Normalized
 * repo-relative directories ("" or ending in "/"). A module whose pom.xml is missing is left out.
 */
export async function mavenReportDirs(read: ReadText, dir: string, depth = 0): Promise<string[]> {
  const pom = await readPom(read, dir);
  if (!pom || pom.modules.length === 0 || depth > MAX_DEPTH) return [dir];
  const { modules } = pom;
  const own = pom.aggregator ? [] : [dir];
  const nested: string[] = [];
  for (const module of modules) {
    const moduleDir = normalizeDir(`${dir}${module}`);
    if ((await read(`${moduleDir}pom.xml`)) !== undefined)
      nested.push(...(await mavenReportDirs(read, moduleDir, depth + 1)));
  }
  return [...own, ...nested];
}
