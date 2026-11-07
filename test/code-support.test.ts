import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { toRepoPath } from "../src/code/support.ts";

describe("toRepoPath", () => {
  const base = mkdtempSync(join(tmpdir(), "devguard-repo-path-"));
  const real = join(base, "real");
  const link = join(base, "link");
  mkdirSync(real);
  // A junction on Windows, which needs no extra privilege; the type is ignored elsewhere.
  symlinkSync(real, link, "junction");
  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("joins a tool's relative path to the target directory", () => {
    expect(toRepoPath(link, "web/", "src\\a.ts")).toBe("web/src/a.ts");
  });

  it("makes an absolute path relative to cwd", () => {
    expect(toRepoPath(link, "web/", join(link, "web", "a.ts"))).toBe("web/a.ts");
  });

  it("resolves cwd's symlinks when a tool prints the real path, as ESLint does (macOS /var → /private/var)", () => {
    expect(toRepoPath(link, "web/", join(realpathSync(real), "web", "a.ts"))).toBe("web/a.ts");
  });

  it("keeps a path that is outside cwd either way", () => {
    expect(toRepoPath(link, "", join(base, "other", "a.ts"))).toBe("../other/a.ts");
  });
});
