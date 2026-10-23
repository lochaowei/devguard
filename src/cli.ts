#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { localDate, runCheck } from "./check.ts";
import { failureMessage, UsageError } from "./report/failure.ts";
import { claudeFeedback } from "./report/claude.ts";
import { exitCodeFor, renderJson, renderText, type ReportInput } from "./report/render.ts";
import { renderSarif } from "./report/sarif.ts";
import { renderVscode } from "./report/vscode.ts";
import { checkScope } from "./scope.ts";

const VERSION = "0.1.0";

const USAGE = `用法：devguard <指令> [選項]

指令：
  check [檔案…]  檢查專案宣告（.devguard.yaml）與程式碼；指定檔案時只檢查這些檔案

選項：
  --only <類別>         只跑一類程式碼檢查：lint|format|typecheck
  --full                跑全部檢查（不能與檔案一起使用）
  --format <格式>       輸出格式：text|json|sarif|vscode|claude（預設 text）
  --strict              偏離也算失敗
  --verbose             展開所有提示
  --cwd <dir>           專案根目錄（預設為目前目錄）
  --version             顯示版本
`;

const FORMATS = ["text", "json", "sarif", "vscode", "claude"] as const;
type Format = (typeof FORMATS)[number];

function isFormat(value: string): value is Format {
  return (FORMATS as readonly string[]).includes(value);
}

/** The report in the chosen format. The exit code never depends on it (SPEC §11). */
function render(format: Format, result: ReportInput, verbose: boolean): string {
  switch (format) {
    case "text":
      return renderText(result, verbose);
    case "json":
      return renderJson(result);
    case "sarif":
      return renderSarif(result, VERSION);
    case "vscode":
      return renderVscode(result.findings);
    case "claude":
      return claudeFeedback(result.findings) + "\n";
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      format: { type: "string", default: "text" },
      strict: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      only: { type: "string" },
      full: { type: "boolean", default: false },
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
  const format = values.format;
  if (!isFormat(format)) throw new UsageError(`不支援的格式「${format}」`);

  const cwd = resolve(values.cwd ?? process.cwd());
  const scope = checkScope({ files: positionals.slice(1), only: values.only, full: values.full }, cwd, process.cwd());
  const result = await runCheck({ cwd, today: localDate(), scope });
  process.stdout.write(render(format, result, values.verbose));
  return exitCodeFor(result.findings, values.strict);
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
