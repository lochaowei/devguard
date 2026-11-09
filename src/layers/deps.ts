import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedComponent } from "../declaration/resolve.ts";
import { directDependencies, isBanned, pyName } from "../deps/manifests.ts";
import { parseConfigText } from "../fix/edit.ts";
import { componentBuildTool } from "../settings/java/build.ts";
import type { Finding, Level } from "../report/finding.ts";
import { listTrackedFiles } from "../repo/files.ts";
import type { ToolResult, ToolRunner } from "../tools/runner.ts";
import type { CheckLayer } from "./types.ts";
import { readIfExists } from "../shared/fs.ts";
import { upwards } from "../repo/paths.ts";
import { isRecord } from "../shared/guards.ts";

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
  /** The declared standard's allowed TypeScript `deps.manager` values. */
  typescriptManagers: readonly string[];
}

type Emit = (level: Level, rule: string, message: string, extra?: Partial<Finding>) => void;

const PYTHON_LOCKS = ["uv.lock", "poetry.lock"];
const NPM_LOCKS = ["package-lock.json", "npm-shrinkwrap.json"];
const TS_LOCKS: Readonly<Record<string, readonly string[] | undefined>> = {
  npm: NPM_LOCKS,
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock"],
};

const effective = (c: ResolvedComponent, key: string): unknown => c.effective[key]?.value;

function inDir(dir: string, command: string): string {
  return dir === "" ? command : `cd ${dir.replace(/\/$/, "")} && ${command}`;
}

/**
 * Requires one of `candidates` (repo-relative) to be committed. `expected` is the file named in the finding.
 * Returns the first committed candidate, or undefined when none is.
 */
function requireCommitted(
  s: Scope,
  emit: Emit,
  candidates: readonly string[],
  expected: string,
  note = "",
): string | undefined {
  const committed = (p: string) => (s.tracked ? s.tracked.has(p) : s.exists(p));
  const found = candidates.find(committed);
  if (found !== undefined) return found;
  const untracked = candidates.find((p) => s.exists(p));
  if (untracked) {
    emit("error", "deps/lockfile-untracked", `${untracked} 存在但沒有提交到 git`, {
      file: untracked,
      fix: `git add ${untracked}`,
    });
  } else {
    emit("error", "deps/lockfile-missing", `沒有提交 ${expected}${note}`, { file: expected });
  }
  return undefined;
}

/** Every line that names a requirement carries `--hash` (pip's hash-checking mode). */
function fullyHashed(requirements: string): boolean {
  const reqs = requirementLines(requirements);
  return reqs.length > 0 && reqs.every((l) => l.includes("--hash="));
}

/** The requirement lines of a requirements.txt: continuations joined; no comments, blank lines or option lines. */
function requirementLines(requirements: string): string[] {
  return requirements
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|\s)#.*$/, "").trim())
    .filter((l) => l !== "" && !l.startsWith("-"));
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
  const lock = requireCommitted(
    s,
    emit,
    upwards(dir).flatMap((d) => PYTHON_LOCKS.map((l) => d + l)),
    expected,
    note,
  );
  if (text !== undefined && lock !== undefined) await requirementsLocked(s, emit, requirements, text, lock);
}

/** The most packages a finding names before it counts the rest. */
const LISTED = 5;

/**
 * Packages a hash-less requirements.txt names, as written: not comments, options (`-r`, `-c`, `-e`, `--index-url`
 * and the like), URLs or local paths, which `uv add -r` / `poetry add` would not lock under the name read here.
 */
export function requirementNames(text: string): string[] {
  return requirementLines(text)
    .filter((l) => !isUrlOrPath(l))
    .flatMap((l) => /^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(l)?.[0] ?? []);
}

/** A URL (`git+https://…`) or a local path / archive (`./pkg`, `libs/x`, `dist/x-1.0-py3-none-any.whl`). */
const isUrlOrPath = (line: string) => /^[^\s;@]*(:\/\/|[\\/])/.test(line) || /\.(whl|zip|tar\.gz)$/i.test(line);

/** PEP 503 normalized names of the `[[package]]` tables in uv.lock / poetry.lock. */
export function lockedNames(text: string): Set<string> {
  const doc = parseConfigText("x.lock.toml", text);
  const packages = isRecord(doc) && Array.isArray(doc.package) ? doc.package : [];
  return new Set(packages.flatMap((p) => (isRecord(p) && typeof p.name === "string" ? [pyName(p.name)] : [])));
}

/**
 * A hash-less requirements.txt next to a committed lockfile: every package it names must be in that lockfile (#137).
 * A uv.lock that only pins the dev tools otherwise hides runtime dependencies nothing locks.
 */
async function requirementsLocked(s: Scope, emit: Emit, requirements: string, text: string, lock: string) {
  const locked = lockedNames((await s.read(lock)) ?? "");
  const missing = [...new Map(requirementNames(text).map((n) => [pyName(n), n])).entries()]
    .filter(([key]) => !locked.has(key))
    .map(([, name]) => name);
  if (missing.length === 0) return;
  const rest = missing.length > LISTED ? ` 與另外 ${String(missing.length - LISTED)} 個` : "";
  const fix = lock.endsWith("poetry.lock") ? `poetry add ${missing.join(" ")}` : "uv add -r requirements.txt";
  emit(
    "error",
    "deps/requirements-unlocked",
    `${requirements} 的套件沒有鎖定在 ${lock}：${missing.slice(0, LISTED).join("、")}${rest}`,
    { file: requirements, fix: inDir(s.component.dir, fix) },
  );
}

