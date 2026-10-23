import { describe, expect, it } from "vitest";
import { editConfigText } from "../src/fix/edit.ts";

const PYPROJECT = `# Project metadata
[project]
name = "app"  # the package name
requires-python = ">=3.12"

# Lint settings, keep in sync with the team
[tool.ruff]
line-length = 100 # too wide?

[tool.ruff.lint]
select = ["E", "F"]

[[tool.uv.index]]
name = "nexus"
url = "https://nexus.example.internal/repository/pypi-proxy/simple"
default = true

[[tool.uv.index]]
name = "extra"
url = "https://nexus.example.internal/repository/pypi-extra/simple"
`;

describe("editConfigText: TOML (SPEC §13 T1)", () => {
  it("changes only the managed keys and keeps comments, blank lines, order and [[tool.uv.index]]", () => {
    const out = editConfigText("pyproject.toml", PYPROJECT, [
      { op: "set", path: ["tool", "ruff", "line-length"], value: 120 },
      { op: "add", path: ["tool", "ruff", "lint", "select"], value: "B" },
      { op: "set", path: ["tool", "coverage", "run", "branch"], value: true },
    ]);
    const expected = PYPROJECT.replace("line-length = 100", "line-length = 120").replace(
      'select = ["E", "F"]',
      'select = ["E", "F", "B"]',
    );
    expect(out.startsWith(expected.trimEnd())).toBe(true);
    expect(out).toMatch(/\[tool\.coverage\.run\]\s*\nbranch = true/);
  });

  it("edits a key inside one [[tool.uv.index]] entry and leaves the other entry alone", () => {
    const out = editConfigText("pyproject.toml", PYPROJECT, [
      { op: "set", path: ["tool", "uv", "index", 0, "authenticate"], value: "always" },
    ]);
    expect(out.startsWith(PYPROJECT.slice(0, PYPROJECT.indexOf("default = true")))).toBe(true);
    expect(out).toMatch(/default = true\s*\nauthenticate = "always"\s*\n\s*\[\[tool\.uv\.index\]\]\nname = "extra"/);
  });

  it("deletes a key", () => {
    const out = editConfigText("pyproject.toml", '[tool.ruff]\nextend-select = ["B"]\nline-length = 120\n', [
      { op: "delete", path: ["tool", "ruff", "extend-select"] },
    ]);
    expect(out).toBe("[tool.ruff]\nline-length = 120\n");
  });

  it("creates the file content from nothing", () => {
    const out = editConfigText("pyproject.toml", "", [{ op: "set", path: ["tool", "mypy", "strict"], value: true }]);
    expect(out).toMatch(/\[tool\.mypy\]\s*\nstrict = true/);
  });
});

describe("editConfigText: JSONC", () => {
  it("sets nested keys and keeps comments and order", () => {
    const text =
      '{\n  // base options\n  "extends": "./base.json",\n  "compilerOptions": {\n    "strict": false, // legacy\n    "target": "es2022"\n  }\n}\n';
    const out = editConfigText("tsconfig.json", text, [
      { op: "set", path: ["compilerOptions", "strict"], value: true },
      { op: "set", path: ["compilerOptions", "noImplicitOverride"], value: true },
    ]);
    expect(out).toContain("// base options");
    expect(out).toContain('"strict": true, // legacy');
    expect(out.indexOf('"extends"')).toBeLessThan(out.indexOf('"compilerOptions"'));
    expect(out).toContain('"noImplicitOverride": true');
  });

  it("treats a .prettierrc that starts with { as JSON", () => {
    const out = editConfigText(".prettierrc", '{ "printWidth": 80 }\n', [
      { op: "set", path: ["printWidth"], value: 120 },
    ]);
    expect(JSON.parse(out)).toEqual({ printWidth: 120 });
  });
});

describe("editConfigText: YAML", () => {
  it("adds to a list and sets nested keys, keeping comments", () => {
    const text = '# golangci config\nversion: "2"\nlinters:\n  enable: [gosec] # security first\n  disable: [cyclop]\n';
    const out = editConfigText(".golangci.yml", text, [
      { op: "add", path: ["linters", "enable"], value: "cyclop" },
      { op: "remove", path: ["linters", "disable"], value: "cyclop" },
      { op: "set", path: ["linters", "settings", "cyclop", "max-complexity"], value: 10 },
    ]);
    expect(out).toContain("# golangci config");
    expect(out).toContain("# security first");
    expect(out).toContain("enable: [ gosec, cyclop ]");
    expect(out).toContain("disable: []");
    expect(out).toMatch(/cyclop:\n\s+max-complexity: 10/);
  });

  it("treats a .prettierrc that is not JSON as YAML", () => {
    const out = editConfigText(".prettierrc", "printWidth: 80 # narrow\n", [
      { op: "set", path: ["printWidth"], value: 120 },
    ]);
    expect(out).toBe("printWidth: 120 # narrow\n");
  });
});

describe("editConfigText: line files", () => {
  it("appends a missing line once and keeps the rest", () => {
    const out = editConfigText(".gitattributes", "*.png binary", [
      { op: "line", value: "* text=auto eol=lf" },
      { op: "line", value: "* text=auto eol=lf" },
    ]);
    expect(out).toBe("*.png binary\n* text=auto eol=lf\n");
  });
});

describe("editConfigText: [[tool.uv.index]] and .npmrc (SPEC §10.2)", () => {
  const nexus = { name: "nexus", url: "https://nexus.example.internal/repository/pypi-proxy/simple", default: true };

  it("appends a new array of tables as a [[...]] block, also under an existing [tool.uv]", () => {
    const add = { op: "add", path: ["tool", "uv", "index"], value: nexus } as const;
    const expected = `[[tool.uv.index]]\nname = "nexus"\nurl = "${nexus.url}"\ndefault = true\n`;
    expect(editConfigText("pyproject.toml", "", [add])).toBe(expected);
    const text = '[project]\nname = "a"\n\n[tool.uv]\npackage = false\n';
    expect(editConfigText("pyproject.toml", text, [add, add])).toBe(`${text}\n${expected}`);
  });

  it("sets and deletes .npmrc keys in place and keeps comments", () => {
    const text = "# registry\nregistry=https://registry.npmjs.org/\r\nsave-exact=true\n";
    const out = editConfigText(".npmrc", text, [
      { op: "set", path: ["registry"], value: "https://nexus/" },
      { op: "delete", path: ["save-exact"] },
      { op: "set", path: ["//nexus/:_auth"], value: "${NEXUS_NPM_AUTH}" },
    ]);
    expect(out).toBe("# registry\nregistry=https://nexus/\n//nexus/:_auth=${NEXUS_NPM_AUTH}\n");
  });
});
