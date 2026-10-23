import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedComponent } from "../declaration/resolve.ts";
import { fixText } from "../fix/category.ts";
import type { Repair } from "../fix/repair.ts";
import type { Finding } from "../report/finding.ts";
import { checkGoSettings, GOLANGCI_FILE, GOLANGCI_FILES, GOMOD_FILE } from "../settings/go.ts";
import type { CheckLayer } from "./types.ts";

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

function ancestors(dir: string): string[] {
  const parts = dir.split("/").filter((p) => p !== "");
  return parts.map((_, i) => parts.slice(0, parts.length - i).join("/") + "/").concat("");
}

async function findGolangci(cwd: string, dir: string): Promise<{ file: string; text: string } | undefined> {
  for (const base of ancestors(dir)) {
    for (const name of GOLANGCI_FILES) {
      const file = base + name;
      const text = await readOptional(join(cwd, file));
      if (text !== undefined) return { file, text };
    }
  }
  return undefined;
}

function missing(component: ResolvedComponent, name: string, rule: string, fix: string): Finding {
  return {
    level: "error",
    layer: "config",
    rule,
    message: `找不到 ${name}`,
    component: component.name,
    file: component.dir + name,
    fix,
  };
}

/** A missing `.golangci.yml`; `fix` creates it with what a bare v2 config would be missing. */
function golangciMissing(component: ResolvedComponent): Finding {
  const file = component.dir + GOLANGCI_FILE;
  const bare = checkGoSettings(component, { golangci: 'version: "2"\n' });
  const repairs: Repair[] = [
    { op: "set", file, path: ["version"], value: "2" },
    ...bare.flatMap((f) => f.repairs ?? []),
  ];
  const fix = fixText(`建立 ${GOLANGCI_FILE}（golangci-lint v2 格式）`, repairs);
  return { ...missing(component, GOLANGCI_FILE, "settings/golangci-missing", fix), repairs };
}

async function checkComponent(cwd: string, component: ResolvedComponent): Promise<Finding[]> {
  const golangci = await findGolangci(cwd, component.dir);
  const gomod = await readOptional(join(cwd, component.dir, GOMOD_FILE));
  const findings: Finding[] = [];
  if (golangci === undefined) findings.push(golangciMissing(component));
  if (gomod === undefined) findings.push(missing(component, GOMOD_FILE, "settings/gomod-missing", "go mod init"));
  return [
    ...findings,
    ...checkGoSettings(component, { golangci: golangci?.text, golangciFile: golangci?.file, gomod }),
  ];
}

/** Settings check for Go components: `.golangci.yml` and `go.mod` against the effective standard (SPEC §6.2). */
export const goSettingsLayer: CheckLayer = {
  id: "settings-go",
  async run({ cwd, resolution }) {
    const components = resolution?.components.filter((c) => c.language === "go") ?? [];
    const findings = await Promise.all(components.map((c) => checkComponent(cwd, c)));
    return { findings: findings.flat() };
  },
};
