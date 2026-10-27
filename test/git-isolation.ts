import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/**
 * Isolates the real git calls of the calling test file (each file runs in its own worker, so this touches only its
 * own `process.env`). Should the tests run under a git hook, git's exported variables (`GIT_DIR`, `GIT_WORK_TREE`,
 * `GIT_INDEX_FILE`...) would point every git call in the file at the repo that ran the hook, so every `GIT_*` variable
 * is cleared. HOME and the global config point into a temporary directory and the system config is skipped, so no
 * git call can read or write a config outside it. Call it at the top level of the test file, before any git runs.
 * Returns the temporary HOME; it is removed after the file's tests.
 */
export function isolateGit(): string {
  for (const name of Object.keys(process.env)) {
    if (/^GIT_/i.test(name)) Reflect.deleteProperty(process.env, name);
  }
  const base = mkdtempSync(join(tmpdir(), "devguard-git-home-"));
  const home = join(base, "home");
  mkdirSync(home);
  Object.assign(process.env, {
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  });
  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });
  return home;
}
