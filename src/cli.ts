#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { localDate, runCheck } from "./check.ts";
import { runDoctor } from "./doctor.ts";
import { DeclarationExistsError, writeDraft } from "./draft.ts";
import { terminalInteraction } from "./fix/interaction.ts";
import { runCodeFix } from "./fix/code.ts";
import { runFix } from "./fix/run.ts";
import { runInstall } from "./hooks/install.ts";
import { HOOK_HANDLERS } from "./hooks/registry.ts";
import { failureMessage, UsageError } from "./report/failure.ts";
import { claudeFeedback } from "./report/claude.ts";
import { exitCodeFor, problemsOnly, renderJson, renderText, type ReportInput } from "./report/render.ts";
import { renderSarif } from "./report/sarif.ts";
import { renderVscode } from "./report/vscode.ts";
import { checkScope } from "./scope.ts";
import { runStandardUpgrade } from "./standard/upgrade-run.ts";

const VERSION = "0.1.0";

const USAGE = `用法：devguard <指令> [選項]

指令：
  check [檔案…]  檢查專案宣告（.devguard.yaml）與程式碼；指定檔案時只檢查這些檔案
  doctor         check 加上環境檢查（git hook 是否安裝、標準是否有更新）；只回報並附上修正指令
  fix            修正設定：先預覽，確認後套用；--yes 直接套用
  fix --code [檔案…]  修正程式碼（格式化與可自動修正的 lint），修正後回報剩餘問題
  install        產生各防線的設定並安裝 git pre-commit hook：先預覽，確認後套用；--yes 直接套用
  hook <名稱>    給 hook 呼叫：git-pre-commit
  draft          沒有 .devguard.yaml 時，依偵測到的元件與工具設定產生宣告草稿（不覆寫既有檔案）
  standard upgrade [目標版本]
                 預覽標準升級；--apply 才修改宣告與設定檔，並透過內部鏡像執行套件管理指令

選項：
  --only <類別>         只跑一類程式碼檢查：lint|format|typecheck
  --full                跑全部檢查（不能與檔案一起使用）
  --format <格式>       輸出格式：text|json|sarif|vscode|claude（預設 text）
  --strict              偏離也算失敗
  --verbose             展開所有提示
  --quiet               doctor：只輸出有問題的項目（錯誤與偏離），沒有問題時不輸出
  --cwd <dir>           專案根目錄（預設為目前目錄）
  --code                fix：修正程式碼而不是設定
  --yes                 fix / install：不詢問，直接套用
  --apply               standard upgrade：實際套用升級
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
      quiet: { type: "boolean", default: false },
      only: { type: "string" },
      full: { type: "boolean", default: false },
      cwd: { type: "string" },
      version: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      code: { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
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
  return dispatch(command, resolve(values.cwd ?? process.cwd()), values, positionals.slice(1));
}

function dispatch(
  command: string,
  cwd: string,
  values: CheckFlags & { code: boolean; yes: boolean; apply: boolean; quiet: boolean },
  args: string[],
) {
  switch (command) {
    case "draft":
      return draft(cwd);
    case "fix":
      return fix(cwd, values, args);
    case "install":
      return runInstall({ cwd, today: localDate(), io: terminalInteraction(values.yes) });
    case "hook":
      return hook(cwd, args[0]);
    case "standard":
      return standard(cwd, args, values.apply);
    case "check":
      return check(cwd, values, args);
    case "doctor":
      return doctor(cwd, values, args);
    default:
      throw new UsageError(`不認得的指令「${command}」`);
  }
}

interface CheckFlags {
  format: string;
  strict: boolean;
  verbose: boolean;
  only?: string;
  full: boolean;
}

async function check(cwd: string, flags: CheckFlags, files: string[]): Promise<number> {
  const format = flags.format;
  if (!isFormat(format)) throw new UsageError(`不支援的格式「${format}」`);
  const scope = checkScope({ files, only: flags.only, full: flags.full }, cwd, process.cwd());
  const result = await runCheck({ cwd, today: localDate(), scope });
  process.stdout.write(render(format, result, flags.verbose));
  return exitCodeFor(result.findings, flags.strict);
}

/** `devguard doctor`: check plus the environment checks; `--quiet` prints only the problems, nothing when none. */
async function doctor(cwd: string, flags: CheckFlags & { quiet: boolean }, args: string[]): Promise<number> {
  const format = flags.format;
  if (!isFormat(format)) throw new UsageError(`不支援的格式「${format}」`);
  if (args.length > 0) throw new UsageError("doctor 不接受檔案");
  const result = await runDoctor({ cwd, today: localDate() });
  const shown = flags.quiet ? problemsOnly(result) : result;
  if (!flags.quiet || shown.findings.length > 0) process.stdout.write(render(format, shown, flags.verbose));
  return exitCodeFor(result.findings, flags.strict);
}

/** `fix` repairs the settings; `fix --code [files]` fixes the code (SPEC §9.1). */
function fix(cwd: string, flags: { code: boolean; yes: boolean }, files: string[]): Promise<number> {
  const io = terminalInteraction(flags.yes);
  const today = localDate();
  if (!flags.code) {
    if (files.length > 0) throw new UsageError("只有 fix --code 可以指定檔案");
    return runFix({ cwd, today, io });
  }
  const scope = checkScope({ files, full: false }, cwd, process.cwd());
  return runCodeFix({ cwd, today, io, scope });
}

/** `devguard hook <name>`: the hook's report goes to stderr, which git shows to the person committing. */
function hook(cwd: string, name: string | undefined): Promise<number> {
  const handler = name === undefined ? undefined : HOOK_HANDLERS[name];
  if (!handler) {
    throw new UsageError(`不認得的 hook「${name ?? ""}」，可用的有 ${Object.keys(HOOK_HANDLERS).join("|")}`);
  }
  return handler({ cwd, today: localDate(), write: (text) => process.stderr.write(text) });
}

function standard(cwd: string, args: string[], apply: boolean): Promise<number> {
  const [sub, target, ...rest] = args;
  if (sub !== "upgrade" || rest.length > 0)
    throw new UsageError("用法：devguard standard upgrade [目標版本] [--apply]");
  const write = (text: string) => process.stdout.write(text);
  return runStandardUpgrade({ cwd, today: localDate(), target, apply, write });
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
    process.stderr.write(`${e.message}\n`);
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
