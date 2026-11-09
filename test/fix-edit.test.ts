import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { editConfigText, parseConfigText } from "../src/fix/edit.ts";

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
    const topLevel = editConfigText("ruff.toml", "", [{ op: "set", path: ["line-length"], value: 120 }]);
    expect(topLevel).toBe("line-length = 120\n");
  });

  it("appends [tool.ruff] when only [tool.ruff.lint] exists in the file", () => {
    const text = '[project]\nname = "app"\n\n[tool.ruff.lint]\nselect = ["E"]\n';
    const out = editConfigText("pyproject.toml", text, [
      { op: "set", path: ["tool", "ruff", "line-length"], value: 120 },
    ]);
    expect(out.startsWith('[project]\nname = "app"')).toBe(true);
    expect(out).toContain("[tool.ruff]\nline-length = 120\n");
  });

  it("edits a table defined by dotted keys in place, applying every add to the same key (#105)", () => {
    const text = '[tool.ruff]\nline-length = 120\nlint.select = ["E", "W", "F"]\n';
    const out = editConfigText(
      "pyproject.toml",
      text,
      ["B", "C90", "SIM", "N", "S"].map((value) => ({ op: "add", path: ["tool", "ruff", "lint", "select"], value })),
    );
    expect(out).toBe('[tool.ruff]\nline-length = 120\nlint.select = ["E", "W", "F", "B", "C90", "SIM", "N", "S"]\n');
  });

  it("edits an inline table in place", () => {
    const out = editConfigText("pyproject.toml", '[tool.ruff]\nlint = { select = ["E"] }\n', [
      { op: "add", path: ["tool", "ruff", "lint", "select"], value: "S" },
    ]);
    expect(out).toBe('[tool.ruff]\nlint = { select = ["E", "S"] }\n');
  });

  it("adds a new sub-table of a dotted-key table as its own valid section", () => {
    const text = '[tool.ruff]\nlint.select = ["E"]\n';
    const out = editConfigText("pyproject.toml", text, [
      { op: "add", path: ["tool", "ruff", "lint", "per-file-ignores", "tests/**"], value: "S101" },
    ]);
    expect(out).toBe(`${text}\n[tool.ruff.lint.per-file-ignores]\n"tests/**" = [ "S101" ]\n`);
    expect(parseConfigText("pyproject.toml", out)).toEqual({
      tool: { ruff: { lint: { select: ["E"], "per-file-ignores": { "tests/**": ["S101"] } } } },
    });
  });

  it("puts two adds to a new sub-table of a dotted-key table in one section", () => {
    const text = '[tool.ruff]\nlint.select = ["E"]\n';
    const out = editConfigText("pyproject.toml", text, [
      { op: "add", path: ["tool", "ruff", "lint", "per-file-ignores", "tests/**"], value: "S101" },
      { op: "add", path: ["tool", "ruff", "lint", "per-file-ignores", "scripts/**"], value: "T201" },
    ]);
    expect(out.match(/\[tool\.ruff\.lint\.per-file-ignores\]/g)).toHaveLength(1);
    expect(parseConfigText("pyproject.toml", out)).toEqual({
      tool: {
        ruff: { lint: { select: ["E"], "per-file-ignores": { "tests/**": ["S101"], "scripts/**": ["T201"] } } },
      },
    });
  });

  it("sets a value holding nested tables under a new section at its full path (#85)", () => {
    const text = 'version = "2"\n\n[linters]\nenable = ["gosec"]\n';
    const rules = { main: { deny: [{ pkg: "io/ioutil", desc: "use io" }] } };
    const out = editConfigText(".golangci.toml", text, [
      { op: "set", path: ["linters", "settings", "depguard", "rules"], value: rules },
    ]);
    expect(out).toContain("[linters.settings.depguard.rules.main]");
    expect(parseConfigText(".golangci.toml", out)).toEqual({
      version: "2",
      linters: { enable: ["gosec"], settings: { depguard: { rules } } },
    });
  });

  it("puts nested tables with bracketed quoted keys and bracketed string lines under the section (#85)", () => {
    const text = 'version = "2"\n';
    const rules = { "main]x": { desc: "line\n[other]\n[[more]]", deny: [{ pkg: "io/ioutil" }] }, "[odd]": { k: 1 } };
    const out = editConfigText(".golangci.toml", text, [
      { op: "set", path: ["linters", "settings", "depguard", "rules"], value: rules },
    ]);
    expect(parseConfigText(".golangci.toml", out)).toEqual({
      version: "2",
      linters: { settings: { depguard: { rules } } },
    });
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

  it("writes new short arrays of plain values on one line, as Prettier prints them", () => {
    const long = Array.from({ length: 8 }, (_, i) => `entry-number-${String(i)}`);
    const out = editConfigText(".vscode/tasks.json", "", [
      { op: "add", path: ["recommendations"], value: "a.b" },
      { op: "add", path: ["recommendations"], value: "c.d" },
      { op: "add", path: ["tasks"], value: { label: "x", args: ["doctor", "--quiet"], long } },
    ]);
    expect(out).toContain('"recommendations": ["a.b", "c.d"]');
    expect(out).toContain('      "args": ["doctor", "--quiet"],');
    expect(out).toContain('      "long": [\n        "entry-number-0",');
    expect(JSON.parse(out)).toMatchObject({ recommendations: ["a.b", "c.d"], tasks: [{ long }] });
  });

  it("lays arrays out for the print width the edit asks for", () => {
    const value = ["dbaeumer.vscode-eslint", "esbenp.prettier-vscode", "vitest.explorer"];
    const edit = (printWidth?: number) =>
      editConfigText("x.json", "", [{ op: "set", path: ["recommendations"], value, layout: { printWidth } }]);
    expect(edit(120)).toContain('"recommendations": ["dbaeumer');
    expect(edit()).toContain('"recommendations": [\n');
  });

  describe("appending after a last property with a trailing comment (#121)", () => {
    const add = (text: string) =>
      editConfigText("tsconfig.json", text, [
        { op: "set", path: ["compilerOptions", "noImplicitOverride"], value: true },
        { op: "set", path: ["compilerOptions", "noFallthroughCasesInSwitch"], value: true },
      ]);

    it("keeps the last line of a tsc --init tsconfig (elysia), comment and alignment, and adds below it", () => {
      const text = readFileSync(join(import.meta.dirname, "fixtures/typescript/elysia-tsconfig.json"), "utf8");
      const out = add(text);
      expect(out).toContain(
        '    "skipLibCheck": true,                                 /* Skip type checking all .d.ts files. */\n' +
          '    "noImplicitOverride": true,\n    "noFallthroughCasesInSwitch": true,\n  },\n',
      );
      expect(out.replace(/ {4}"no(ImplicitOverride|FallthroughCasesInSwitch)": true,\n/g, "")).toBe(text);
      expect(parseConfigText("tsconfig.json", out)).toMatchObject({
        compilerOptions: { skipLibCheck: true, noImplicitOverride: true, noFallthroughCasesInSwitch: true },
      });
    });

    it("keeps a // comment on the last line", () => {
      const out = add('{\n  "compilerOptions": {\n    "strict": true, // the team default\n  }\n}\n');
      expect(out).toBe(
        '{\n  "compilerOptions": {\n    "strict": true, // the team default\n' +
          '    "noImplicitOverride": true,\n    "noFallthroughCasesInSwitch": true,\n  }\n}\n',
      );
    });

    it("puts the missing comma after the value and before the comment", () => {
      const out = add('{\n  "compilerOptions": {\n    "strict": true /* on */ // really\n  }\n}\n');
      expect(out).toBe(
        '{\n  "compilerOptions": {\n    "strict": true, /* on */ // really\n' +
          '    "noImplicitOverride": true,\n    "noFallthroughCasesInSwitch": true\n  }\n}\n',
      );
    });

    it("adds right after the last property, before comment lines that follow it", () => {
      const out = add('{\n  "compilerOptions": {\n    "strict": true // on\n    // "noEmit": true\n  }\n}\n');
      expect(out).toBe(
        '{\n  "compilerOptions": {\n    "strict": true, // on\n    "noImplicitOverride": true,\n' +
          '    "noFallthroughCasesInSwitch": true\n    // "noEmit": true\n  }\n}\n',
      );
    });

    it("does the same in a CRLF file", () => {
      const out = add('{\r\n  "compilerOptions": {\r\n    "strict": true, // on\r\n  }\r\n}\r\n');
      expect(out).toBe(
        '{\r\n  "compilerOptions": {\r\n    "strict": true, // on\r\n    "noImplicitOverride": true,\r\n' +
          '    "noFallthroughCasesInSwitch": true,\r\n  }\r\n}\r\n',
      );
    });

    it("writes a last property without a comment as before", () => {
      const out = add('{\n  "compilerOptions": {\n    "strict": true\n  }\n}\n');
      expect(out).toBe(
        '{\n  "compilerOptions": {\n    "strict": true,\n    "noImplicitOverride": true,\n' +
          '    "noFallthroughCasesInSwitch": true\n  }\n}\n',
      );
    });
  });

  it("leaves arrays already in the file as they are", () => {
    const text = '{\n  "a": [\n    1\n  ]\n}\n';
    expect(editConfigText("x.json", text, [{ op: "set", path: ["b"], value: true }])).toContain('"a": [\n    1\n  ]');
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
    expect(out).toContain("enable: [gosec, cyclop] # security first");
    expect(out).toContain("disable: []");
    expect(out).toMatch(/cyclop:\n\s+max-complexity: 10/);
  });

  describe("keeps the lines an edit does not touch byte for byte (#87)", () => {
    const GOLANGCI = [
      'version: "2"',
      "linters:",
      "  disable:",
      "    - lll         # too noisy",
      "    - wsl         # style",
      "  exclusions:",
      "    rules:",
      "      - linters: [revive]",
      "        path: _test\\.go",
      "",
    ].join("\n");
    const addGosec = [{ op: "add" as const, path: ["linters", "enable"], value: "gosec" }];
    /** The output's lines with the original's removed in order; fails if an original line is missing or changed. */
    const added = (original: string, out: string) => {
      const lines = out.split("\n");
      const extra: string[] = [];
      let i = 0;
      for (const line of original.split("\n")) {
        while (i < lines.length && lines[i] !== line) extra.push(lines[i++] ?? "");
        expect(i, `kept: ${line}`).toBeLessThan(lines.length);
        i++;
      }
      return [...extra, ...lines.slice(i)];
    };

    it("keeps comment alignment and unpadded flow sequences, adding only the new lines", () => {
      const out = editConfigText(".golangci.yml", GOLANGCI, addGosec);
      expect(added(GOLANGCI, out)).toEqual(["  enable:", "    - gosec"]);
      expect(parseConfigText(".golangci.yml", out)).toEqual({
        version: "2",
        linters: {
          disable: ["lll", "wsl"],
          exclusions: { rules: [{ linters: ["revive"], path: "_test\\.go" }] },
          enable: ["gosec"],
        },
      });
    });

    it("keeps a padded flow sequence padded", () => {
      const padded = GOLANGCI.replace("[revive]", "[ revive ]");
      expect(added(padded, editConfigText(".golangci.yml", padded, addGosec))).toEqual(["  enable:", "    - gosec"]);
    });

    it("keeps quotes and flow sequences in .pre-commit-config.yaml hooks it does not touch", () => {
      const config = [
        "repos:",
        "  - repo: https://github.com/astral-sh/ruff-pre-commit",
        "    rev: v0.6.0",
        "    hooks:",
        "      - id: ruff",
        '        args: ["--fix"]',
        "      - id: ruff-format",
        "        args: [--check]",
        "        types: [python]",
        '        additional_dependencies: ["pyright@1.1.413"]',
        "",
      ].join("\n");
      const local = { repo: "local", hooks: [{ id: "devguard", entry: "devguard hook git-pre-commit" }] };
      const out = editConfigText(".pre-commit-config.yaml", config, [{ op: "add", path: ["repos"], value: local }]);
      expect(added(config, out).length).toBeGreaterThan(0);
      const padded = config.replace("[--check]", "[ --check, --diff ]");
      const again = editConfigText(".pre-commit-config.yaml", padded, [{ op: "add", path: ["repos"], value: local }]);
      expect(again).toContain("        args: [ --check, --diff ]\n");
    });

    it("keeps lefthook.yml lines the same way", () => {
      const lefthook =
        'pre-commit:\n  parallel: true   # speed\n  jobs:\n    - run: ruff check {staged_files}\n      glob: ["*.py"]\n';
      const out = editConfigText("lefthook.yml", lefthook, [
        { op: "add", path: ["pre-commit", "jobs"], value: { name: "devguard", run: "devguard hook git-pre-commit" } },
      ]);
      expect(added(lefthook, out)).toEqual(["    - name: devguard", "      run: devguard hook git-pre-commit"]);
    });

    it("writes LF for a CRLF original, keeping its lines", () => {
      const crlf = GOLANGCI.replace(/\n/g, "\r\n");
      const out = editConfigText(".golangci.yml", crlf, addGosec);
      expect(added(crlf, out.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n")).length).toBe(2);
    });
  });

  it("does not put back a line whose edit changed only whitespace in a value", () => {
    const text = "name: a  b # two spaces\nlevel: 1     # aligned\n";
    const out = editConfigText("x.yml", text, [{ op: "set", path: ["name"], value: "a b" }]);
    expect(parseConfigText("x.yml", out)).toEqual({ name: "a b", level: 1 });
    expect(out).toContain("level: 1     # aligned\n");
  });

  it("does not put back a line where it would no longer parse", () => {
    const out = editConfigText("x.yml", "a:\n- x\nb: 1\n", [
      { op: "delete", path: ["a"] },
      { op: "set", path: ["b"], value: { c: ["x"] } },
    ]);
    expect(parseConfigText("x.yml", out)).toEqual({ b: { c: ["x"] } });
  });

  it("treats a .prettierrc that is not JSON as YAML", () => {
    const out = editConfigText(".prettierrc", "printWidth: 80 # narrow\n", [
      { op: "set", path: ["printWidth"], value: 120 },
    ]);
    expect(out).toBe("printWidth: 120 # narrow\n");
  });

  it("does not wrap long lines in existing YAML sections", () => {
    const longRule =
      'version: "2"\nlinters:\n  exclusions:\n    rules:\n      - path: foo_test\\.go\n        text: "very-long-pattern-that-exceeds-eighty-columns-and-must-not-be-wrapped-by-yaml-stringify"\n';
    const out = editConfigText(".golangci.yml", longRule, [
      { op: "set", path: ["linters", "settings", "gocognit", "min-complexity"], value: 15 },
    ]);
    expect(out).toContain(
      'text: "very-long-pattern-that-exceeds-eighty-columns-and-must-not-be-wrapped-by-yaml-stringify"',
    );
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

  it("keeps a CRLF file CRLF when editing JSONC, TOML, YAML, and line files (#84)", () => {
    const jsonOut = editConfigText(
      "tsconfig.json",
      '{\r\n  "compilerOptions": {\r\n    "strict": false\r\n  }\r\n}\r\n',
      [{ op: "set", path: ["compilerOptions", "noImplicitOverride"], value: true }],
    );
    expect(jsonOut).toBe(
      '{\r\n  "compilerOptions": {\r\n    "strict": false,\r\n    "noImplicitOverride": true\r\n  }\r\n}\r\n',
    );

    const tomlOut = editConfigText("ruff.toml", "line-length = 100\r\n", [
      { op: "set", path: ["line-length"], value: 120 },
    ]);
    expect(tomlOut).toBe("line-length = 120\r\n");

    const yamlOut = editConfigText(".golangci.yml", 'version: "2"\r\nrun:\r\n  timeout: 1m\r\n', [
      { op: "set", path: ["run", "timeout"], value: "5m" },
    ]);
    expect(yamlOut).toBe('version: "2"\r\nrun:\r\n  timeout: 5m\r\n');

    const lineOut = editConfigText(".gitattributes", "*.png binary\r\n", [{ op: "line", value: "* text=auto eol=lf" }]);
    expect(lineOut).toBe("*.png binary\r\n* text=auto eol=lf\r\n");
  });

  it("keeps an LF file LF, and writes a new file with LF", () => {
    const lf = editConfigText("tsconfig.json", '{\n  "compilerOptions": {}\n}\n', [
      { op: "set", path: ["compilerOptions", "strict"], value: true },
    ]);
    expect(lf).not.toContain("\r");
    const created = editConfigText("tsconfig.json", "", [
      { op: "set", path: ["compilerOptions", "strict"], value: true },
    ]);
    expect(created).not.toContain("\r");
  });
});

describe("editConfigText: arrays of tables", () => {
  const nexus = { name: "nexus", url: "https://nexus.example.internal/repository/pypi-proxy/simple", default: true };

  it("appends a new array of tables as a [[...]] block, also under an existing [tool.uv]", () => {
    const add = { op: "add", path: ["tool", "uv", "index"], value: nexus } as const;
    const expected = `[[tool.uv.index]]\nname = "nexus"\nurl = "${nexus.url}"\ndefault = true\n`;
    expect(editConfigText("pyproject.toml", "", [add])).toBe(expected);
    const text = '[project]\nname = "a"\n\n[tool.uv]\npackage = false\n';
    expect(editConfigText("pyproject.toml", text, [add, add])).toBe(`${text}\n${expected}`);
  });
});
