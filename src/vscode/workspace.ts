import type { Resolution, ResolvedComponent } from "../declaration/resolve.ts";
import type { KeyPath, Layout } from "../fix/repair.ts";
import { CHECKSTYLE_FILES } from "../settings/java/checkstyle.ts";
import { readGradleBuild } from "../versions/pinned.ts";

export const SETTINGS_FILE = ".vscode/settings.json";
export const EXTENSIONS_FILE = ".vscode/extensions.json";
export const TASKS_FILE = ".vscode/tasks.json";
/** The workspace files the CLI manages, in the order they are reported. */
export const VSCODE_FILES = [SETTINGS_FILE, EXTENSIONS_FILE, TASKS_FILE] as const;
export type VscodeFile = (typeof VSCODE_FILES)[number];

/**
 * One CLI-managed piece of a `.vscode/` file (SPEC §7.2); everything else in the file belongs to the developer.
 * - `value`: the value at `path` is `value` (or, legacy, the value at one of `alternatives`)
 * - `member`: the array at `path` contains `value`
 * - `absent`: the array at `path` does not contain `value`
 * - `task`: `tasks` holds a task whose label is `value.label` and that is exactly `value`
 */
export type Managed =
  | { kind: "value"; file: VscodeFile; path: KeyPath; value: unknown; alternatives?: KeyPath[] }
  | { kind: "member" | "absent"; file: VscodeFile; path: KeyPath; value: string }
  | { kind: "task"; file: VscodeFile; value: Task };

export interface Task {
  label: string;
  type: "process";
  command: string;
  args: string[];
  [key: string]: unknown;
}

/** Reads a repo-relative file; undefined when it does not exist. */
export type ReadRepoText = (path: string) => Promise<string | undefined>;

export interface Extensions {
  recommended: string[];
  unwanted: string[];
}

const PYTHON_UNWANTED = ["ms-python.black-formatter", "ms-python.isort", "ms-python.flake8", "ms-python.pylint"];
const ESLINT_PRETTIER = ["dbaeumer.vscode-eslint", "esbenp.prettier-vscode"];
const BIOME = ["biomejs.biome"];

const declared = (c: ResolvedComponent, key: string): unknown => c.effective[key]?.value;
const usesBiome = (c: ResolvedComponent): boolean => declared(c, "lint.tool") === "biome";

function languageExtensions(c: ResolvedComponent): Extensions {
  switch (c.language) {
    case "python": {
      const mypy = declared(c, "typecheck.tool") === "mypy" ? ["ms-python.mypy-type-checker"] : [];
      return { recommended: ["ms-python.python", "charliermarsh.ruff", ...mypy], unwanted: PYTHON_UNWANTED };
    }
    case "go":
      return { recommended: ["golang.go"], unwanted: [] };
    case "typescript": {
      const vitest = declared(c, "test.tool") === "vitest" ? ["vitest.explorer"] : [];
      const [used, other] = usesBiome(c) ? [BIOME, ESLINT_PRETTIER] : [ESLINT_PRETTIER, BIOME];
      return { recommended: [...used, ...vitest], unwanted: other };
    }
    case "java":
      return { recommended: ["vscjava.vscode-java-pack", "shengchen.vscode-checkstyle"], unwanted: [] };
  }
}

const unique = (list: readonly string[]): string[] => [...new Set(list)];

/** The extensions recommended and not recommended for the languages in use (SPEC §7.2); a recommendation wins. */
export function workspaceExtensions(resolution: Resolution): Extensions {
  const all = resolution.components.map(languageExtensions);
  const recommended = unique(all.flatMap((e) => e.recommended));
  const unwanted = unique(all.flatMap((e) => e.unwanted)).filter((id) => !recommended.includes(id));
  return { recommended, unwanted };
}

const setting = (path: KeyPath, value: unknown, alternatives?: KeyPath[]): Managed => ({
  kind: "value",
  file: SETTINGS_FILE,
  path,
  value,
  ...(alternatives ? { alternatives } : {}),
});

const first = (resolution: Resolution, language: string) => resolution.components.find((c) => c.language === language);

