import { parse as parseYaml } from "yaml";
import type { ResolvedComponent } from "../declaration/resolve.ts";
import type { Finding } from "../report/finding.ts";
import type { Language } from "../standard/types.ts";
import { pinnedVersions, type ReadRepoFile } from "./pinned.ts";

export const PRE_COMMIT_CONFIG = ".pre-commit-config.yaml";

/** Well-known pre-commit hook repositories of the standard's tools: the package each one runs. */
const HOOK_REPOS: readonly { repo: RegExp; language: Language; pinnedAs: string }[] = [
  { repo: /astral-sh\/ruff-pre-commit/, language: "python", pinnedAs: "ruff" },
  { repo: /pre-commit\/mirrors-mypy/, language: "python", pinnedAs: "mypy" },
  { repo: /RobertCraigie\/pyright-python/, language: "python", pinnedAs: "pyright" },
  { repo: /pre-commit\/mirrors-eslint/, language: "typescript", pinnedAs: "eslint" },
  { repo: /pre-commit\/mirrors-prettier|rbubley\/mirrors-prettier/, language: "typescript", pinnedAs: "prettier" },
  { repo: /biomejs\/pre-commit/, language: "typescript", pinnedAs: "@biomejs/biome" },
];

interface HookRepo {
  repo: string;
  rev: string;
}

function hookRepos(text: string | undefined): HookRepo[] {
  if (text === undefined) return [];
  try {
    const doc = parseYaml(text) as { repos?: unknown } | null;
    const repos = Array.isArray(doc?.repos) ? (doc.repos as unknown[]) : [];
    return repos.flatMap((r) => {
      const { repo, rev } = (r ?? {}) as { repo?: unknown; rev?: unknown };
      return typeof repo === "string" && typeof rev === "string" ? [{ repo, rev }] : [];
    });
  } catch {
    return [];
  }
}

const bare = (version: string) => version.trim().replace(/^v/, "");

/**
 * §8: in an existing pre-commit framework, another tool's hook pinned at a `rev` other than the version the project
 * locks runs a different tool version than the other lines of defense. A hint, never an error.
 */
export function preCommitRevHints(components: readonly ResolvedComponent[], read: ReadRepoFile): Finding[] {
  const findings: Finding[] = [];
  for (const { repo, rev } of hookRepos(read(PRE_COMMIT_CONFIG))) {
    const known = HOOK_REPOS.find((h) => h.repo.test(repo));
    if (!known) continue;
    for (const c of components.filter((x) => x.language === known.language)) {
      const locked = pinnedVersions(c.language, c.dir, read)?.versions.get(known.pinnedAs);
      if (locked === undefined || bare(locked) === bare(rev)) continue;
      findings.push({
        level: "hint",
        layer: "consistency",
        rule: "tool-version/pre-commit-rev",
        message: `${PRE_COMMIT_CONFIG} 中 ${repo} 的 rev ${rev} 與專案鎖定的 ${known.pinnedAs} ${locked} 不同`,
        component: c.name,
        file: PRE_COMMIT_CONFIG,
        fix: `把 rev 改成 v${bare(locked)}（或對應的 tag），讓 pre-commit 與其他防線使用同一版本`,
      });
    }
  }
  return findings;
}
