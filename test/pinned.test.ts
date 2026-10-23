import { describe, expect, it } from "vitest";
import { pinnedVersions } from "../src/versions/pinned.ts";

const files =
  (map: Record<string, string>) =>
  (path: string): string | undefined =>
    map[path];

describe("pinnedVersions", () => {
  it("reads exact versions from uv.lock", () => {
    const uvLock = [
      "version = 1",
      'requires-python = ">=3.11"',
      "",
      "[[package]]",
      'name = "ruff"',
      'version = "0.17.4"',
      'source = { registry = "https://pypi.org/simple" }',
      "",
      "[[package]]",
      'name = "mypy"',
      'version = "1.18.2"',
      "dependencies = [",
      '    { name = "typing-extensions" },',
      "]",
    ].join("\n");
    const pinned = pinnedVersions("python", "svc/", files({ "svc/uv.lock": uvLock }));
    expect(pinned?.file).toBe("svc/uv.lock");
    expect(Object.fromEntries(pinned?.versions ?? [])).toEqual({ ruff: "0.17.4", mypy: "1.18.2" });
  });

  it("falls back to poetry.lock and walks ancestor directories for Python sub-components", () => {
    const poetry = '[[package]]\nname = "ruff"\nversion = "0.17.1"\ndescription = "x"\n';
    expect(pinnedVersions("python", "", files({ "poetry.lock": poetry }))?.versions.get("ruff")).toBe("0.17.1");
    const sub = pinnedVersions("python", "packages/a/", files({ "poetry.lock": poetry }));
    expect(sub?.file).toBe("poetry.lock");
    expect(sub?.versions.get("ruff")).toBe("0.17.1");
  });

  it("reads the installed top-level packages from package-lock.json, up to the workspace root", () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { devDependencies: { eslint: "^10.1.0" } },
        "node_modules/eslint": { version: "10.13.0", dev: true },
        "node_modules/@biomejs/biome": { version: "2.3.1", dev: true },
        "node_modules/eslint/node_modules/debug": { version: "4.4.0" },
        "web/node_modules/prettier": { version: "3.9.10", dev: true },
        "web/node_modules/typescript": { version: "6.0.3", dev: true },
        "node_modules/typescript": { version: "5.9.0", dev: true },
      },
    });
    const pinned = pinnedVersions("typescript", "web/", files({ "package-lock.json": lock }));
    expect(pinned?.file).toBe("package-lock.json");
    expect(Object.fromEntries(pinned?.versions ?? [])).toEqual({
      eslint: "10.13.0",
      "@biomejs/biome": "2.3.1",
      prettier: "3.9.10",
      typescript: "6.0.3",
    });
  });

  it("reads go.mod tool directives with the version of the module that provides each", () => {
    const goMod = [
      "module example.com/svc",
      "",
      "go 1.26",
      "",
      "tool (",
      "\tmvdan.cc/gofumpt",
      "\tgolang.org/x/tools/cmd/goimports // formatter",
      ")",
      "tool golang.org/x/vuln/cmd/govulncheck",
      "",
      "require github.com/stretchr/testify v1.10.0",
      "require (",
      "\tgolang.org/x/tools v0.38.0 // indirect",
      "\tgolang.org/x/tools/gopls v0.20.0 // indirect",
      "\tmvdan.cc/gofumpt v0.9.1",
      ")",
    ].join("\r\n");
    const pinned = pinnedVersions("go", "backend/", files({ "backend/go.mod": goMod }));
    expect(pinned?.file).toBe("backend/go.mod");
    expect(Object.fromEntries(pinned?.versions ?? [])).toEqual({
      "mvdan.cc/gofumpt": "v0.9.1",
      "golang.org/x/tools/cmd/goimports": "v0.38.0",
    });
  });

  it("reads Maven plugin versions from pom.xml, resolving properties", () => {
    const pom = `<project>
  <properties>
    <checkstyle.plugin.version>3.6.0</checkstyle.plugin.version>
  </properties>
  <dependencies>
    <dependency><groupId>org.junit</groupId><artifactId>junit-bom</artifactId><version>5.11.0</version></dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-checkstyle-plugin</artifactId>
        <version>\${checkstyle.plugin.version}</version>
        <dependencies>
          <dependency><artifactId>checkstyle</artifactId><version>10.21.0</version></dependency>
        </dependencies>
      </plugin>
      <plugin>
        <groupId>com.diffplug.spotless</groupId>
        <artifactId>spotless-maven-plugin</artifactId>
        <version>2.44.0</version>
      </plugin>
      <plugin><artifactId>maven-pmd-plugin</artifactId><version>\${missing}</version></plugin>
      <plugin><artifactId>jacoco-maven-plugin</artifactId></plugin>
    </plugins>
  </build>
</project>`;
    const pinned = pinnedVersions("java", "api/", files({ "api/pom.xml": pom }));
    expect(pinned?.file).toBe("api/pom.xml");
    expect(Object.fromEntries(pinned?.versions ?? [])).toEqual({
      "maven-checkstyle-plugin": "3.6.0",
      "spotless-maven-plugin": "2.44.0",
    });
  });

  it("reads Gradle plugin versions and the toolVersion of the built-in code quality plugins", () => {
    const kts = `plugins {
    java
    checkstyle
    id("com.diffplug.spotless") version "7.0.2"
}
checkstyle {
    toolVersion = "10.21.0"
}
jacoco { toolVersion = "0.8.12" }
`;
    const groovy = `plugins {
    id 'com.diffplug.spotless' version '6.25.0'
}
pmd {
    toolVersion '7.9.0'
}
`;
    const fromKts = pinnedVersions("java", "", files({ "build.gradle.kts": kts }));
    expect(fromKts?.file).toBe("build.gradle.kts");
    expect(Object.fromEntries(fromKts?.versions ?? [])).toEqual({
      "com.diffplug.spotless": "7.0.2",
      checkstyle: "10.21.0",
      jacoco: "0.8.12",
    });
    const fromGroovy = pinnedVersions("java", "", files({ "build.gradle": groovy }));
    expect(Object.fromEntries(fromGroovy?.versions ?? [])).toEqual({ "com.diffplug.spotless": "6.25.0", pmd: "7.9.0" });
  });

  it("returns nothing without a lockfile, or with one that is not JSON", () => {
    expect(pinnedVersions("typescript", "web/", files({}))).toBeUndefined();
    expect(pinnedVersions("python", "", files({}))).toBeUndefined();
    expect(pinnedVersions("typescript", "", files({ "package-lock.json": "{oops" }))?.versions.size).toBe(0);
  });

  it("reads TypeScript versions from npm-shrinkwrap.json, pnpm-lock.yaml, and yarn.lock", () => {
    const shrinkwrap = JSON.stringify({
      packages: { "node_modules/eslint": { version: "10.2.0" } },
    });
    expect(pinnedVersions("typescript", "", files({ "npm-shrinkwrap.json": shrinkwrap }))?.versions.get("eslint")).toBe(
      "10.2.0",
    );

    const pnpm = [
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    devDependencies:",
      "      typescript:",
      "        specifier: ^5.5.4",
      "        version: 5.5.4",
      "  packages/web:",
      "    dependencies:",
      "      zod:",
      "        specifier: workspace:*",
      "        version: link:../zod",
      "    devDependencies:",
      "      typescript:",
      "        specifier: ^6.0.3",
      "        version: 6.0.3",
      "packages:",
      "  '@biomejs/biome@2.3.1':",
      "    resolution: {integrity: sha512-x}",
      "  typescript@5.5.4:",
      "    resolution: {integrity: sha512-t1}",
      "  typescript@6.0.3:",
      "    resolution: {integrity: sha512-t2}",
      "  vitest@4.1.6(@types/node@25.8.0):",
      "    resolution: {integrity: sha512-y}",
    ].join("\n");
    const fromPnpmRoot = pinnedVersions("typescript", "", files({ "pnpm-lock.yaml": pnpm }));
    expect(fromPnpmRoot?.versions.get("typescript")).toBe("5.5.4");
    const fromPnpmWeb = pinnedVersions("typescript", "packages/web/", files({ "pnpm-lock.yaml": pnpm }));
    expect(fromPnpmWeb?.file).toBe("pnpm-lock.yaml");
    expect(Object.fromEntries(fromPnpmWeb?.versions ?? [])).toEqual({
      "@biomejs/biome": "2.3.1",
      typescript: "6.0.3",
      vitest: "4.1.6",
    });

    const yarn = ['"@biomejs/biome@npm:^2.0.0":', "  version: 2.3.1", "", "eslint@^10.0.0:", '  version "10.1.0"'].join(
      "\n",
    );
    const fromYarn = pinnedVersions("typescript", "", files({ "yarn.lock": yarn }));
    expect(fromYarn?.file).toBe("yarn.lock");
    expect(Object.fromEntries(fromYarn?.versions ?? [])).toEqual({
      "@biomejs/biome": "2.3.1",
      eslint: "10.1.0",
    });
  });
});
