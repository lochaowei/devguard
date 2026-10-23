import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { runCheck } from "./check.ts";
import { compareToDefault } from "./declaration/compare.ts";
import { displayDir, normalizePath } from "./declaration/path.ts";
import { resolveDeclaration, type Resolution } from "./declaration/resolve.ts";
import { DECLARATION_FILE } from "./declaration/types.ts";
import { pythonSettingsLayer } from "./layers/python-settings.ts";
import { goSettingsLayer } from "./layers/settings-go.ts";
import { javaSettingsLayer } from "./layers/settings-java.ts";
import { typescriptSettingsLayer } from "./layers/settings-typescript.ts";
import type { CheckLayer } from "./layers/types.ts";
import type { Finding } from "./report/finding.ts";
import { listRepoFiles } from "./repo/files.ts";
import { BUNDLED_STANDARDS } from "./standard/registry.ts";
import { EXTENSION_LANGUAGE, LANGUAGES, type Language, type Standard } from "./standard/types.ts";

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
  const name = file.slice(file.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? undefined : EXTENSION_LANGUAGE[name.slice(dot).toLowerCase()];
}

/** Ancestor directories of `dir`, nearest first, ending with the root "". */
function ancestors(dir: string): string[] {
  const out = [dir];
  for (let d = dir; d !== "";) {
    d = dirOf(d.slice(0, -1));
    out.push(d);
  }
  return out;
}

/**
 * Components inferred from the repo's files (SPEC §4.1, §4.3): each source file belongs to the nearest directory
 * holding a build or tool file of its language, or to the root. Java modules nested in a Java build are one component.
 */
export function inferComponents(files: readonly string[]): DraftComponent[] {
  const paths = files.map(normalizePath);
  const present = new Set(paths);
  const found = new Map<string, DraftComponent>();
  for (const file of paths) {
    const language = languageOf(file);
    if (!language) continue;
    const marked = ancestors(dirOf(file)).filter((d) => MARKERS[language].some((m) => present.has(d + m)));
    // A multi-module Java build is built from its outermost build file.
    const dir = (language === "java" ? marked.at(-1) : marked[0]) ?? "";
    found.set(`${dir}|${language}`, { dir, language });
  }
  return [...found.values()].sort(
    (a, b) => a.dir.localeCompare(b.dir) || LANGUAGES.indexOf(a.language) - LANGUAGES.indexOf(b.language),
  );
}

export interface DraftOptions {
  cwd: string;
  today: string;
  /** Repo-relative paths of the repo's files. */
  files: readonly string[];
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
  has: (...names: string[]) => boolean;
  hasUp: (...names: string[]) => boolean;
}

const CHOICE_RULES: Readonly<Record<Language, (p: FileProbe) => [boolean, string, string][]>> = {
  python: (p) => [
    [p.has("poetry.lock") && !p.has("uv.lock"), "deps.manager", "poetry"],
    [p.has("pyrightconfig.json"), "typecheck.tool", "pyright"],
  ],
  go: () => [],
  typescript: (p) => [
    [p.has("biome.json", "biome.jsonc") && !p.has(...ESLINT_CONFIGS), "lint.tool", "biome"],
    [p.has(...JEST_CONFIGS) && !p.has(...VITEST_CONFIGS), "test.tool", "jest"],
    [!p.hasUp("package-lock.json", "npm-shrinkwrap.json") && p.hasUp("pnpm-lock.yaml"), "deps.manager", "pnpm"],
    [
      !p.hasUp("package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml") && p.hasUp("yarn.lock"),
      "deps.manager",
      "yarn",
    ],
  ],
  java: (p) => [[p.has("build.gradle", "build.gradle.kts") && !p.has("pom.xml"), "build.tool", "gradle"]],
};

/** Infers non-default tool choices (`build.tool`, `deps.manager`, `lint.tool`, etc.) from the component's files. */
function inferToolChoices(c: DraftComponent, present: ReadonlySet<string>): Record<string, string> {
  const probe: FileProbe = {
    has: (...names) => names.some((n) => present.has(c.dir + n)),
    hasUp: (...names) => ancestors(c.dir).some((d) => names.some((n) => present.has(d + n))),
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
  present: ReadonlySet<string>,
): Resolution {
  return resolveDeclaration(
    {
      file: DECLARATION_FILE,
      standard: standard.id,
      components: components.map((c) => ({
        path: displayDir(c.dir),
        language: c.language,
        overrides: Object.entries(inferToolChoices(c, present)).map(([key, raw]) => ({ key, raw })),
      })),
      globalOverrides: [],
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

/** A draft `.devguard.yaml` for a project that has none, from the components and tool settings found (SPEC §4.3). */
export async function draftDeclaration(options: DraftOptions): Promise<Draft> {
  const { cwd, today, files } = options;
  const standard = BUNDLED_STANDARDS[BUNDLED_STANDARDS.length - 1];
  if (!standard) throw new Error("no bundled standard");
  const present = new Set(files.map(normalizePath));
  const components = inferComponents(files);
  const resolution = defaultResolution(components, standard, today, present);
  const seed: CheckLayer = { id: "draft", run: () => Promise.resolve({ findings: [], resolution }) };
  const { findings } = await runCheck({ cwd, today, listFiles: () => Promise.resolve([...files]) }, [
    seed,
    ...SETTINGS_LAYERS,
  ]);
  const doc = {
    standard: standard.id,
    components: resolution.components.map((c) => {
      const overrides: Record<string, Override> = {
        ...inferToolChoices(c, present),
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
  };
  return { text: HEADER + stringify(doc), components };
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
}

/** `devguard draft`: writes the draft to `.devguard.yaml`, refusing to replace one that exists. */
export async function writeDraft(options: WriteDraftOptions): Promise<Draft & { path: string }> {
  const { cwd, today } = options;
  const path = join(cwd, DECLARATION_FILE);
  if (existsSync(path)) throw new DeclarationExistsError();
  const files = await (options.listFiles ?? listRepoFiles)(cwd);
  const draft = await draftDeclaration({ cwd, today, files });
  try {
    await writeFile(path, draft.text, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new DeclarationExistsError();
    throw e;
  }
  return { ...draft, path };
}
