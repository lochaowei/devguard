import { describe, expect, it } from "vitest";
import type { Command, Exec } from "../src/process/exec.ts";
import { createToolRunner, ToolMissingError, type ToolRequest, type ToolRunnerDeps } from "../src/tools/runner.ts";

const ROOT = "C:\\repo";

/** A fake project: `files` maps absolute paths to contents; exec records what it was asked to start. */
function fakeRunner(files: Record<string, string>, extra: Partial<ToolRunnerDeps> = {}) {
  const started: Command[] = [];
  const exec: Exec = (command) => {
    started.push(command);
    return Promise.resolve({ code: 0, stdout: "ok", stderr: "" });
  };
  const runner = createToolRunner({
    cwd: ROOT,
    platform: "win32",
    exec,
    exists: (p) => p in files,
    readText: (p) => files[p],
    pathEnv: "C:\\bin;C:\\scoop\\shims",
    ...extra,
  });
  return { runner, started };
}

async function missing(run: Promise<unknown>): Promise<{ message: string; install: string }> {
  try {
    await run;
  } catch (e) {
    if (e instanceof ToolMissingError) return { message: e.message, install: e.install };
    throw e;
  }
  throw new Error("expected ToolMissingError");
}

const req = (r: Partial<ToolRequest> & Pick<ToolRequest, "language" | "tool">): ToolRequest => ({ dir: "", ...r });

describe("tool runner: Python", () => {
  it("runs the tool through uv when it is installed in the component's .venv", async () => {
    const { runner, started } = fakeRunner({ "C:\\repo\\api\\.venv\\Scripts\\ruff.exe": "" });
    const r = await runner.run(req({ language: "python", tool: "ruff", dir: "api/", args: ["check", "."] }));
    expect(r).toEqual({ code: 0, stdout: "ok", stderr: "" });
    expect(started).toEqual([{ file: "uv", args: ["run", "--no-sync", "ruff", "check", "."], cwd: "C:\\repo\\api" }]);
  });

  it("asks for uv sync when the tool is not installed", async () => {
    const { runner, started } = fakeRunner({});
    const m = await missing(runner.run(req({ language: "python", tool: "ruff", dir: "api/" })));
    expect(m.install).toBe("cd api && uv sync");
    expect(m.message).toContain("ruff");
    expect(started).toEqual([]);
  });

  it("uses .venv/bin outside Windows", async () => {
    const { runner, started } = fakeRunner({ "/repo/.venv/bin/ruff": "" }, { cwd: "/repo", platform: "linux" });
    await runner.run(req({ language: "python", tool: "ruff" }));
    expect(started[0]?.cwd).toBe("/repo");
  });

  it("reports a missing uv itself", async () => {
    const enoent: Exec = () => Promise.reject(Object.assign(new Error("spawn uv ENOENT"), { code: "ENOENT" }));
    const { runner } = fakeRunner({ "C:\\repo\\.venv\\Scripts\\ruff.exe": "" }, { exec: enoent });
    expect(await missing(runner.run(req({ language: "python", tool: "ruff" })))).toEqual({
      message: "找不到 uv",
      install: "scoop install uv",
    });
  });
});

describe("tool runner: TypeScript", () => {
  it("runs node_modules/.bin/<tool>.cmd on Windows", async () => {
    const bin = "C:\\repo\\web\\node_modules\\.bin\\eslint.cmd";
    const { runner, started } = fakeRunner({ [bin]: "" });
    await runner.run(req({ language: "typescript", tool: "eslint", dir: "web/", args: ["."] }));
    expect(started).toEqual([{ file: bin, args: ["."], cwd: "C:\\repo\\web" }]);
  });

  it("passes stdin through to the tool", async () => {
    const bin = "C:\\repo\\node_modules\\.bin\\prettier.cmd";
    const { runner, started } = fakeRunner({ [bin]: "" });
    await runner.run(req({ language: "typescript", tool: "prettier", args: ["--stdin-filepath", "a.ts"], stdin: "x" }));
    expect(started).toEqual([{ file: bin, args: ["--stdin-filepath", "a.ts"], cwd: "C:\\repo", stdin: "x" }]);
  });

  it("asks for npm ci when node_modules lacks the tool", async () => {
    const { runner } = fakeRunner({});
    expect((await missing(runner.run(req({ language: "typescript", tool: "eslint" })))).install).toBe("npm ci");
  });

  it("runs node_modules/.bin/<tool> elsewhere", async () => {
    const { runner, started } = fakeRunner({ "/repo/node_modules/.bin/tsc": "" }, { cwd: "/repo", platform: "darwin" });
    await runner.run(req({ language: "typescript", tool: "tsc" }));
    expect(started[0]?.file).toBe("/repo/node_modules/.bin/tsc");
  });
});

