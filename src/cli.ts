#!/usr/bin/env node
import { parseArgs } from "node:util";
import { checkDeclaration, localDate } from "./check.ts";
import { exitCodeFor, renderJson, renderText } from "./report/render.ts";

const VERSION = "0.1.0";

const USAGE = `用法：devguard <指令> [選項]

指令：
  check      檢查專案宣告（.devguard.yaml）

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
  if (command !== "check") throw new UsageError(`不認得的指令「${command}」`);
  if (values.format !== "text" && values.format !== "json") throw new UsageError(`不支援的格式「${values.format}」`);

  const result = await checkDeclaration(values.cwd ?? process.cwd(), localDate());
  process.stdout.write(values.format === "json" ? renderJson(result) : renderText(result, values.verbose));
  return exitCodeFor(result.findings, values.strict);
}

class UsageError extends Error {}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      e instanceof UsageError || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")
        ? `${message}\n\n${USAGE}`
        : `devguard 內部錯誤：${message}\n`,
    );
    process.exitCode = 2;
  },
);
