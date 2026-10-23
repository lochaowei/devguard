import { runPreCommit, type HookContext } from "./pre-commit.ts";
import { runPrePush } from "./pre-push.ts";

export type { HookContext } from "./pre-commit.ts";

/** A `devguard hook <name>` handler: handles its own input and returns the exit code the caller expects (SPEC §3.2). */
export type HookHandler = (ctx: HookContext) => Promise<number>;

/** `devguard hook <name>`; a new hook (git-pre-push, claude-*) only needs an entry here. */
export const HOOK_HANDLERS: Readonly<Record<string, HookHandler>> = {
  "git-pre-commit": runPreCommit,
  "git-pre-push": runPrePush,
};