function typescriptLockfile(s: Scope, emit: Emit): Promise<void> {
  const manager = effective(s.component, "deps.manager");
  // A manager the standard does not allow (bun before team@1.4.0) is already an error or a deviation in the
  // declaration; fall back to npm's lockfiles, as before the standard allowed it.
  const allowed = typeof manager === "string" && s.typescriptManagers.includes(manager);
  const locks = (allowed ? TS_LOCKS[manager] : undefined) ?? NPM_LOCKS;
  const dirs = upwards(s.component.dir);
  const candidates = dirs.flatMap((d) => locks.map((l) => d + l));
  requireCommitted(
    s,
    emit,
    candidates,
    `${s.component.dir}${locks[0] ?? ""}`,
    bunNote(s, allowed ? manager : undefined, dirs),
  );
  return Promise.resolve();
}

/**
 * Bun's lockfiles: text `bun.lock` (Bun 1.2 and later; checked on 1.4.4) and binary `bun.lockb` (before 1.2). Only
 * `bun.lock` counts as the lockfile of `deps.manager: bun` (#138): no versions can be read from `bun.lockb`.
 */
const BUN_LOCKS = ["bun.lock", "bun.lockb"];

/**
 * Why a project Bun manages has no lockfile the check accepts. With `deps.manager: bun`, a `bun.lockb` needs
 * converting (#138). With another manager and only Bun lockfiles: set `deps.manager: bun` where the standard allows
 * it (team@1.4.0 and later, #138), otherwise Bun is not allowed (#122). Empty when the component and the directories
 * above have another manager's lockfile, or no Bun lockfile.
 */
function bunNote(s: Scope, manager: unknown, dirs: readonly string[]): string {
  const find = (locks: readonly string[]) => dirs.flatMap((d) => locks.map((l) => d + l)).find((p) => s.exists(p));
  if (manager === "bun") {
    const lockb = find(["bun.lockb"]);
    return lockb === undefined
      ? ""
      : `（${lockb} 是 Bun 1.2 之前的二進位格式，讀不到套件版本，不算 lockfile：執行 bun install --save-text-lockfile 轉換成 bun.lock）`;
  }
  const others = Object.entries(TS_LOCKS).flatMap(([m, locks]) => (m === "bun" ? [] : (locks ?? [])));
  if (find(others) !== undefined) return "";
  const bun = find(BUN_LOCKS);
  if (bun === undefined) return "";
  if (s.typescriptManagers.includes("bun")) return `（偵測到 Bun（${bun}）：把 deps.manager 設成 bun）`;
  const allowed = s.typescriptManagers.join("／");
  return `（偵測到 Bun（${bun}），但 Bun 不是允許的套件管理工具（允許 ${allowed}）：改用其中一個並提交它的 lockfile）`;
}

async function goLockfile(s: Scope, emit: Emit): Promise<void> {
  const { dir } = s.component;
  const goMod = `${dir}go.mod`;
  const text = await s.read(goMod);
  if (requireCommitted(s, emit, [goMod], goMod) === undefined && text === undefined) return;
  // go.sum only exists once the module has requirements.
  if (text !== undefined && /^\s*require\b/m.test(text)) requireCommitted(s, emit, [`${dir}go.sum`], `${dir}go.sum`);
  if (text === undefined) return;
  const r = await s.tools.run({ language: "go", tool: "go", dir, args: ["mod", "tidy", "-diff"] });
  if (r.code !== 0) reportGoTidyFailure(r, goMod, dir, emit);
}

function reportGoTidyFailure(r: ToolResult, goMod: string, dir: string, emit: Emit): void {
  // `go: downloading ...` lines are progress noise; left in, they push the real cause out of the first lines (#83).
  const lines = (r.stdout.trim() || r.stderr.trim()).split(/\r?\n/).filter((l) => !l.startsWith("go: downloading "));
  const detail = lines.slice(0, 5).join("\n");
  if (r.stdout.trim() !== "") {
    emit("error", "deps/go-mod-untidy", `go.mod / go.sum 與程式碼不一致（go mod tidy -diff 不乾淨）\n${detail}`, {
      file: goMod,
      fix: inDir(dir, "go mod tidy"),
    });
    return;
  }
  // No diff: the check itself could not run. With the checks offline (GOPROXY=off), an empty module cache is the usual cause.
  const lookup = lines.find((l) => l.includes("module lookup disabled by GOPROXY=off"));
  if (lookup !== undefined) {
    emit("error", "deps/go-modules-missing", `依賴還沒下載到模組快取，無法確認 go.mod / go.sum\n${lookup.trim()}`, {
      file: goMod,
      fix: inDir(dir, "go mod download"),
    });
    return;
  }
  emit(
    "error",
    "deps/tool-failed",
    `go mod tidy -diff 執行失敗（exit ${String(r.code)}）${detail === "" ? "" : `：\n${detail}`}`,
    {
      file: goMod,
      fix: inDir(dir, "go mod tidy -diff"),
    },
  );
}

const ENFORCER_RULES = ["banDynamicVersions", "dependencyConvergence"];

const stripXmlComments = (xml: string) => xml.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ""));

async function javaLockfile(s: Scope, emit: Emit): Promise<void> {
  const { dir } = s.component;
  if ((await componentBuildTool(s.component, s.exists)) === "gradle") {
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
        read: (p: string) => readIfExists(join(ctx.cwd, p)),
        exists: (p: string) => existsSync(join(ctx.cwd, p)),
        tracked: list && new Set(list),
        typescriptManagers: ctx.resolution?.standard?.languages.typescript["deps.manager"]?.allowed ?? [],
      };
      const findings: Finding[] = [];
      for (const component of components) findings.push(...(await checkComponent({ ...base, component })));
      return { findings };
    },
  };
}

export const depsLayer = createDepsLayer();
