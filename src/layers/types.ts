import type { CodeCategory } from "../code/types.ts";
import type { Resolution } from "../declaration/resolve.ts";
import type { Finding } from "../report/finding.ts";
import type { ToolRunner } from "../tools/runner.ts";

/** What `devguard check` was asked to cover: `[files]`, `--only <類別>`, `--full`. */
export interface CheckScope {
  /** Repo-relative, forward-slash paths given on the command line; absent means the whole repo. */
  files?: readonly string[];
  /** Run only this category. */
  only?: CodeCategory;
  /** Run every check, including slow ones a layer may otherwise skip (tests, coverage, vulnerability scans). */
  full: boolean;
}

/** What a check layer can see. Layers run in order; `resolution` is set once the declaration layer has run. */
export interface LayerContext {
  cwd: string;
  /** Local calendar date, YYYY-MM-DD. */
  today: string;
  resolution?: Resolution;
  /** Runs the project's own pinned tools (SPEC §5.2). Throws ToolMissingError when a tool is not installed. */
  tools: ToolRunner;
  /** Repo-relative, forward-slash paths of the files in the repo; listed once, on first call. */
  files: () => Promise<readonly string[]>;
  scope: CheckScope;
  /** Set by the pre-commit hook: the staged version of a repo-relative file, for tools that read stdin. */
  stagedText?: (repoPath: string) => Promise<string | undefined>;
}

/** The files a layer should look at: those given on the command line, otherwise every file in the repo. */
export function scopedFiles(ctx: LayerContext): Promise<readonly string[]> {
  return ctx.scope.files ? Promise.resolve(ctx.scope.files) : ctx.files();
}

export interface LayerResult {
  findings: Finding[];
  /** Only the declaration layer sets this. */
  resolution?: Resolution;
}

/** One layer of `devguard check` (declaration, settings, dependencies, code...). */
export interface CheckLayer {
  id: string;
  run(ctx: LayerContext): Promise<LayerResult>;
  /**
   * `devguard fix` runs this layer to find the repairs its findings carry (SPEC §9). A layer object means fix runs
   * that variant instead (VS Code: also generate a workspace that has none of the files yet). Layers that run the
   * project's tools (code, tests, dependencies, tool versions) are never fixable this way.
   */
  fixable?: true | CheckLayer;
}

/** The layers `devguard fix` runs, in check order: each fixable layer, or the variant it names. */
export function fixLayers(layers: readonly CheckLayer[]): CheckLayer[] {
  return layers.flatMap((l) => (l.fixable === undefined ? [] : [l.fixable === true ? l : l.fixable]));
}
