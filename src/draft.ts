import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Document, isNode, isSeq } from "yaml";
import { runCheck } from "./check.ts";
import { compareToDefault } from "./declaration/compare.ts";
import { withoutIgnored } from "./declaration/ignore.ts";
import { displayDir, normalizePath } from "./declaration/path.ts";
import { resolveDeclaration, type Resolution } from "./declaration/resolve.ts";
import { DECLARATION_FILE } from "./declaration/types.ts";
import { pythonSettingsLayer } from "./layers/settings-python.ts";
import { goSettingsLayer } from "./layers/settings-go.ts";
import { javaSettingsLayer } from "./layers/settings-java.ts";
import { typescriptSettingsLayer } from "./layers/settings-typescript.ts";
import type { CheckLayer } from "./layers/types.ts";
import type { Finding } from "./report/finding.ts";
import { listRepoFiles } from "./repo/files.ts";
import { goWorkspaces } from "./repo/go-work.ts";
import { defaultStandard } from "./standard/registry.ts";
import { EXTENSION_LANGUAGE, LANGUAGE_LABEL, LANGUAGES, type Language, type Standard } from "./standard/types.ts";
import { baseName, upwards } from "./repo/paths.ts";
import { typeCheckerConfigs, type TypeChecker } from "./settings/type-checkers.ts";
import { readIfExists } from "./shared/fs.ts";

/** The settings checks whose readers the draft reuses: their findings carry the values read from config files. */
const SETTINGS_LAYERS: readonly CheckLayer[] = [
  pythonSettingsLayer,
  goSettingsLayer,
  javaSettingsLayer,
  typescriptSettingsLayer,
];

/** Files that mark a directory as the root of a component of that language. */
const MARKERS: Readonly<Record<Language, readonly string[]>> = {
  python: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"],
  go: ["go.mod"],
  typescript: ["package.json", "tsconfig.json"],
  java: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
};

export interface DraftComponent {
  /** Normalized directory, "" for the repo root. */
  dir: string;
  language: Language;
}

const dirOf = (file: string): string => file.slice(0, file.lastIndexOf("/") + 1);

function languageOf(file: string): Language | undefined {
  const name = baseName(file);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? undefined : EXTENSION_LANGUAGE[name.slice(dot).toLowerCase()];
}

/** An `ignore:` entry the draft adds itself, with the comment written above it. */
export interface DraftIgnore {
  entry: string;
  comment: string;
}

