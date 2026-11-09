import { dirname, extname, join, posix } from "node:path";
import { at, parseJsonc, searchDirs } from "../config-files.ts";
import { setAt, type SettingsJudge } from "../judge.ts";
import { readIfExists } from "../../shared/fs.ts";
import { isRecord } from "../../shared/guards.ts";

interface Loaded {
  options: Record<string, unknown>;
  /** Some `extends` base could not be read, so absent options may still be set there. */
  unresolved: boolean;
  /** Set for a solution-style tsconfig: the tsconfig files it references, relative to its directory. */
  references: string[] | undefined;
}

function parentDirs(dir: string): string[] {
  const dirs = [dir];
  for (let cur = dir; dirname(cur) !== cur; cur = dirname(cur)) dirs.push(dirname(cur));
  return dirs;
}

function candidates(fromDir: string, spec: string): string[] {
  const bases =
    spec.startsWith(".") || spec.startsWith("/")
      ? [join(fromDir, spec)]
      : parentDirs(fromDir).map((d) => join(d, "node_modules", spec));
  return bases.flatMap((base) =>
    extname(base) === ".json" ? [base] : [base, `${base}.json`, join(base, "tsconfig.json")],
  );
}

async function loadBase(fromDir: string, spec: string, depth: number): Promise<Loaded> {
  for (const path of candidates(fromDir, spec)) {
    const loaded = await load(path, depth + 1);
    if (loaded) return loaded;
  }
  return { options: {}, unresolved: true, references: undefined };
}

/** compilerOptions after following `extends` (later bases and the file itself win). Undefined when the file is missing. */
async function load(path: string, depth = 0): Promise<Loaded | undefined> {
  const text = depth > 10 ? undefined : await readIfExists(path);
  if (text === undefined) return undefined;
  const json = parseJsonc(text);
  if (!isRecord(json)) return { options: {}, unresolved: true, references: undefined };
  const ext = json.extends;
  const specs = typeof ext === "string" ? [ext] : Array.isArray(ext) ? ext.filter((s) => typeof s === "string") : [];
  let options: Record<string, unknown> = {};
  let unresolved = false;
  for (const spec of specs) {
    const base = await loadBase(dirname(path), spec, depth);
    options = { ...options, ...base.options };
    unresolved ||= base.unresolved;
  }
  const own = at(json, "compilerOptions");
  return { options: { ...options, ...(isRecord(own) ? own : {}) }, unresolved, references: solutionReferences(json) };
}

/**
 * The tsconfig files a solution-style tsconfig (`"files": []`, no `include`, and `references`) points to, relative to
 * its directory: a reference to a directory means its tsconfig.json. Undefined for any other tsconfig, which tsc
 * checks files with itself (#124).
 */
export function solutionReferences(json: unknown): string[] | undefined {
  if (!isRecord(json) || !Array.isArray(json.files) || json.files.length > 0 || "include" in json) return undefined;
  const refs = Array.isArray(json.references) ? json.references : [];
  const paths = refs.map((r) => at(r, "path")).filter((p): p is string => typeof p === "string");
  return paths.length > 0 ? paths.map(referencedFile) : undefined;
}

function referencedFile(written: string): string {
  const path = written.replace(/\\/g, "/");
  return posix.normalize(posix.extname(path) === ".json" ? path : posix.join(path, "tsconfig.json"));
}

interface Found {
  /** Repo-relative path. */
  file: string;
  fsPath: string;
  loaded: Loaded;
}

async function loadNearest(root: string, subDir: string): Promise<Found | undefined> {
  for (const { fsDir, relDir } of searchDirs(root, subDir)) {
    const fsPath = join(fsDir, "tsconfig.json");
    const loaded = await load(fsPath);
    if (loaded) return { file: `${relDir}tsconfig.json`, fsPath, loaded };
  }
  return undefined;
}

/** Which component directory a repo-relative file belongs to. */
export type OwnerOf = (file: string) => string;

/** `typecheck.strict` and `typecheck.options` against tsconfig.json (SPEC §6.3). */
export async function checkTsconfig(root: string, judge: SettingsJudge, ownerOf?: OwnerOf): Promise<void> {
  const found = await loadNearest(root, judge.dir);
  const wanted = judge.declared("typecheck.options");
  const extraOptions = Array.isArray(wanted) ? wanted.filter((o): o is string => typeof o === "string") : [];
  if (!found) {
    const file = judge.path("tsconfig.json");
    const strict = judge.declared("typecheck.strict");
    const repairs = [
      ...(strict === undefined ? [] : setAt(file, ["compilerOptions", "strict"])(strict)),
      ...extraOptions.flatMap((name) => setAt(file, ["compilerOptions", name])(true)),
    ];
    judge.missingFile(file, " tsconfig.json", repairs);
    return;
  }
  const owned = (file: string) => (ownerOf ? ownerOf(file) === judge.dir : true);
  await judgeEffective(judge, found, extraOptions, { owned, seen: new Set() });
}

/**
 * Judges a tsconfig, or for a solution-style one each tsconfig it references that belongs to this component: the
 * solution file itself checks no files, so its options do nothing (#124).
 */
async function judgeEffective(
  judge: SettingsJudge,
  found: Found,
  extraOptions: readonly string[],
  walk: { owned: (file: string) => boolean; seen: Set<string> },
): Promise<void> {
  const { references } = found.loaded;
  if (!references) {
    judgeOptions(judge, found.file, found.loaded, extraOptions);
    return;
  }
  walk.seen.add(found.file);
  for (const ref of references) {
    const file = posix.normalize(posix.join(posix.dirname(found.file), ref));
    if (walk.seen.has(file) || !walk.owned(file)) continue;
    const fsPath = join(dirname(found.fsPath), ref);
    const loaded = await load(fsPath);
    if (loaded) await judgeEffective(judge, { file, fsPath, loaded }, extraOptions, walk);
    else judge.unconfirmed(file, "（references 指向的檔案讀不到）tsconfig 的設定");
  }
}

function judgeOptions(judge: SettingsJudge, file: string, loaded: Loaded, extraOptions: readonly string[]): void {
  const { options, unresolved } = loaded;

  const check = (key: string, name: string, actual: unknown, run: () => void) => {
    if (actual === undefined && unresolved) judge.unconfirmed(file, `（extends 的來源讀不到）tsconfig 的 ${name}`);
    else run();
  };
  check("typecheck.strict", "strict", options.strict, () => {
    const repair = setAt(file, ["compilerOptions", "strict"]);
    judge.compare("typecheck.strict", options.strict === true, file, "tsconfig strict", repair);
  });
  for (const name of extraOptions) {
    check("typecheck.options", name, options[name], () => {
      const repair = setAt(file, ["compilerOptions", name], () => true);
      if (options[name] !== true) judge.disabled("typecheck.options", file, `tsconfig ${name}`, repair);
    });
  }
}
