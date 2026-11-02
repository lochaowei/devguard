import { describe, expect, it } from "vitest";
import type { Command, Exec } from "../src/process/exec.ts";
import { createToolRunner, ToolMissingError, type ToolRequest, type ToolRunnerDeps } from "../src/tools/runner.ts";

const ROOT = "C:\\repo";

/**
 * A fake project: `files` maps absolute paths to contents; exec records what it was asked to start, and the
 * variables it was asked to leave out of the environment separately in `unset`.
 */
function fakeRunner(files: Record<string, string>, extra: Partial<ToolRunnerDeps> = {}) {
  const started: Command[] = [];
  const unset: (readonly string[] | undefined)[] = [];
  const exec: Exec = ({ unsetEnv, ...command }) => {
    started.push(command);
    unset.push(unsetEnv);
    return Promise.resolve({ code: 0, stdout: "ok", stderr: "" });
  };
  const runner = createToolRunner({
    cwd: ROOT,
    platform: "win32",
    exec,
    exists: (p) => p in files,
    readText: (p) => files[p],
    pathEnv: "C:\\bin;C:\\scoop\\shims",
    processEnv: {},
    ...extra,
  });
  return { runner, started, unset };
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
    const m = await missing(runner.run(req({ language: "python", tool: "ruff" })));
    expect(m.message).toBe("找不到 uv");
    expect(m.install).toContain("curl -LsSf https://astral.sh/uv/install.sh | sh");
    expect(m.install).toContain('powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"');
    expect(m.install).toContain("pipx install uv");
    expect(m.install).toContain("pip install uv");
    expect(m.install).toContain("scoop install uv");
  });

  it("tells a pip-installed uv that is not on PATH how to reach it (#67)", async () => {
    const enoent: Exec = () => Promise.reject(Object.assign(new Error("spawn uv ENOENT"), { code: "ENOENT" }));
    const { runner } = fakeRunner({ "C:\\repo\\.venv\\Scripts\\ruff.exe": "" }, { exec: enoent });
    const m = await missing(runner.run(req({ language: "python", tool: "ruff" })));
    expect(m.install).toContain("Scripts");
    expect(m.install).toContain("~/.local/bin");
    expect(m.install).toContain("PATH");
    expect(m.install).toContain("uv --version");
  });

  it("indents every line of a multi-line install hint in the report (#67)", async () => {
    const enoent: Exec = () => Promise.reject(Object.assign(new Error("spawn uv ENOENT"), { code: "ENOENT" }));
    const { runner } = fakeRunner({ "C:\\repo\\.venv\\Scripts\\ruff.exe": "" }, { exec: enoent });
    const run = runner.run(req({ language: "python", tool: "ruff" }));
    const report = await run.then(
      () => "",
      (e: unknown) => (e instanceof ToolMissingError ? e.report() : ""),
    );
    const lines = report.trimEnd().split("\n");
    expect(lines[0]).toBe("找不到 uv");
    expect(lines[1]).toMatch(/^ {2}安裝：/);
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines.slice(2)) expect(line).toMatch(/^ {4}\S/);
  });
});