describe("tool runner: Go", () => {
  const GO_MOD = [
    "module example.com/app",
    "",
    "go 1.24",
    "",
    "tool honnef.co/go/tools/cmd/staticcheck",
    "tool (",
    "\tgolang.org/x/tools/cmd/stringer",
    ")",
  ].join("\n");

  it("runs tools declared in go.mod with go tool, offline and with the local toolchain", async () => {
    const { runner, started } = fakeRunner({ "C:\\repo\\svc\\go.mod": GO_MOD });
    await runner.run(req({ language: "go", tool: "stringer", dir: "svc/", args: ["-type=X"] }));
    await runner.run(req({ language: "go", tool: "honnef.co/go/tools/cmd/staticcheck", dir: "svc/" }));
    expect(started).toEqual([
      {
        file: "go",
        args: ["tool", "stringer", "-type=X"],
        cwd: "C:\\repo\\svc",
        env: { GOTOOLCHAIN: "local", GOPROXY: "off" },
      },
      {
        file: "go",
        args: ["tool", "honnef.co/go/tools/cmd/staticcheck"],
        cwd: "C:\\repo\\svc",
        env: { GOTOOLCHAIN: "local", GOPROXY: "off" },
      },
    ]);
  });

  it("asks to add the tool to go.mod when it is not declared", async () => {
    const { runner } = fakeRunner({ "C:\\repo\\go.mod": GO_MOD });
    const m = await missing(runner.run(req({ language: "go", tool: "gofumpt" })));
    expect(m.install).toBe("go get -tool <gofumpt 的套件路徑>");
    const noMod = await missing(fakeRunner({}).runner.run(req({ language: "go", tool: "gofumpt" })));
    expect(noMod.message).toContain("go.mod");
  });

  it("finds golangci-lint on PATH instead of go.mod", async () => {
    const exe = "C:\\scoop\\shims\\golangci-lint.exe";
    const { runner, started } = fakeRunner({ [exe]: "" });
    await runner.run(req({ language: "go", tool: "golangci-lint", args: ["run"] }));
    expect(started).toEqual([{ file: exe, args: ["run"], cwd: ROOT, env: { GOTOOLCHAIN: "local" } }]);
  });

  it("passes the requested mirror environment but always keeps the local toolchain", async () => {
    const exe = "C:\\scoop\\shims\\golangci-lint.exe";
    const { runner, started } = fakeRunner({ [exe]: "", "C:\\repo\\go.mod": GO_MOD });
    const env = { GOTOOLCHAIN: "auto", GOPROXY: "https://mirror/", GOSUMDB: "sum.golang.org https://sumdb/" };
    await runner.run(req({ language: "go", tool: "golangci-lint", env }));
    await runner.run(req({ language: "go", tool: "go", args: ["mod", "tidy", "-diff"], env }));
    expect(started.map((c) => c.env)).toEqual([
      { GOTOOLCHAIN: "local", GOPROXY: "https://mirror/", GOSUMDB: "sum.golang.org https://sumdb/" },
      // `go` and `go tool` stay offline: resolving a tool never downloads it.
      { GOTOOLCHAIN: "local", GOPROXY: "off", GOSUMDB: "sum.golang.org https://sumdb/" },
    ]);
  });

  it("asks to install golangci-lint from the internal Scoop bucket when it is not on PATH", async () => {
    const { runner } = fakeRunner({}, { pathEnv: undefined });
    expect((await missing(runner.run(req({ language: "go", tool: "golangci-lint" })))).install).toBe(
      "scoop install golangci-lint",
    );
  });

  it("reports a missing go itself", async () => {
    const enoent: Exec = () => Promise.reject(Object.assign(new Error("spawn go ENOENT"), { code: "ENOENT" }));
    const { runner } = fakeRunner({ "C:\\repo\\go.mod": GO_MOD }, { exec: enoent });
    expect((await missing(runner.run(req({ language: "go", tool: "stringer" })))).message).toBe("找不到 go");
  });

  it("runs go itself for module commands, offline and with the local toolchain", async () => {
    const { runner, started } = fakeRunner({});
    await runner.run(req({ language: "go", tool: "go", dir: "svc/", args: ["mod", "tidy", "-diff"] }));
    expect(started).toEqual([
      {
        file: "go",
        args: ["mod", "tidy", "-diff"],
        cwd: "C:\\repo\\svc",
        env: { GOTOOLCHAIN: "local", GOPROXY: "off" },
      },
    ]);
  });
});

describe("tool runner: Java", () => {
  it("runs the Maven wrapper, preferring it over Gradle", async () => {
    const mvnw = "C:\\repo\\svc\\mvnw.cmd";
    const { runner, started } = fakeRunner({ [mvnw]: "", "C:\\repo\\svc\\gradlew.bat": "" });
    await runner.run(req({ language: "java", tool: "spotless", dir: "svc/", args: ["spotless:check"] }));
    expect(started).toEqual([{ file: mvnw, args: ["spotless:check"], cwd: "C:\\repo\\svc" }]);
  });

  it("falls back to the Gradle wrapper", async () => {
    const { runner, started } = fakeRunner({ "/repo/gradlew": "" }, { cwd: "/repo", platform: "linux" });
    await runner.run(req({ language: "java", tool: "checkstyle", args: ["check"] }));
    expect(started[0]?.file).toBe("/repo/gradlew");
  });

  it("asks to add a wrapper when there is none", async () => {
    const { runner } = fakeRunner({});
    expect((await missing(runner.run(req({ language: "java", tool: "spotless" })))).message).toContain("mvnw");
  });
});

describe("ToolMissingError", () => {
  it("renders the problem and a one-line install command", () => {
    expect(new ToolMissingError("找不到 ruff", "uv sync").report()).toBe("找不到 ruff\n  安裝：uv sync\n");
  });

  it("passes other exec failures through", async () => {
    const boom: Exec = () => Promise.reject(new Error("boom"));
    const { runner } = fakeRunner({ "C:\\repo\\.venv\\Scripts\\ruff.exe": "" }, { exec: boom });
    await expect(runner.run(req({ language: "python", tool: "ruff" }))).rejects.toThrow("boom");
  });
});