function pythonSettings(c: ResolvedComponent): Managed[] {
  const mypy = declared(c, "typecheck.tool") === "mypy";
  return [
    setting(["[python]", "editor.defaultFormatter"], "charliermarsh.ruff"),
    setting(["[python]", "editor.formatOnSave"], true),
    setting(["[python]", "editor.codeActionsOnSave", "source.fixAll"], "explicit"),
    setting(["[python]", "editor.codeActionsOnSave", "source.organizeImports"], "explicit"),
    setting(["ruff.importStrategy"], "fromEnvironment"),
    ...(mypy
      ? [
          setting(["mypy-type-checker.importStrategy"], "fromEnvironment"),
          setting(["mypy-type-checker.cwd"], "${nearestConfig}"),
        ]
      : []),
    setting(["python.defaultInterpreterPath"], `\${workspaceFolder}/${c.dir}.venv`),
  ];
}

const GO_SETTINGS: readonly Managed[] = [
  setting(["go.lintTool"], "golangci-lint-v2"),
  setting(["go.lintOnSave"], "package"),
  setting(["gopls", "formatting.gofumpt"], true),
];

const workingDirectory = (dir: string): string => (dir === "" ? "." : `./${dir.replace(/\/$/, "")}`);

function typescriptSettings(resolution: Resolution, c: ResolvedComponent): Managed[] {
  const biome = usesBiome(c);
  const formatter = biome ? "biomejs.biome" : "esbenp.prettier-vscode";
  const fixAll = biome ? "source.fixAll.biome" : "source.fixAll.eslint";
  const tsdk = `${c.dir}node_modules/typescript/lib`;
  const eslintDirs = resolution.components.filter((t) => t.language === "typescript" && !usesBiome(t));
  return [
    ...["[typescript]", "[typescriptreact]"].flatMap((section) => [
      setting([section, "editor.defaultFormatter"], formatter),
      setting([section, "editor.formatOnSave"], true),
      setting([section, "editor.codeActionsOnSave", fixAll], "explicit"),
    ]),
    // `typescript.tsdk` was deprecated in 2026-05 but is still accepted (SPEC §8).
    setting(["js/ts.tsdk.path"], tsdk, [["typescript.tsdk"]]),
    setting(["js/ts.tsdk.promptToUseWorkspaceVersion"], true),
    ...eslintDirs.map((t): Managed => ({
      kind: "member",
      file: SETTINGS_FILE,
      path: ["eslint.workingDirectories"],
      value: workingDirectory(t.dir),
    })),
  ];
}

/** The Checkstyle version the build pins: the checkstyle dependency of the Maven plugin, or Gradle's `toolVersion`. */
function checkstyleVersion(build: { pom?: string; gradle?: string }): string | undefined {
  if (build.pom !== undefined) {
    const xml = build.pom.replace(/<!--[\s\S]*?-->/g, "");
    return /<artifactId>\s*checkstyle\s*<\/artifactId>\s*<version>\s*([^<$\s]+)\s*<\/version>/.exec(xml)?.[1];
  }
  return build.gradle === undefined ? undefined : readGradleBuild(build.gradle).get("checkstyle");
}

async function javaSettings(c: ResolvedComponent, read: ReadRepoText): Promise<Managed[]> {
  let config: string = CHECKSTYLE_FILES[0];
  for (const name of CHECKSTYLE_FILES) {
    if ((await read(c.dir + name)) !== undefined) {
      config = name;
      break;
    }
  }
  const pom = await read(`${c.dir}pom.xml`);
  const gradle = (await read(`${c.dir}build.gradle.kts`)) ?? (await read(`${c.dir}build.gradle`));
  const version = checkstyleVersion({
    ...(pom === undefined ? {} : { pom }),
    ...(gradle === undefined ? {} : { gradle }),
  });
  return [
    setting(["[java]", "editor.formatOnSave"], false),
    setting(["java.checkstyle.configuration"], `\${workspaceFolder}/${c.dir}${config}`),
    ...(version ? [setting(["java.checkstyle.version"], version)] : []),
  ];
}

const DEVGUARD = "devguard";

/** `file:line:column: severity: message [rule]`, as `check --format vscode` prints it (src/report/vscode.ts). */
export const PROBLEM_MATCHER = {
  owner: "devguard",
  fileLocation: ["relative", "${workspaceFolder}"],
  pattern: {
    regexp: "^(.*):(\\d+):(\\d+): (error|warning|info): (.*) \\[(.*)\\]$",
    file: 1,
    line: 2,
    column: 3,
    severity: 4,
    message: 5,
    code: 6,
  },
};