describe("tool runner: Python with UV_PROJECT_ENVIRONMENT (#66)", () => {
  it("finds the tool in a relative project environment, resolved against the project directory", async () => {
    const { runner, started } = fakeRunner(
      { "C:\\repo\\api\\venv\\Scripts\\ruff.exe": "" },
      { processEnv: { UV_PROJECT_ENVIRONMENT: "venv" } },
    );
    await runner.run(req({ language: "python", tool: "ruff", dir: "api/", args: ["check", "."] }));
    expect(started).toEqual([{ file: "uv", args: ["run", "--no-sync", "ruff", "check", "."], cwd: "C:\\repo\\api" }]);
  });

  it("finds the tool in an absolute project environment", async () => {
    const { runner, started } = fakeRunner(
      { "D:\\envs\\api\\Scripts\\ruff.exe": "" },
      { processEnv: { UV_PROJECT_ENVIRONMENT: "D:\\envs\\api" } },
    );
    await runner.run(req({ language: "python", tool: "ruff", dir: "api/" }));
    expect(started[0]?.file).toBe("uv");
  });

  it("uses bin/ of an absolute project environment outside Windows", async () => {
    const { runner, started } = fakeRunner(
      { "/opt/envs/api/bin/ruff": "" },
      { cwd: "/repo", platform: "linux", processEnv: { UV_PROJECT_ENVIRONMENT: "/opt/envs/api" } },
    );
    await runner.run(req({ language: "python", tool: "ruff", dir: "api/" }));
    expect(started[0]?.cwd).toBe("/repo/api");
  });

  it("no longer looks in .venv when the variable points elsewhere", async () => {
    const { runner } = fakeRunner(
      { "C:\\repo\\.venv\\Scripts\\ruff.exe": "" },
      { processEnv: { UV_PROJECT_ENVIRONMENT: "venv" } },
    );
    await missing(runner.run(req({ language: "python", tool: "ruff" })));
  });

  it("names the project environments it looked in when the tool is missing", async () => {
    const { runner } = fakeRunner({}, { processEnv: { UV_PROJECT_ENVIRONMENT: "venv" } });
    const m = await missing(runner.run(req({ language: "python", tool: "ruff", dir: "api/" })));
    expect(m.message).toBe("找不到 ruff：專案環境（C:\\repo\\api\\venv、C:\\repo\\venv）中沒有安裝");
    expect(m.install).toBe("cd api && uv sync");
  });

  it("names the .venv directories it looked in when the variable is unset", async () => {
    const { runner } = fakeRunner({});
    const m = await missing(runner.run(req({ language: "python", tool: "ruff", dir: "api/" })));
    expect(m.message).toBe("找不到 ruff：專案環境（C:\\repo\\api\\.venv、C:\\repo\\.venv）中沒有安裝");
  });

  it("does not apply to Poetry projects, which keep the in-project .venv", async () => {
    const { runner, started } = fakeRunner(
      { "C:\\repo\\poetry.lock": "", "C:\\repo\\.venv\\Scripts\\ruff.exe": "" },
      { processEnv: { UV_PROJECT_ENVIRONMENT: "venv" } },
    );
    await runner.run(req({ language: "python", tool: "ruff" }));
    expect(started[0]?.file).toBe("C:\\repo\\.venv\\Scripts\\ruff.exe");
  });
});

describe("tool runner: Python with Poetry (#44)", () => {
  it("runs the tool from the in-project .venv directly, not through uv", async () => {
    const { runner, started } = fakeRunner({
      "C:\\repo\\api\\poetry.lock": "",
      "C:\\repo\\api\\.venv\\Scripts\\ruff.exe": "",
    });
    await runner.run(req({ language: "python", tool: "ruff", dir: "api/", args: ["check", "."] }));
    expect(started).toEqual([
      { file: "C:\\repo\\api\\.venv\\Scripts\\ruff.exe", args: ["check", "."], cwd: "C:\\repo\\api" },
    ]);
  });

  it("asks for an in-project Poetry environment when the tool is not installed", async () => {
    const { runner } = fakeRunner({ "C:\\repo\\poetry.lock": "" });
    const m = await missing(runner.run(req({ language: "python", tool: "ruff", dir: "api/" })));
    expect(m.install).toBe("cd api && poetry config virtualenvs.in-project true && poetry install");
  });

  it("follows the nearest lockfile: a uv.lock closer to the component wins", async () => {
    const { runner, started } = fakeRunner({
      "C:\\repo\\poetry.lock": "",
      "C:\\repo\\api\\uv.lock": "",
      "C:\\repo\\api\\.venv\\Scripts\\ruff.exe": "",
    });
    await runner.run(req({ language: "python", tool: "ruff", dir: "api/" }));
    expect(started[0]?.file).toBe("uv");
  });
});

