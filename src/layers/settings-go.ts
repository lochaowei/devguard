import { join } from "node:path";
import type { ResolvedComponent } from "../declaration/resolve.ts";
import { fixText } from "../fix/category.ts";
import type { Repair } from "../fix/repair.ts";
import type { Finding } from "../report/finding.ts";
import { checkGoSettings, GOLANGCI_FILE, GOLANGCI_FILES, GOMOD_FILE } from "../settings/go.ts";
import type { CheckLayer } from "./types.ts";
import { upwards } from "../repo/paths.ts";
import { readIfExists } from "../shared/fs.ts";

interface FoundGolangci {
  file: string;
  text: string;
  /** Other golangci configs in the same directory, which golangci-lint ignores. */
  ignored: string[];
}

/**
 * The golangci config golangci-lint uses: from the component up to the repo root, the nearest directory that has one,
 * and within it the first of GOLANGCI_FILES.
 */
async function findGolangci(cwd: string, dir: string): Promise<FoundGolangci | undefined> {
  for (const base of upwards(dir)) {
    const found: { file: string; text: string }[] = [];
    for (const name of GOLANGCI_FILES) {
      const file = base + name;
      const text = await readIfExists(join(cwd, file));
      if (text !== undefined) found.push({ file, text });
    }
    const [used, ...ignored] = found;
    if (used) return { ...used, ignored: ignored.map((f) => f.file) };
  }
  return undefined;
}

const baseName = (file: string) => file.slice(file.lastIndexOf("/") + 1);

/** Several golangci configs in one directory: golangci-lint reads only the first of GOLANGCI_FILES. */
function golangciMultiple(component: ResolvedComponent, found: FoundGolangci): Finding {
  const ignored = found.ignored.map(baseName).join("、");
  return {
    level: "hint",
    layer: "config",
    rule: "settings/golangci-multiple",
    message: `同一個目錄有多份 golangci 設定檔：golangci-lint 採用 ${baseName(found.file)}，忽略 ${ignored}`,
    component: component.name,
    file: found.file,
    fix: `把要用的設定合併進 ${baseName(found.file)}，刪除 ${ignored}`,
  };
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

/** No golangci config anywhere golangci-lint looks; `fix` creates `.golangci.yml` with what a bare v2 config would be missing. */
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
  const gomod = await readIfExists(join(cwd, component.dir, GOMOD_FILE));
  const findings: Finding[] = [];
  if (golangci === undefined) findings.push(golangciMissing(component));
  else if (golangci.ignored.length > 0) findings.push(golangciMultiple(component, golangci));
  if (gomod === undefined) findings.push(missing(component, GOMOD_FILE, "settings/gomod-missing", "go mod init"));
  return [
    ...findings,
    ...checkGoSettings(component, { golangci: golangci?.text, golangciFile: golangci?.file, gomod }),
  ];
}

/** Settings check for Go components: the golangci config golangci-lint uses and `go.mod` against the effective standard (SPEC §6.2). */
export const goSettingsLayer: CheckLayer = {
  id: "settings-go",
  fixable: true,
  async run({ cwd, resolution }) {
    const components = resolution?.components.filter((c) => c.language === "go") ?? [];
    const findings = await Promise.all(components.map((c) => checkComponent(cwd, c)));
    return { findings: findings.flat() };
  },
};
