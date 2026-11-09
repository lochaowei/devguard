import { dirname, join } from "node:path";
import { devguardCall, FOREIGN_HOOK_PLACEMENT, foreignHookLine, type GitHookName } from "../hooks/file.ts";
import {
  detectFramework,
  frameworkEntry,
  hooksDisabled,
  hooksPathConflict,
  frameworkHooksNotInstalled,
  PRE_COMMIT_MIN_VERSION,
  pushRunsProjectHooks,
  readHooksPath,
  staleMinimumVersion,
  type FrameworkEntry,
  type HookFramework,
  type UnwrittenHooks,
} from "../hooks/frameworks.ts";
import { hookFilePath, INSTALLED_HOOKS, installedHook, type InstalledHook } from "../hooks/location.ts";
import { PRE_PUSH_ENV, prePushRunsTests } from "../hooks/pre-push.ts";
import type { Exec } from "../process/exec.ts";
import type { Finding } from "../report/finding.ts";
import type { EnvironmentCheck } from "./types.ts";
import { isDirectory, readIfExists } from "../shared/fs.ts";

const INSTALL = "devguard install";

function problem(rule: string, message: string, fix = INSTALL): Finding {
  return { level: "error", layer: "environment", rule: `environment/${rule}`, message, fix };
}

/**
 * §7.4 steps 1 and 3: `core.hooksPath`, read with the config file that sets it, must not keep the hooks from running:
 * not the null device, no conflict with the framework in use (`hooksPathConflict`), not a missing directory.
 */
async function hooksPathProblem(
  cwd: string,
  framework: HookFramework | undefined,
  exec: Exec,
): Promise<Finding | undefined> {
  const path = await readHooksPath(cwd, exec);
  const conflict = await hooksPathConflict(cwd, framework, exec);
  if (conflict) {
    if (path && hooksDisabled(path)) {
      const unset = `git config --file "${path.origin}" --unset core.hooksPath`;
      return problem("hooks-path-disabled", conflict.message, `${unset}，再執行 ${INSTALL}`);
    }
    return problem("hooks-path-conflict", conflict.message);
  }
  if (!path) return undefined;
  const first = INSTALLED_HOOKS[0];
  if (first && !(await isDirectory(dirname(await hookFilePath(cwd, first, exec))))) {
    return problem(
      "hooks-path-missing",
      `core.hooksPath = ${path.value}（設定於 ${path.origin}）：目錄不存在，git hook 不會執行`,
    );
  }
  return undefined;
}

/** §7.4 step 2 without a hook framework: the hook file exists, has devguard's marker and an intact checksum. */
function hookFileProblem(hook: GitHookName, installed: InstalledHook): Finding | undefined {
  const { path, status, text = "" } = installed;
  switch (status.kind) {
    case "missing":
      return problem("hook-missing", `沒有安裝 git ${hook} hook（${path}）`);
    case "foreign": {
      const call = devguardCall(text, hook);
      if (call.kind === "runs") return undefined;
      const why =
        call.kind === "missing"
          ? "也沒有呼叫 devguard"
          : `對 devguard 的呼叫在「${call.after}」之後，不會執行，應移到開頭`;
      return problem(
        "hook-foreign",
        `git ${hook} hook（${path}）不是 devguard 產生的，${why}`,
        `${FOREIGN_HOOK_PLACEMENT}：${foreignHookLine(hook)}`,
      );
    }
    case "devguard":
      if (status.intact && status.hook === hook) return undefined;
      return problem("hook-modified", `git ${hook} hook（${path}）被修改過，checksum 不符`);
  }
}

/** §7.4 step 2 with a hook framework: its config calls devguard for the hook. */
function frameworkProblem(hook: GitHookName, entry: FrameworkEntry): Finding | undefined {
  if (entry.present) return undefined;
  return {
    ...problem("framework-entry-missing", `${entry.framework} 的設定中沒有在 ${hook} 呼叫 devguard 的項目`),
    file: entry.file,
  };
}

/**
 * The pre-commit config does not ask for the pre-commit version that knows devguard's `language: unsupported`
 * entries; an older pre-commit then rejects the config without saying why (SPEC §7.4).
 */
function preCommitVersionProblem(file: string, text: string): Finding | undefined {
  const stale = staleMinimumVersion(text);
  if (!stale) return undefined;
  const now = stale.found === undefined ? "沒有設定" : `是 ${stale.found}`;
  const message =
    `${file} 的 minimum_pre_commit_version ${now}；devguard 的項目用 language: unsupported，` +
    `需要 pre-commit ${PRE_COMMIT_MIN_VERSION} 以上，請設為 "${PRE_COMMIT_MIN_VERSION}"`;
  return { ...problem("pre-commit-min-version", message), file };
}

/**
 * The pre-commit config calls devguard at pre-push without a top-level `default_stages`: the project's own hooks
 * without `stages` then run on every push (SPEC §7.4, #95). Not a pre-push problem of devguard's, so never only a hint.
 */
