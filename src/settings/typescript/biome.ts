import { at, findFirst, parseJsonc } from "../config-files.ts";
import type { Repair } from "../../fix/repair.ts";
import { setAt, type SettingsJudge } from "../judge.ts";
import { isRecord } from "../../shared/guards.ts";

/** Biome's defaults for what the config leaves out. */
const DEFAULT_LINE_WIDTH = 80;
const DEFAULT_LINE_ENDING = "lf";
const DEFAULT_COGNITIVE = 15;

function cognitiveRule(json: Record<string, unknown>): { enabled: boolean; max: number } | undefined {
  if (at(json, "linter", "enabled") === false) return { enabled: false, max: DEFAULT_COGNITIVE };
  const rule = at(json, "linter", "rules", "complexity", "noExcessiveCognitiveComplexity");
  if (rule === undefined) return undefined;
  const level = isRecord(rule) ? rule.level : rule;
  const max = at(rule, "options", "maxAllowedComplexity");
  return { enabled: level !== "off", max: typeof max === "number" ? max : DEFAULT_COGNITIVE };
}

function missingBiomeRepairs(file: string, judge: SettingsJudge): Repair[] {
  const width = judge.declared("format.printWidth");
  const ending = judge.declared("format.endOfLine");
  const cognitive = judge.declared("complexity.cognitive");
  return [
    ...(width === undefined ? [] : setAt(file, ["formatter", "lineWidth"])(width)),
    ...(ending === undefined ? [] : setAt(file, ["formatter", "lineEnding"])(ending)),
    ...(cognitive === undefined
      ? []
      : setAt(file, ["linter", "rules", "complexity", "noExcessiveCognitiveComplexity"], (max) => ({
          level: "error",
          options: { maxAllowedComplexity: max },
        }))(cognitive)),
  ];
}

/** Line width, line ending and cognitive complexity against biome.json(c), when Biome replaces ESLint and Prettier. */
export async function checkBiome(root: string, judge: SettingsJudge): Promise<void> {
  const found = await findFirst(root, ["biome.json", "biome.jsonc"], judge.dir);
  if (!found) {
    const file = judge.path("biome.json");
    judge.missingFile(file, " Biome 設定檔（biome.json）", missingBiomeRepairs(file, judge));
    return;
  }
  const { file } = found;
  const parsed = parseJsonc(found.text);
  const json = isRecord(parsed) ? parsed : {};
  const extendsOther = !isRecord(parsed) || (json.extends !== undefined && json.extends !== null);
  const setting = (key: string, name: string, fallback: unknown) => {
    const own = at(json, "javascript", "formatter", name);
    const value = own ?? at(json, "formatter", name);
    const repair = setAt(file, own === undefined ? ["formatter", name] : ["javascript", "formatter", name]);
    if (value === undefined && extendsOther) judge.unconfirmed(file, ` Biome ${name}`);
    else judge.compare(key, value ?? fallback, file, `Biome ${name}`, repair);
  };
  setting("format.printWidth", "lineWidth", DEFAULT_LINE_WIDTH);
  setting("format.endOfLine", "lineEnding", DEFAULT_LINE_ENDING);
  const label = "Biome noExcessiveCognitiveComplexity";
  const rule = cognitiveRule(json);
  const repair = (want: unknown): Repair[] => [
    ...(at(json, "linter", "enabled") === false
      ? [{ op: "set" as const, file, path: ["linter", "enabled"], value: true }]
      : []),
    ...setAt(file, ["linter", "rules", "complexity", "noExcessiveCognitiveComplexity"], (max) => ({
      level: "error",
      options: { maxAllowedComplexity: max },
    }))(want),
  ];
  if (rule === undefined && !extendsOther) judge.disabled("complexity.cognitive", file, label, repair);
  else judge.limit("complexity.cognitive", rule, file, label, repair);
}
