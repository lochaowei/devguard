import type { Resolution } from "../declaration/resolve.ts";
import type { Finding } from "../report/finding.ts";
import type { ToolRunner } from "../tools/runner.ts";

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
}
