import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedComponent } from "../declaration/resolve.ts";
import type { Finding } from "../report/finding.ts";
import { checkGoSettings, GOLANGCI_FILE, GOMOD_FILE } from "../settings/go.ts";
import type { CheckLayer } from "./types.ts";

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
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

async function checkComponent(cwd: string, component: ResolvedComponent): Promise<Finding[]> {
  const golangci = await readOptional(join(cwd, component.dir, GOLANGCI_FILE));
  const gomod = await readOptional(join(cwd, component.dir, GOMOD_FILE));
  const findings: Finding[] = [];
  if (golangci === undefined)
    findings.push(
      missing(component, GOLANGCI_FILE, "settings/golangci-missing", `建立 ${GOLANGCI_FILE}（golangci-lint v2 格式）`),
    );
  if (gomod === undefined) findings.push(missing(component, GOMOD_FILE, "settings/gomod-missing", "go mod init"));
  return [...findings, ...checkGoSettings(component, { golangci, gomod })];
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
