import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { goWorkModules, goWorkspaces } from "../src/repo/go-work.ts";

/** go.work files as `go work init ./a` and then `go work use ./b` wrote them (Go 1.26.5). */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/go/${name}`, import.meta.url), "utf8");

const ROOT = join(tmpdir(), "repo");
const uses = (text: string, workDir = ROOT) => [...goWorkModules(text, workDir, ROOT)];

describe("goWorkModules", () => {
  it("reads the one-line use that go work init writes", () => {
    expect(uses(fixture("go.work-init"))).toEqual(["a/"]);
  });

  it("reads the use block that go work use writes", () => {
    expect(uses(fixture("go.work-use"))).toEqual(["a/", "b/"]);
  });

  it("reads the root, quoted paths, comments, CRLF and a block with no space or on one line", () => {
    const text = 'go 1.23\r\nuse(\r\n\t. // root\r\n\t"./q"\r\n\t`./b q`\r\n)\r\nuse ( ./one )\r\n';
    expect(uses(text)).toEqual(["", "q/", "b q/", "one/"]);
  });

  it("skips other directives", () => {
    expect(uses("go 1.23\ntoolchain go1.26.0\ngodebug default=go1.21\nreplace x => ./y\nuseful ./z\n")).toEqual([]);
  });

  it("reads paths relative to the go.work, including Windows separators and absolute paths", () => {
    expect(uses("use .\\svc\n", join(ROOT, "sub"))).toEqual(["sub/svc/"]);
    expect(uses(`use ${join(ROOT, "abs")}\n`)).toEqual(["abs/"]);
  });

  it("leaves out paths outside the repo", () => {
    expect(uses("use (\n\t../other\n\t./in\n)\n")).toEqual(["in/"]);
  });
});

describe("goWorkspaces", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tree = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "devguard-gowork-"));
    dirs.push(dir);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return dir;
  };

  it("applies the nearest go.work above each module, whether or not git lists it", async () => {
    const dir = tree({ "go.work": "use ./a\n", "nested/go.work": "use ./x\n" });
    const found = await goWorkspaces(dir, ["a/", "b/", "nested/x/"]);
    expect(Object.fromEntries([...found].map(([k, v]) => [k, [...v]]))).toEqual({
      "a/": ["a/"],
      "b/": ["a/"],
      "nested/x/": ["nested/x/"],
    });
  });

  it("reads a go.work above the repo root", async () => {
    const dir = tree({ "go.work": "use (\n\t./repo\n\t./repo/svc\n)\n", "repo/.keep": "" });
    const found = await goWorkspaces(join(dir, "repo"), ["", "svc/", "tools/"]);
    expect(found.get("tools/")).toEqual(new Set(["", "svc/"]));
  });

  it("leaves out modules with no go.work above them", async () => {
    const dir = tree({ "a/go.mod": "module a\n" });
    expect((await goWorkspaces(dir, ["a/"])).size).toBe(0);
  });
});
