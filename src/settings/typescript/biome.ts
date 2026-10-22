import { at, findFirst, isRecord, parseJsonc } from "../config-files.ts";
import type { SettingsJudge } from "../judge.ts";

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

/** Line width, line ending and cognitive complexity against biome.json(c), when Biome replaces ESLint and Prettier. */
export async function checkBiome(root: string, judge: SettingsJudge): Promise<void> {
  const found = await findFirst(root, ["biome.json", "biome.jsonc"]);
  if (!found) {
    judge.missingFile(judge.path("biome.json"), " Biome 設定檔（biome.json）");
    return;
  }
  const file = judge.path(found.name);
  const parsed = parseJsonc(found.text);
  const json = isRecord(parsed) ? parsed : {};
  const extendsOther = !isRecord(parsed) || (json.extends !== undefined && json.extends !== null);
  const setting = (key: string, label: string, value: unknown, fallback: unknown) => {
    if (value === undefined && extendsOther) judge.unconfirmed(file, ` Biome ${label}`);
    else judge.compare(key, value ?? fallback, file, `Biome ${label}`);
  };
  const formatter = (name: string) => at(json, "javascript", "formatter", name) ?? at(json, "formatter", name);
  setting("format.printWidth", "lineWidth", formatter("lineWidth"), DEFAULT_LINE_WIDTH);
  setting("format.endOfLine", "lineEnding", formatter("lineEnding"), DEFAULT_LINE_ENDING);
  const label = "Biome noExcessiveCognitiveComplexity";
  const rule = cognitiveRule(json);
  if (rule === undefined && !extendsOther) judge.disabled("complexity.cognitive", file, label);
  else judge.limit("complexity.cognitive", rule, file, label);
}
