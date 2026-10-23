import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedComponent } from "../declaration/resolve.ts";
import { directDependencies, isBanned, parentDirs } from "../deps/manifests.ts";
import type { Finding, Level } from "../report/finding.ts";
import { listTrackedFiles } from "../repo/files.ts";
import type { ToolRunner } from "../tools/runner.ts";
import type { CheckLayer } from "./types.ts";

export interface DepsLayerDeps {
  /** Files git tracks (repo-relative, forward slashes), or undefined outside a git repo. Defaults to `git ls-files`. */
  trackedFiles?: (cwd: string) => Promise<readonly string[] | undefined>;
}

/** What the rules for one component can see. */
interface Scope {
  component: ResolvedComponent;
  tools: ToolRunner;
  /** Repo-relative path → contents, or undefined when the file does not exist. */
  read: (path: string) => Promise<string | undefined>;
  exists: (path: string) => boolean;
  /** Undefined outside a git repo: then existing on disk counts as committed. */
  tracked?: ReadonlySet<string>;
}

type Emit = (level: Level, rule: string, message: string, extra?: Partial<Finding>) => void;

const PYTHON_LOCKS = ["uv.lock", "poetry.lock"];
const NPM_LOCKS = ["package-lock.json", "npm-shrinkwrap.json"];
const TS_LOCKS: Readonly<Record<string, readonly string[] | undefined>> = {
  npm: NPM_LOCKS,
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
};

const effective = (c: ResolvedComponent, key: string): unknown => c.effective[key]?.value;

function inDir(dir: string, command: string): string {
  return dir === "" ? command : `cd ${dir.replace(/\/$/, "")} && ${command}`;
}

/**
 * Requires one of `candidates` (repo-relative) to be committed. `expected` is the file named in the finding.
 * Returns true when one is committed.
 */
function requireCommitted(s: Scope, emit: Emit, candidates: readonly string[], expected: string, note = ""): boolean {
  const committed = (p: string) => (s.tracked ? s.tracked.has(p) : s.exists(p));
  if (candidates.some(committed)) return true;
  const untracked = candidates.find((p) => s.exists(p));
  if (untracked) {
    emit("error", "deps/lockfile-untracked", `${untracked} 存在但沒有提交到 git`, {
      file: untracked,
      fix: `git add ${untracked}`,
    });
  } else {
    emit("error", "deps/lockfile-missing", `沒有提交 ${expected}${note}`, { file: expected });
  }
  return false;
}

/** Every line that names a requirement carries `--hash` (pip's hash-checking mode). */
function fullyHashed(requirements: string): boolean {
  const reqs = requirements
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|\s)#.*$/, "").trim())
    .filter((l) => l !== "" && !l.startsWith("-"));
  return reqs.length > 0 && reqs.every((l) => l.includes("--hash="));
}

async function pythonLockfile(s: Scope, emit: Emit): Promise<void> {
  const { dir } = s.component;
  const requirements = `${dir}requirements.txt`;
  const text = await s.read(requirements);
  if (text !== undefined && fullyHashed(text)) {
    requireCommitted(s, emit, [requirements], requirements);
    return;
  }
  const expected = `${dir}${effective(s.component, "deps.manager") === "poetry" ? "poetry.lock" : "uv.lock"}`;
  const note = text === undefined ? "" : "（不帶 hash 的 requirements.txt 不算 lockfile）";
  requireCommitted(
    s,
    emit,
    parentDirs(dir).flatMap((d) => PYTHON_LOCKS.map((l) => d + l)),
    expected,
    note,
  );
}

function typescriptLockfile(s: Scope, emit: Emit): Promise<void> {
  const manager = effective(s.component, "deps.manager");
  // An unknown manager is already an error in the declaration; fall back to npm's lockfiles.
  const locks = (typeof manager === "string" ? TS_LOCKS[manager] : undefined) ?? NPM_LOCKS;
  const candidates = parentDirs(s.component.dir).flatMap((d) => locks.map((l) => d + l));
  requireCommitted(s, emit, candidates, `${s.component.dir}${locks[0] ?? ""}`);
  return Promise.resolve();
}

