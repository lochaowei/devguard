import { join } from "node:path";
import type { ResolvedComponent } from "../declaration/resolve.ts";
import { fixText } from "../fix/category.ts";
import type { Repair } from "../fix/repair.ts";
import type { Finding } from "../report/finding.ts";
import { checkGoSettings, GOLANGCI_FILE, GOLANGCI_FILES, GOMOD_FILE } from "../settings/go.ts";
import type { CheckLayer } from "./types.ts";
import { baseName, dirName, upwards } from "../repo/paths.ts";
import { goWorkDirs } from "../repo/go-work.ts";
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

/**
 * No golangci config anywhere golangci-lint looks; `fix` creates `file` (a `.golangci.yml`, see `golangciHomes`) with
 * what a bare v2 config would be missing.
 */
function golangciMissing(component: ResolvedComponent, file: string): Finding {
  const bare = checkGoSettings(component, { golangci: 'version: "2"\n', golangciFile: file });
  const repairs: Repair[] = [
    { op: "set", file, path: ["version"], value: "2" },
    ...bare.flatMap((f) => f.repairs ?? []),
  ];
  const fix = fixText(`建立 ${file}（golangci-lint v2 格式）`, repairs);
  return { ...missing(component, GOLANGCI_FILE, "settings/golangci-missing", fix), file, repairs };
}

interface ComponentSettings {
  component: ResolvedComponent;
  /** The golangci config the component uses, or the one `fix` creates for it. */
  golangciFile: string;
  findings: Finding[];
}

async function checkComponent(cwd: string, component: ResolvedComponent, createIn: string): Promise<ComponentSettings> {
  const golangci = await findGolangci(cwd, component.dir);
  const golangciFile = golangci?.file ?? createIn + GOLANGCI_FILE;
  const gomod = await readIfExists(join(cwd, component.dir, GOMOD_FILE));
  const findings: Finding[] = [];
  if (golangci === undefined) findings.push(golangciMissing(component, golangciFile));
  else if (golangci.ignored.length > 0) findings.push(golangciMultiple(component, golangci));
  if (gomod === undefined) findings.push(missing(component, GOMOD_FILE, "settings/gomod-missing", "go mod init"));
  findings.push(...checkGoSettings(component, { golangci: golangci?.text, golangciFile: golangci?.file, gomod }));
  return { component, findings, golangciFile };
}

/**
 * Where `fix` creates the golangci config of a Go component that has none (#88), so that modules golangci-lint can
 * share one config get one file: the directory of the go.work in the repo that uses the module, otherwise the
 * topmost Go component at or above it. golangci-lint looks for its config upwards, so every such module finds it.
 */
async function golangciHomes(cwd: string, components: readonly ResolvedComponent[]): Promise<string[]> {
  const workDirs = await goWorkDirs(
    cwd,
    components.map((c) => c.dir),
  );
  return components.map((c) => {
    const topmost = components
      .filter((o) => c.dir.startsWith(o.dir))
      .reduce((best, o) => (o.dir.length < best.dir.length ? o : best), c);
    // The topmost component's own home, so a module below a go.work's module shares that go.work's config.
    return workDirs.get(c.dir) ?? workDirs.get(topmost.dir) ?? topmost.dir;
  });
}

const depth = (dir: string) => dir.split("/").length;

/**
 * Where a finding several components report about the golangci config they share is listed (#92): under the
 * reporter whose directory holds the file, otherwise under the shallowest reporter, ties going to declaration order.
 * `reporters` is in declaration order and never empty.
 */
function golangciOwner(file: string, reporters: readonly ResolvedComponent[]): ResolvedComponent {
  const shallowest = reporters.reduce((best, c) => (depth(c.dir) < depth(best.dir) ? c : best));
  return reporters.find((c) => c.dir === dirName(file)) ?? shallowest;
}

const findingKey = (f: Finding) => JSON.stringify([f.rule, f.file, f.line, f.message]);

/** A finding about the golangci config the component uses, as opposed to its own files. */
const aboutGolangci = (s: ComponentSettings, f: Finding) => f.file === s.golangciFile;

interface Reported {
  /** In declaration order. */
  reporters: ResolvedComponent[];
  /** Every reporter's repairs, each once. */
  repairs: Repair[];
}

/** Each finding about a component's golangci config, by `findingKey`: who reports it, and all their repairs. */
function reportedShared(settings: readonly ComponentSettings[]): Map<string, Reported> {
  const out = new Map<string, Reported>();
  for (const s of settings) {
    for (const f of s.findings.filter((f) => aboutGolangci(s, f))) {
      const r = out.get(findingKey(f)) ?? { reporters: [], repairs: [] };
      r.reporters.push(s.component);
      const known = new Set(r.repairs.map((x) => JSON.stringify(x)));
      r.repairs.push(...(f.repairs ?? []).filter((x) => !known.has(JSON.stringify(x))));
      out.set(findingKey(f), r);
    }
  }
  return out;
}

/**
 * Findings about a golangci config several components share are listed once (#92), under the owner among the
 * components that report them, so their repairs are applied once. The merged finding carries every reporter's
 * repairs: a config `fix` creates for several components (#88) also gets what one component's overrides add.
 * One a single component reports stays as it is.
 */
function mergeShared(settings: readonly ComponentSettings[]): Finding[] {
  const reported = reportedShared(settings);
  const seen = new Set<string>();
  return settings.flatMap((s) =>
    s.findings.flatMap((f) => {
      const key = findingKey(f);
      const r = reported.get(key);
      if (!aboutGolangci(s, f) || r === undefined) return [f];
      if (seen.has(key)) return [];
      seen.add(key);
      const merged = { ...f, component: golangciOwner(s.golangciFile, r.reporters).name };
      return [f.repairs === undefined ? merged : { ...merged, repairs: r.repairs }];
    }),
  );
}

/** Settings check for Go components: the golangci config golangci-lint uses and `go.mod` against the effective standard (SPEC §6.2). */
export const goSettingsLayer: CheckLayer = {
  id: "settings-go",
  fixable: true,
  async run({ cwd, resolution }) {
    const components = resolution?.components.filter((c) => c.language === "go") ?? [];
    const homes = await golangciHomes(cwd, components);
    const checked = await Promise.all(components.map((c, i) => checkComponent(cwd, c, homes[i] ?? c.dir)));
    return { findings: mergeShared(checked) };
  },
};
