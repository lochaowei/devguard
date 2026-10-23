#!/usr/bin/env node
import { parseArgs } from "node:util";
import { localDate, runCheck } from "./check.ts";
import { DeclarationExistsError, writeDraft } from "./draft.ts";
import { failureMessage, UsageError } from "./report/failure.ts";
import { exitCodeFor, renderJson, renderText } from "./report/render.ts";

const VERSION = "0.1.0";

const USAGE = `用法：devguard <指令> [選項]

指令：
  check      檢查專案宣告（.devguard.yaml）
  draft      沒有 .devguard.yaml 時，依偵測到的元件與工具設定產生宣告草稿（不覆寫既有檔案）

選項：
  --format <text|json>  輸出格式（預設 text）
  --strict              偏離也算失敗
  --verbose             展開所有提示
  --cwd <dir>           專案根目錄（預設為目前目錄）
  --version             顯示版本
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      format: { type: "string", default: "text" },
      strict: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      cwd: { type: "string" },
      version: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.version) {
    process.stdout.write(`devguard ${VERSION}\n`);
    return 0;
  }
  const [command] = positionals;
  if (values.help || command === undefined) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 2;
  }
  const cwd = values.cwd ?? process.cwd();
  if (command === "draft") return draft(cwd);
  if (command !== "check") throw new UsageError(`不認得的指令「${command}」`);
  return check(cwd, values);
}

async function check(cwd: string, options: { format: string; strict: boolean; verbose: boolean }): Promise<number> {
  if (options.format !== "text" && options.format !== "json") throw new UsageError(`不支援的格式「${options.format}」`);
  const result = await runCheck({ cwd, today: localDate() });
  process.stdout.write(options.format === "json" ? renderJson(result) : renderText(result, options.verbose));
  return exitCodeFor(result.findings, options.strict);
}

async function draft(cwd: string): Promise<number> {
  try {
    const { path, components } = await writeDraft({ cwd, today: localDate() });
    process.stdout.write(
      `已產生宣告草稿 ${path}（${String(components.length)} 個元件）\n` +
        "請確認元件並填寫所有 TODO 理由，再執行 devguard check\n",
    );
    return 0;
  } catch (e) {
    if (!(e instanceof DeclarationExistsError)) throw e;
    process.stderr.write(`${e.message}
`);
    return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(failureMessage(e, USAGE));
    process.exitCode = 2;
  },
);
