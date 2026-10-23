import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  findFirst,
  isRecord,
  literalProperty,
  parseJsonc,
  readIfExists,
  searchDirs,
  type FoundFile,
} from "../config-files.ts";
import { setAt, type SettingsJudge } from "../judge.ts";

/** Prettier's own search order for config files (package.json first). */
const CONFIG_FILES = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yaml",
  ".prettierrc.yml",
  ".prettierrc.json5",
  ".prettierrc.js",
  "prettier.config.js",
  ".prettierrc.ts",
  "prettier.config.ts",
  ".prettierrc.mjs",
  "prettier.config.mjs",
  ".prettierrc.mts",
  "prettier.config.mts",
  ".prettierrc.cjs",
  "prettier.config.cjs",
  ".prettierrc.cts",
  "prettier.config.cts",
  ".prettierrc.toml",
];

/** The style items Prettier lands, with Prettier's own defaults for when the config leaves them out. */
const SETTINGS = [
  { key: "format.printWidth", option: "printWidth", fallback: 80 },
  { key: "format.endOfLine", option: "endOfLine", fallback: "lf" },
] as const;

/** Options read from one config file. `complete` means an absent option is Prettier's default, not just unknown. */
interface Read {
  file: string;
  options: Record<string, unknown>;
  complete: boolean;
}

function parseData(found: FoundFile): Record<string, unknown> | undefined {
  try {
    const v: unknown = found.name.endsWith(".json5") ? parseJsonc(found.text) : parseYaml(found.text);
    return isRecord(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function readFound(found: FoundFile): Read {
  const { name, file, text } = found;
  const isCode = /\.[cm]?[jt]s$/.test(name);
  if (isCode || name.endsWith(".toml")) {
    const options: Record<string, unknown> = {};
    for (const { option } of SETTINGS) options[option] = literalProperty(text, option, isCode ? ":" : "=");
    return { file, options, complete: false };
  }
  const options = parseData(found);
  return { file, options: options ?? {}, complete: options !== undefined };
}

async function readConfig(root: string, subDir: string): Promise<Read | undefined> {
  for (const { fsDir, relDir } of searchDirs(root, subDir)) {
    const pkg = parseJsonc((await readIfExists(join(fsDir, "package.json"))) ?? "");
    if (isRecord(pkg) && pkg.prettier !== undefined) {
      const own = pkg.prettier;
      return { file: `${relDir}package.json`, options: isRecord(own) ? own : {}, complete: isRecord(own) };
    }
    const found = await findFirst(fsDir, CONFIG_FILES);
    if (found) return readFound({ ...found, file: relDir + found.name });
  }
  return undefined;
}

/** `format.printWidth` / `format.endOfLine` against the Prettier config (style items: judged by the declared value). */
export async function checkPrettier(root: string, judge: SettingsJudge): Promise<void> {
  const config = await readConfig(root, judge.dir);
  if (!config) {
    const file = judge.path(".prettierrc");
    const repairs = SETTINGS.flatMap(({ key, option }) => {
      const want = judge.declared(key);
      return want === undefined ? [] : setAt(file, [option])(want);
    });
    judge.missingFile(file, " Prettier 設定檔", repairs);
    return;
  }
  const { file } = config;
  const base = file.endsWith("package.json") ? ["prettier"] : [];
  for (const { key, option, fallback } of SETTINGS) {
    const value = config.options[option];
    const repair = setAt(file, [...base, option]);
    if (value === undefined && !config.complete) judge.unconfirmed(file, ` Prettier ${option}`);
    else judge.compare(key, value ?? fallback, file, `Prettier ${option}`, repair);
  }
}