export interface ComponentPlan {
  components: DraftComponent[];
  ignore: DraftIgnore[];
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Per go.mod directory that a go.work applies to, the module directories that go.work uses (`goWorkspaces`). */
export type GoWorkspaces = ReadonlyMap<string, ReadonlySet<string>>;

const goModDirs = (paths: readonly string[]) => paths.filter((p) => baseName(p) === "go.mod").map(dirOf);

/**
 * Directories of go.mod files that their go.work leaves out of its `use` list. Never the root, which an `ignore:`
 * entry cannot name, nor a directory holding a module the go.work does use.
 */
function modulesOutsideWorkspace(paths: readonly string[], workspaces: GoWorkspaces): string[] {
  return goModDirs(paths).filter((dir) => {
    const used = workspaces.get(dir);
    return dir !== "" && used !== undefined && ![...used].some((u) => u.startsWith(dir));
  });
}

/** Stray files as `ignore:` entries: one glob for several files of the same extension in a directory. */
function strayEntries(stray: ReadonlyMap<Language, readonly string[]>): DraftIgnore[] {
  const out: DraftIgnore[] = [];
  for (const [language, files] of stray) {
    const comment = `沒有 ${LANGUAGE_LABEL[language]} 的標記檔，未建立元件；若要檢查，請補上標記檔並新增元件`;
    const groups = new Map<string, string[]>();
    for (const f of files) {
      const glob = dirOf(f) + "*" + f.slice(f.lastIndexOf("."));
      groups.set(glob, [...(groups.get(glob) ?? []), f]);
    }
    for (const [glob, members] of groups)
      out.push({ entry: members.length > 1 ? glob : (members[0] ?? glob), comment });
  }
  return out.sort((a, b) => byCodeUnit(a.entry, b.entry));
}

/**
 * Components inferred from the repo's files (SPEC §4.1, §4.3): each source file belongs to the nearest directory
 * holding a build or tool file of its language. Java modules nested in a Java build are one component. A go.mod
 * that the go.work above it does not use is not a component, and source files with no marker file above them make
 * no component when the repo has marked ones: both are returned as `ignore:` entries. A repo with no marker file
 * at all gets a root component per language.
 */
export function inferComponents(files: readonly string[], workspaces: GoWorkspaces = new Map()): ComponentPlan {
  const all = files.map(normalizePath);
  const outside = modulesOutsideWorkspace(all, workspaces);
  const paths = withoutIgnored(outside, all);
  const present = new Set(paths);
  const found = new Map<string, DraftComponent>();
  const stray = new Map<Language, string[]>();
  for (const file of paths) {
    const language = languageOf(file);
    if (!language) continue;
    const marked = upwards(dirOf(file)).filter((d) => MARKERS[language].some((m) => present.has(d + m)));
    // A multi-module Java build is built from its outermost build file.
    const dir = language === "java" ? marked.at(-1) : marked[0];
    if (dir === undefined) stray.set(language, [...(stray.get(language) ?? []), file]);
    else found.set(`${dir}|${language}`, { dir, language });
  }
  const ignore = outside.sort(byCodeUnit).map((dir) => ({ entry: dir, comment: "不在 go.work 的 use 清單中" }));
  if (found.size > 0) ignore.push(...strayEntries(stray));
  else for (const language of stray.keys()) found.set(`|${language}`, { dir: "", language });
  return {
    components: [...found.values()].sort(
      (a, b) => a.dir.localeCompare(b.dir) || LANGUAGES.indexOf(a.language) - LANGUAGES.indexOf(b.language),
    ),
    ignore,
  };
}

export interface DraftOptions {
  cwd: string;
  today: string;
  /** Repo-relative paths of the repo's files. */
  files: readonly string[];
  /** `ignore:` entries for the draft: matching files are left out of the inference and the list is written as is. */
  ignore?: readonly string[];
}

export interface Draft {
  /** The `.devguard.yaml` text. */
  text: string;
  components: DraftComponent[];
}

type Override = unknown;

const ESLINT_CONFIGS = ["js", "mjs", "cjs", "ts", "mts", "cts"].map((e) => `eslint.config.${e}`);
const VITEST_CONFIGS = ["js", "mjs", "cjs", "ts", "mts", "cts"].map((e) => `vitest.config.${e}`);
const JEST_CONFIGS = ["js", "mjs", "cjs", "ts", "mts", "cts", "json"].map((e) => `jest.config.${e}`);

interface FileProbe {
  nearest: (win: readonly string[], lose?: readonly string[]) => boolean;
  /** The type checkers only the component's own settings are for (a `[tool.basedpyright]` table, a mypy.ini). */
  typeCheckers: ReadonlySet<TypeChecker>;
}

/** What the draft knows of the repo's files: which exist, and each Python component's type checker settings. */
interface DraftFiles {
  present: ReadonlySet<string>;
  typeCheckers: ReadonlyMap<string, ReadonlySet<TypeChecker>>;
}

const CHOICE_RULES: Readonly<Record<Language, (p: FileProbe) => [boolean, string, string][]>> = {
  python: (p) => [
    [p.nearest(["poetry.lock"], ["uv.lock"]), "deps.manager", "poetry"],
    [p.nearest(["pyrightconfig.json"]), "typecheck.tool", "pyright"],
    // basedpyright also reads pyrightconfig.json, so its own table wins over the rule above.
    [p.typeCheckers.has("basedpyright"), "typecheck.tool", "basedpyright"],
  ],
  go: () => [],
  typescript: (p) => [
    [p.nearest(["biome.json", "biome.jsonc"], ESLINT_CONFIGS), "lint.tool", "biome"],
    [p.nearest(JEST_CONFIGS, VITEST_CONFIGS), "test.tool", "jest"],
    [p.nearest(["pnpm-lock.yaml"], ["package-lock.json", "npm-shrinkwrap.json"]), "deps.manager", "pnpm"],
    [p.nearest(["yarn.lock"], ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml"]), "deps.manager", "yarn"],
  ],
  java: (p) => [[p.nearest(["build.gradle", "build.gradle.kts"], ["pom.xml"]), "build.tool", "gradle"]],
};

function nearestChoice(
  dir: string,
  present: ReadonlySet<string>,
  win: readonly string[],
  lose: readonly string[] = [],
): boolean {
  for (const d of upwards(dir)) {
    if (lose.some((n) => present.has(d + n))) return false;
    if (win.some((n) => present.has(d + n))) return true;
  }
  return false;
}

/** Infers non-default tool choices (`build.tool`, `deps.manager`, `lint.tool`, etc.) from the component's files. */
function inferToolChoices(c: DraftComponent, files: DraftFiles): Record<string, string> {
  const probe: FileProbe = {
    nearest: (win, lose) => nearestChoice(c.dir, files.present, win, lose),
    typeCheckers: files.typeCheckers.get(c.dir) ?? new Set(),
  };
  return Object.fromEntries(
    CHOICE_RULES[c.language](probe)
      .filter(([match]) => match)
      .map(([, key, value]) => [key, value]),
  );
}

/** Resolves the inferred components with tool-choice overrides and every other item at the standard's default. */
function defaultResolution(
  components: readonly DraftComponent[],
  standard: Standard,
  today: string,
  files: DraftFiles,
): Resolution {
  return resolveDeclaration(
    {
      file: DECLARATION_FILE,
      standard: standard.id,
      components: components.map((c) => ({
        path: displayDir(c.dir),
        language: c.language,
        overrides: Object.entries(inferToolChoices(c, files)).map(([key, raw]) => ({ key, raw })),
      })),
      globalOverrides: [],
      ignore: [],
    },
    today,
    [standard],
  );
}

/** Turns the values the settings checks read into overrides: same is left out, looser gets a TODO reason. */
function overridesFrom(findings: readonly Finding[], standard: Standard, language: Language): Record<string, Override> {
  const defs = standard.languages[language];
  const overrides: Record<string, Override> = {};
  for (const f of findings) {
    const item = f.observed && defs[f.observed.key];
    if (!f.observed || !item || f.observed.key in overrides) continue;
    const { key, value } = f.observed;
    const status = compareToDefault(item, value);
    if (status === "same" || status === "invalid") continue;
    overrides[key] =
      status === "looser" ? { value, reason: `TODO: 由 ${f.file ?? "既有設定"} 推得，請填寫放寬理由` } : value;
  }
  return overrides;
}

/** Per Python component directory, the type checkers whose settings only they read (`typeCheckerConfigs`). */
async function pythonTypeCheckers(
  cwd: string,
  components: readonly DraftComponent[],
  present: ReadonlySet<string>,
): Promise<Map<string, Set<TypeChecker>>> {
  const read = (file: string) => (present.has(file) ? readIfExists(join(cwd, file)) : Promise.resolve(undefined));
  const found = new Map<string, Set<TypeChecker>>();
  for (const c of components.filter((c) => c.language === "python")) {
    const configs = await typeCheckerConfigs(c.dir, read);
    found.set(c.dir, new Set(configs.flatMap((config) => (config.tools.length === 1 ? config.tools : []))));
  }
  return found;
}

/** A draft `.devguard.yaml` for a project that has none, from the components and tool settings found (SPEC §4.3). */
export async function draftDeclaration(options: DraftOptions): Promise<Draft> {
  const { cwd, today } = options;
  const ignore = options.ignore ?? [];
  const given = withoutIgnored(ignore, options.files);
  const standard = defaultStandard();
  if (!standard) throw new Error("no bundled standard");
  const plan = inferComponents(given, await goWorkspaces(cwd, goModDirs(given.map(normalizePath))));
  const { components } = plan;
  const listed = withoutIgnored(
    plan.ignore.map((i) => i.entry),
    given,
  );
  const present = new Set(listed.map(normalizePath));
  const files = { present, typeCheckers: await pythonTypeCheckers(cwd, components, present) };
  const resolution = defaultResolution(components, standard, today, files);
  const seed: CheckLayer = { id: "draft", run: () => Promise.resolve({ findings: [], resolution }) };
  const { findings } = await runCheck({ cwd, today, listFiles: () => Promise.resolve([...listed]) }, [
    seed,
    ...SETTINGS_LAYERS,
  ]);
  const doc = {
    standard: standard.id,
    components: resolution.components.map((c) => {
      const overrides: Record<string, Override> = {
        ...inferToolChoices(c, files),
        ...overridesFrom(
          findings.filter((f) => f.component === c.name),
          standard,
          c.language,
        ),
      };
      return {
        path: displayDir(c.dir),
        language: c.language,
        ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
      };
    }),
    ...(ignore.length + plan.ignore.length > 0 ? { ignore: [...ignore, ...plan.ignore.map((i) => i.entry)] } : {}),
  };
  return { text: HEADER + withIgnoreComments(new Document(doc), ignore.length, plan.ignore).toString(), components };
}

/** Writes each ignore entry's comment above it; the entries the draft adds follow the `skip` given ones. */
function withIgnoreComments(doc: Document, skip: number, added: readonly DraftIgnore[]): Document {
  const seq = doc.get("ignore");
  if (!isSeq(seq)) return doc;
  added.forEach(({ comment }, i) => {
    const item = seq.items[skip + i];
    if (isNode(item)) item.commentBefore = ` ${comment}`;
  });
  return doc;
}

const HEADER = `# 由 devguard draft 依既有的工具設定產生的草稿（SPEC §4.3）。
# 與預設標準相同的項目已省略；比預設寬鬆的項目附有 TODO 理由，填寫理由之前 devguard check 不會通過。
`;

/** Thrown when `.devguard.yaml` already exists: the draft never overwrites a declaration. */
export class DeclarationExistsError extends Error {
  constructor() {
    super(`${DECLARATION_FILE} 已存在，不會覆寫；要重新產生草稿請先移除它`);
  }
}

export interface WriteDraftOptions {
  cwd: string;
  today: string;
  /** Defaults to listing the repo with git. */
  listFiles?: (cwd: string) => Promise<string[]>;
  /** `ignore:` entries for the draft (`draft --ignore`). */
  ignore?: readonly string[];
}

/** `devguard draft`: writes the draft to `.devguard.yaml`, refusing to replace one that exists. */
export async function writeDraft(options: WriteDraftOptions): Promise<Draft & { path: string }> {
  const { cwd, today } = options;
  const path = join(cwd, DECLARATION_FILE);
  if (existsSync(path)) throw new DeclarationExistsError();
  const files = await (options.listFiles ?? listRepoFiles)(cwd);
  const draft = await draftDeclaration({ cwd, today, files, ignore: options.ignore });
  try {
    await writeFile(path, draft.text, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new DeclarationExistsError();
    throw e;
  }
  return { ...draft, path };
}
