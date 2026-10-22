import { dirname, extname, join } from "node:path";
import { at, isRecord, parseJsonc, readIfExists } from "../config-files.ts";
import type { SettingsJudge } from "../judge.ts";

interface Loaded {
  options: Record<string, unknown>;
  /** Some `extends` base could not be read, so absent options may still be set there. */
  unresolved: boolean;
}

function candidates(fromDir: string, spec: string): string[] {
  const base = spec.startsWith(".") || spec.startsWith("/") ? join(fromDir, spec) : join(fromDir, "node_modules", spec);
  return extname(base) === ".json" ? [base] : [base, `${base}.json`, join(base, "tsconfig.json")];
}

async function loadBase(fromDir: string, spec: string, depth: number): Promise<Loaded> {
  for (const path of candidates(fromDir, spec)) {
    const loaded = await load(path, depth + 1);
    if (loaded) return loaded;
  }
  return { options: {}, unresolved: true };
}

/** compilerOptions after following `extends` (later bases and the file itself win). Undefined when the file is missing. */
async function load(path: string, depth = 0): Promise<Loaded | undefined> {
  const text = depth > 10 ? undefined : await readIfExists(path);
  if (text === undefined) return undefined;
  const json = parseJsonc(text);
  if (!isRecord(json)) return { options: {}, unresolved: true };
  const ext = json.extends;
  const specs = typeof ext === "string" ? [ext] : Array.isArray(ext) ? ext.filter((s) => typeof s === "string") : [];
  let options: Record<string, unknown> = {};
  let unresolved = false;
  for (const spec of specs) {
    const base = await loadBase(dirname(path), spec, depth);
    options = { ...options, ...base.options };
    unresolved ||= base.unresolved;
  }
  const own = at(json, "compilerOptions");
  return { options: { ...options, ...(isRecord(own) ? own : {}) }, unresolved };
}

/** `typecheck.strict` and `typecheck.options` against tsconfig.json (SPEC §6.3). */
export async function checkTsconfig(root: string, judge: SettingsJudge): Promise<void> {
  const file = judge.path("tsconfig.json");
  const loaded = await load(join(root, "tsconfig.json"));
  if (!loaded) {
    judge.missingFile(file, " tsconfig.json");
    return;
  }
  const { options, unresolved } = loaded;
  const check = (key: string, name: string, actual: unknown, run: () => void) => {
    if (actual === undefined && unresolved) judge.unconfirmed(file, `（extends 的來源讀不到）tsconfig 的 ${name}`);
    else run();
  };
  check("typecheck.strict", "strict", options.strict, () => {
    judge.compare("typecheck.strict", options.strict === true, file, "tsconfig strict");
  });
  const wanted = judge.declared("typecheck.options");
  for (const name of Array.isArray(wanted) ? wanted.filter((o) => typeof o === "string") : []) {
    check("typecheck.options", name, options[name], () => {
      if (options[name] !== true) judge.disabled("typecheck.options", file, `tsconfig ${name}`);
    });
  }
}