const devguardTask = (label: string, args: string[], extra: Record<string, unknown> = {}): Task => ({
  label,
  type: "process",
  command: DEVGUARD,
  args,
  problemMatcher: [],
  ...extra,
});

/** The Spotless task of a Java component: its build wrapper's `spotless:apply` / `spotlessApply`. */
function spotlessTask(c: ResolvedComponent, maven: boolean, label: string): Task {
  const [unix, windows] = maven ? ["mvnw", "mvnw.cmd"] : ["gradlew", "gradlew.bat"];
  const args = maven ? ["-B", "-ntp", "spotless:apply"] : ["spotlessApply", "--console=plain"];
  const cwd = `\${workspaceFolder}/${c.dir}`.replace(/\/$/, "");
  return {
    label,
    type: "process",
    command: `./${unix}`,
    args,
    // A .cmd / .bat file only starts through cmd.exe.
    windows: { command: "cmd.exe", args: ["/d", "/c", windows, ...args] },
    options: { cwd },
    problemMatcher: [],
  };
}

async function tasks(resolution: Resolution, read: ReadRepoText): Promise<Task[]> {
  const list = [
    devguardTask("standards: doctor", ["doctor", "--quiet"], { runOptions: { runOn: "folderOpen" } }),
    devguardTask("standards: check", ["check", "--format", "vscode"], { problemMatcher: PROBLEM_MATCHER }),
    devguardTask("standards: fix", ["fix"]),
    devguardTask("standards: test & coverage", ["check", "--full"], { problemMatcher: PROBLEM_MATCHER }),
  ];
  const java = resolution.components.filter((c) => c.language === "java");
  for (const c of java) {
    const label = java.length > 1 ? `standards: format (Spotless) ${c.name}` : "standards: format (Spotless)";
    const maven = (await read(`${c.dir}pom.xml`)) !== undefined || declared(c, "build.tool") !== "gradle";
    list.push(spotlessTask(c, maven, label));
  }
  return list;
}

/**
 * How the `.vscode/` files are laid out when written: a TypeScript component at the repo root formats them (Prettier
 * or Biome) with its declared print width.
 */
export function workspaceLayout(resolution: Resolution): Layout {
  const root = resolution.components.find((c) => c.dir === "" && c.language === "typescript");
  const width = root ? declared(root, "format.printWidth") : undefined;
  return typeof width === "number" ? { printWidth: width } : {};
}

/**
 * Everything the CLI manages in `.vscode/` for the languages the declaration uses (SPEC §7.2). One `.vscode/` at the
 * repo root: per-language sections and `eslint.workingDirectories` cover the components; single-valued settings
 * (interpreter, tsdk, Checkstyle) follow the first component of the language.
 */
export async function managedWorkspace(resolution: Resolution, read: ReadRepoText): Promise<Managed[]> {
  const managed: Managed[] = [setting(["files.eol"], "\n")];
  const python = first(resolution, "python");
  if (python) managed.push(...pythonSettings(python));
  if (first(resolution, "go")) managed.push(...GO_SETTINGS);
  const typescript = first(resolution, "typescript");
  if (typescript) managed.push(...typescriptSettings(resolution, typescript));
  const java = first(resolution, "java");
  if (java) managed.push(...(await javaSettings(java, read)));
  const extensions = workspaceExtensions(resolution);
  for (const id of extensions.recommended) {
    managed.push({ kind: "member", file: EXTENSIONS_FILE, path: ["recommendations"], value: id });
    managed.push({ kind: "absent", file: EXTENSIONS_FILE, path: ["unwantedRecommendations"], value: id });
  }
  for (const id of extensions.unwanted) {
    managed.push({ kind: "member", file: EXTENSIONS_FILE, path: ["unwantedRecommendations"], value: id });
    managed.push({ kind: "absent", file: EXTENSIONS_FILE, path: ["recommendations"], value: id });
  }
  managed.push({ kind: "value", file: TASKS_FILE, path: ["version"], value: "2.0.0" });
  for (const task of await tasks(resolution, read)) managed.push({ kind: "task", file: TASKS_FILE, value: task });
  return managed;
}