function preCommitDefaultStagesProblem(file: string, text: string): Finding | undefined {
  if (!pushRunsProjectHooks(text)) return undefined;
  const message =
    `${file} 沒有設定頂層 default_stages；安裝 pre-push hook 型別後，專案中沒寫 stages 的 hook 也會在每次 git push 時執行，` +
    "請加上 default_stages: [pre-commit]";
  return { ...problem("pre-commit-default-stages", message), file };
}

/** What the pre-commit config itself needs for devguard's entries to work as intended (SPEC §7.4). */
async function preCommitConfigProblems(cwd: string, file: string): Promise<Finding[]> {
  const text = (await readIfExists(join(cwd, file))) ?? "";
  const found = [preCommitVersionProblem(file, text), preCommitDefaultStagesProblem(file, text)];
  return found.filter((f) => f !== undefined);
}

/**
 * §7.4 step 2 with a framework that writes its own hooks (pre-commit, lefthook): the entry alone does nothing until
 * the framework's command has written the hook into the hooks directory. `unwritten` is `frameworkHooksNotInstalled`,
 * which `install` also reads for its next step.
 */
function frameworkInstalledProblem(hook: GitHookName, unwritten: UnwrittenHooks | undefined): Finding | undefined {
  const installed = unwritten?.hooks.get(hook);
  if (!unwritten || !installed) return undefined;
  const message = `${unwritten.framework} 的 ${hook} hook 沒有安裝（${installed.path}）；設定中的 devguard 項目不會執行`;
  return problem("framework-not-installed", message, unwritten.command);
}

/**
 * A pre-push problem while this developer's pushes do not run the tests (`DEVGUARD_PRE_PUSH` is not `full`, SPEC
 * §7.4): nothing is lost until they opt in, so it is only a hint. doctor reads the variable from its own shell, which
 * can differ from what `git push` sees (another terminal, an IDE or a GUI client), so the hint says so.
 */
function asHint(finding: Finding): Finding {
  const message =
    `${finding.message}（doctor 所在的 shell 沒有設定 ${PRE_PUSH_ENV}=full，push 時不跑測試，所以只列為提示；` +
    "從其他終端機、IDE 或 GUI 執行時，git push 看到的環境變數可能不同）";
  return { ...finding, level: "hint", message };
}

/** The hook framework's devguard entry for a hook (`frameworkEntry`); undefined when no framework is used. */
export type FrameworkEntryProbe = (cwd: string, hook: GitHookName) => Promise<FrameworkEntry | undefined>;

/** What `hookProblem` reads besides the hook: the framework probe and the hooks the framework has not written. */
interface HookProbes {
  entryFor: FrameworkEntryProbe;
  unwritten: UnwrittenHooks | undefined;
  exec: Exec;
}

/** §7.4 step 2 for one hook: through the framework when one is used, otherwise the hook file. */
async function hookProblem(cwd: string, hook: GitHookName, probes: HookProbes): Promise<Finding | undefined> {
  const entry = await probes.entryFor(cwd, hook);
  if (!entry) return hookFileProblem(hook, await installedHook(cwd, hook, probes.exec));
  return frameworkProblem(hook, entry) ?? frameworkInstalledProblem(hook, probes.unwritten);
}

export interface GitHooksCheckOptions {
  /** Defaults to `frameworkEntry` (src/hooks/frameworks.ts); tests pass a fake. */
  framework?: FrameworkEntryProbe;
}

/** §7.4「已安裝」: core.hooksPath does not silence the hooks, and the hooks devguard installs are in place. */
export function createGitHooksCheck(options: GitHooksCheckOptions = {}): EnvironmentCheck {
  const entryFor = options.framework ?? frameworkEntry;
  return {
    id: "git-hooks",
    async run({ cwd, exec, env }) {
      const repo = await exec({ file: "git", args: ["rev-parse", "--git-dir"], cwd });
      if (repo.code !== 0) {
        return [problem("not-a-git-repo", `${cwd} 不是 git repo，無法安裝 git hook`, `git init，再執行 ${INSTALL}`)];
      }
      const framework = await detectFramework(cwd);
      const silenced = await hooksPathProblem(cwd, framework, exec);
      if (silenced) return [silenced];
      const findings = framework?.name === "pre-commit" ? await preCommitConfigProblems(cwd, framework.file) : [];
      const probes = { entryFor, unwritten: await frameworkHooksNotInstalled(cwd, exec), exec };
      for (const hook of INSTALLED_HOOKS) {
        const found = await hookProblem(cwd, hook, probes);
        if (found) findings.push(hook === "pre-push" && !prePushRunsTests(env) ? asHint(found) : found);
      }
      return findings;
    },
  };
}

export const gitHooksCheck: EnvironmentCheck = createGitHooksCheck();