async function goLockfile(s: Scope, emit: Emit): Promise<void> {
  const { dir } = s.component;
  const goMod = `${dir}go.mod`;
  const text = await s.read(goMod);
  if (!requireCommitted(s, emit, [goMod], goMod) && text === undefined) return;
  // go.sum only exists once the module has requirements.
  if (text !== undefined && /^\s*require\b/m.test(text)) requireCommitted(s, emit, [`${dir}go.sum`], `${dir}go.sum`);
  if (text === undefined) return;
  const r = await s.tools.run({ language: "go", tool: "go", dir, args: ["mod", "tidy", "-diff"] });
  if (r.code !== 0) {
    const detail = (r.stdout.trim() || r.stderr.trim()).split(/\r?\n/).slice(0, 5).join("\n");
    emit("error", "deps/go-mod-untidy", `go.mod / go.sum 與程式碼不一致（go mod tidy -diff 不乾淨）\n${detail}`, {
      file: goMod,
      fix: inDir(dir, "go mod tidy"),
    });
  }
}

const ENFORCER_RULES = ["banDynamicVersions", "dependencyConvergence"];

const stripXmlComments = (xml: string) => xml.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ""));

async function javaLockfile(s: Scope, emit: Emit): Promise<void> {
  const { dir } = s.component;
  if (effective(s.component, "build.tool") === "gradle") {
    requireCommitted(
      s,
      emit,
      [`${dir}gradle.lockfile`],
      `${dir}gradle.lockfile`,
      "（啟用 Gradle dependency locking 後執行 ./gradlew dependencies --write-locks）",
    );
    return;
  }
  const pom = `${dir}pom.xml`;
  const text = await s.read(pom);
  if (text === undefined) {
    emit("error", "deps/manifest-missing", `找不到 ${pom}`, { file: pom });
    return;
  }
  const xml = stripXmlComments(text);
  const enforcer = xml.includes("<artifactId>maven-enforcer-plugin</artifactId>");
  const missing = ENFORCER_RULES.filter((rule) => !enforcer || !new RegExp(`<${rule}[\\s/>]`).test(xml));
  if (missing.length > 0) {
    emit("error", "deps/enforcer-rule-missing", `Maven Enforcer 缺少規則：${missing.join("、")}`, {
      file: pom,
      fix: "在 pom.xml 的 maven-enforcer-plugin 加上 banDynamicVersions 與 dependencyConvergence（建置檔不會自動修改）",
    });
  }
}

const LOCKFILE_RULES = { python: pythonLockfile, typescript: typescriptLockfile, go: goLockfile, java: javaLockfile };

async function bannedDependencies(s: Scope, emit: Emit): Promise<void> {
  const banned = effective(s.component, "deps.banned");
  if (!Array.isArray(banned) || banned.length === 0) return;
  const deps = await directDependencies(s.component.language, s.component.dir, s.read);
  for (const dep of deps) {
    const hit = banned.find((b): b is string => typeof b === "string" && isBanned(s.component.language, dep.name, b));
    if (hit) {
      emit("error", "deps/banned", `直接依賴了禁用套件 ${dep.name}`, {
        file: dep.file,
        line: dep.line,
        fix: `移除 ${dep.name}，改用替代套件`,
      });
    }
  }
}

async function checkComponent(s: Scope): Promise<Finding[]> {
  const findings: Finding[] = [];
  const emit: Emit = (level, rule, message, extra) =>
    findings.push({ level, layer: "config", rule, message, component: s.component.name, ...extra });
  if (effective(s.component, "deps.lockfile") === true) await LOCKFILE_RULES[s.component.language](s, emit);
  await bannedDependencies(s, emit);
  return findings;
}

async function readOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** Dependency rules (SPEC §5.4, §6 `deps.*`): lockfiles committed, banned packages absent from direct dependencies. */
export function createDepsLayer(deps: DepsLayerDeps = {}): CheckLayer {
  const trackedFiles = deps.trackedFiles ?? ((cwd: string) => listTrackedFiles(cwd));
  return {
    id: "deps",
    async run(ctx) {
      const components = ctx.resolution?.components ?? [];
      if (components.length === 0) return { findings: [] };
      const list = await trackedFiles(ctx.cwd);
      const base = {
        tools: ctx.tools,
        read: (p: string) => readOrUndefined(join(ctx.cwd, p)),
        exists: (p: string) => existsSync(join(ctx.cwd, p)),
        tracked: list && new Set(list),
      };
      const findings: Finding[] = [];
      for (const component of components) findings.push(...(await checkComponent({ ...base, component })));
      return { findings };
    },
  };
}

export const depsLayer = createDepsLayer();