describe("tool runner: a Python tool missing from the dev dependencies (#68)", () => {
  const based = { language: "python", tool: "basedpyright", dir: "api/", range: ">=1.40,<2" } as const;
  const PYPROJECT = "C:\\repo\\api\\pyproject.toml";

  it("asks to add it with uv add --dev and the standard's range", async () => {
    const { runner } = fakeRunner({ [PYPROJECT]: '[project]\nname = "api"\n' });
    const m = await missing(runner.run(req(based)));
    expect(m.install).toBe('cd api && uv add --dev "basedpyright>=1.40,<2"');
  });

  it("asks to add it with poetry add --group dev, in-project so devguard finds it, in a Poetry project", async () => {
    const { runner } = fakeRunner({ [PYPROJECT]: '[project]\nname = "api"\n', "C:\\repo\\api\\poetry.lock": "" });
    const m = await missing(runner.run(req(based)));
    expect(m.install).toBe(
      'cd api && poetry config virtualenvs.in-project true && poetry add --group dev "basedpyright>=1.40,<2"',
    );
  });

  it("still asks for uv sync when a dependency group lists it", async () => {
    const toml = '[project]\nname = "api"\n\n[dependency-groups]\ndev = ["basedpyright>=1.40"]\n';
    const { runner } = fakeRunner({ [PYPROJECT]: toml });
    expect((await missing(runner.run(req(based)))).install).toBe("cd api && uv sync");
  });

  it("still asks for poetry install when a Poetry group lists it, under any spelling of its name", async () => {
    const toml = '[tool.poetry.group.dev.dependencies]\nBasedPyright = ">=1.40"\n';
    const { runner } = fakeRunner({ [PYPROJECT]: toml, "C:\\repo\\api\\poetry.lock": "" });
    const m = await missing(runner.run(req(based)));
    expect(m.install).toBe("cd api && poetry config virtualenvs.in-project true && poetry install");
  });

  it("counts a workspace root's pyproject.toml that lists it", async () => {
    const root = '[project]\nname = "ws"\n\n[dependency-groups]\ndev = ["basedpyright"]\n';
    const { runner } = fakeRunner({ [PYPROJECT]: '[project]\nname = "api"\n', "C:\\repo\\pyproject.toml": root });
    expect((await missing(runner.run(req(based)))).install).toBe("cd api && uv sync");
  });

  it("keeps uv sync without a pyproject.toml or without a range to add", async () => {
    expect((await missing(fakeRunner({}).runner.run(req(based)))).install).toBe("cd api && uv sync");
    const { runner } = fakeRunner({ [PYPROJECT]: '[project]\nname = "api"\n' });
    const noRange = { language: "python", tool: "basedpyright", dir: "api/" } as const;
    expect((await missing(runner.run(req(noRange)))).install).toBe("cd api && uv sync");
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

  it("finds hoisted node_modules/.bin, .venv, and build wrappers in ancestor directories", async () => {
    const rootBin = "C:\\repo\\node_modules\\.bin\\eslint.cmd";
    const rootVenv = "C:\\repo\\.venv\\Scripts\\ruff.exe";
    const rootMvnw = "C:\\repo\\mvnw.cmd";
    const { runner, started } = fakeRunner({ [rootBin]: "", [rootVenv]: "", [rootMvnw]: "" });
    await runner.run(req({ language: "typescript", tool: "eslint", dir: "packages/web/", args: ["."] }));
    await runner.run(req({ language: "python", tool: "ruff", dir: "services/api/", args: ["check"] }));
    await runner.run(req({ language: "java", tool: "spotless", dir: "modules/core/", args: ["spotless:check"] }));
    expect(started).toEqual([
      { file: rootBin, args: ["."], cwd: "C:\\repo\\packages\\web" },
      { file: "uv", args: ["run", "--no-sync", "ruff", "check"], cwd: "C:\\repo\\services\\api" },
      { file: rootMvnw, args: ["spotless:check"], cwd: "C:\\repo\\modules\\core" },
    ]);
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

  it("asks to put golangci-lint on PATH when it is missing", async () => {
    const { runner } = fakeRunner({}, { pathEnv: undefined });
    expect((await missing(runner.run(req({ language: "go", tool: "golangci-lint" })))).install).toBe(
      "把預設標準指定版本的 golangci-lint binary 放進 PATH",
    );
  });

  it("reports a missing go itself", async () => {
    const enoent: Exec = () => Promise.reject(Object.assign(new Error("spawn go ENOENT"), { code: "ENOENT" }));
    const { runner } = fakeRunner({ "C:\\repo\\go.mod": GO_MOD }, { exec: enoent });
    expect(await missing(runner.run(req({ language: "go", tool: "stringer" })))).toEqual({
      message: "找不到 go",
      install: "scoop install go",
    });
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

describe("tool runner: package-manager commands go through the internal mirror (SPEC §5.5)", () => {
  const MIRROR = "https://nexus.example.internal/repository/proxy/";

  it("Python: uv with the mirror as its default index", async () => {
    const { runner, started } = fakeRunner({});
    await runner.manage({
      language: "python",
      dir: "api/",
      args: ["add", "--dev", "ruff>=0.18,<0.19"],
      mirror: MIRROR,
    });
    expect(started).toEqual([
      {
        file: "uv",
        args: ["add", "--dev", "ruff>=0.18,<0.19"],
        cwd: "C:\\repo\\api",
        env: { UV_DEFAULT_INDEX: MIRROR },
      },
    ]);
  });

  it("Python with Poetry: poetry, which reads the mirror from [[tool.poetry.source]], never uv (#53)", async () => {
    const { runner, started } = fakeRunner({});
    await runner.manage({
      language: "python",
      manager: "poetry",
      dir: "api/",
      args: ["add", "--group", "dev", "ruff>=0.18,<0.19"],
    });
    expect(started).toEqual([
      { file: "poetry", args: ["add", "--group", "dev", "ruff>=0.18,<0.19"], cwd: "C:\\repo\\api" },
    ]);
  });

  it("uv still refuses to run without a mirror", async () => {
    const { runner, started } = fakeRunner({});
    await expect(runner.manage({ language: "python", dir: "", args: ["add"] })).rejects.toThrow("內部鏡像");
    expect(started).toEqual([]);
  });

  it("Python with Poetry: reports a missing poetry with an install hint instead of falling back to uv", async () => {
    const enoent: Exec = () => Promise.reject(Object.assign(new Error("spawn poetry ENOENT"), { code: "ENOENT" }));
    const { runner } = fakeRunner({}, { exec: enoent });
    const request = { language: "python", manager: "poetry", dir: "", args: ["add"] } as const;
    expect(await missing(runner.manage(request))).toEqual({
      message: "找不到 poetry",
      install: "scoop install poetry",
    });
  });

  it("TypeScript: npm from PATH with the mirror as its registry", async () => {
    const { runner, started } = fakeRunner({ "C:\\scoop\\shims\\npm.cmd": "" });
    await runner.manage({
      language: "typescript",
      dir: "",
      args: ["install", "-D", "eslint@>=10 <11"],
      mirror: MIRROR,
    });
    expect(started).toEqual([
      {
        file: "C:\\scoop\\shims\\npm.cmd",
        args: ["install", "-D", "eslint@>=10 <11"],
        cwd: "C:\\repo",
        env: { npm_config_registry: MIRROR },
      },
    ]);
  });

  it("TypeScript: reports a missing npm", async () => {
    const { runner } = fakeRunner({});
    const m = await missing(runner.manage({ language: "typescript", dir: "", args: ["install"], mirror: MIRROR }));
    expect(m.message).toContain("npm");
  });

  it("Go: go with GOPROXY and the checksum database through the mirror, never the toolchain download", async () => {
    const { runner, started } = fakeRunner({});
    await runner.manage({
      language: "go",
      dir: "",
      args: ["get", "-tool", "x@v1"],
      mirror: MIRROR,
      sumdb: "https://s/",
    });
    expect(started[0]).toMatchObject({
      file: "go",
      env: { GOTOOLCHAIN: "local", GOPROXY: MIRROR, GOSUMDB: "sum.golang.org https://s/" },
    });
  });

  it("refuses to run without a mirror, and for Java (build files are edited by hand)", async () => {
    const { runner, started } = fakeRunner({});
    await expect(runner.manage({ language: "python", dir: "", args: ["add"], mirror: "" })).rejects.toThrow("鏡像");
    await expect(runner.manage({ language: "java", dir: "", args: [], mirror: MIRROR })).rejects.toThrow("Java");
    expect(started).toEqual([]);
  });
});

describe("tool runner: git's repo-location variables stay out of project tools (SPEC §7.4, #59)", () => {
  it("unsets them for every tool and package-manager command", async () => {
    const { runner, unset } = fakeRunner({
      "C:\\repo\\.venv\\Scripts\\ruff.exe": "",
      "C:\\repo\\node_modules\\.bin\\eslint.cmd": "",
      "C:\\repo\\go.mod": "module m\ntool golang.org/x/tools/cmd/goimports\n",
      "C:\\repo\\mvnw.cmd": "",
      "C:\\bin\\npm.cmd": "",
    });
    await runner.run(req({ language: "python", tool: "ruff" }));
    await runner.run(req({ language: "typescript", tool: "eslint", stdin: "staged" }));
    await runner.run(req({ language: "go", tool: "goimports" }));
    await runner.run(req({ language: "java", tool: "spotless" }));
    await runner.manage({
      language: "typescript",
      dir: "",
      args: ["install"],
      mirror: "https://npm.example.internal/",
    });
    const gitRepoEnv = [
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_COMMON_DIR",
      "GIT_DIR",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_PREFIX",
      "GIT_WORK_TREE",
    ];
    expect(unset.map((names) => [...(names ?? [])].sort())).toEqual(Array.from({ length: 5 }, () => gitRepoEnv));
  });
});
