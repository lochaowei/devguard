import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { localDate, runCheck, type CheckResult } from "./check.ts";
import { runDoctor } from "./doctor.ts";
import { DeclarationExistsError, writeDraft } from "./draft.ts";
import { terminalInteraction, type Interaction } from "./fix/interaction.ts";
import { runCodeFix } from "./fix/code.ts";
import { runFix } from "./fix/run.ts";
import { checkStaged } from "./hooks/pre-commit.ts";
import { runInstall } from "./hooks/install.ts";
import { HOOK_HANDLERS } from "./hooks/registry.ts";
import type { Exec } from "./process/exec.ts";
import { failureMessage, UsageError } from "./report/failure.ts";
import { claudeFeedback } from "./report/claude.ts";
import { exitCodeFor, problemsOnly, renderJson, renderText, type ReportInput } from "./report/render.ts";
import { renderSarif } from "./report/sarif.ts";
import { renderVscode } from "./report/vscode.ts";
import { checkScope } from "./scope.ts";
import { runStandardUpgrade } from "./standard/upgrade-run.ts";
import type { ToolRunner } from "./tools/runner.ts";

export const VERSION = "0.2.0";

export const USAGE = `用法：devguard <指令> [選項]

指令：
  check [檔案…]  檢查專案宣告（.devguard.yaml）與程式碼；指定檔案時只檢查這些檔案
  doctor         check 加上環境檢查（工具、git hook、VS Code、Claude Code、鏡像帳密、標準更新）；只回報並附上修正指令
  fix            修正設定（工具設定檔、.vscode/、.claude/、git hook）：先預覽，確認後套用；--yes 直接套用
  fix --code [檔案…]  修正程式碼（格式化與可自動修正的 lint），修正後回報剩餘問題
  install        產生各防線的設定並安裝 git pre-commit 與 pre-push hook：先預覽，確認後套用；--yes 直接套用
  hook <名稱>    給 hook 呼叫：git-pre-commit|git-pre-push|claude-session-start|claude-post-edit|claude-stop
  draft          沒有 .devguard.yaml 時，依偵測到的元件與工具設定產生宣告草稿（不覆寫既有檔案）
  standard upgrade [目標版本]
                 預覽標準升級；--apply 才修改宣告與設定檔，並透過內部鏡像執行套件管理指令

選項：
  --staged              check：只檢查 staged 的檔案，與 pre-commit hook 相同（不能與檔案、--full 或 --only 一起使用）
  --only <類別>         只跑一類程式碼檢查：lint|format|typecheck
  --full                跑全部檢查，包含測試、覆蓋率與弱點掃描（不能與檔案一起使用）
  --format <格式>       輸出格式：text|json|sarif|vscode|claude（預設 text）
  --strict              偏離也算失敗
  --verbose             展開所有提示
  --quiet               doctor：只輸出有問題的項目（錯誤與偏離），沒有問題時不輸出
  --exit-zero           doctor：有問題時也以 0 結束（給 Claude Code skill 嵌入結果用）
  --cwd <dir>           專案根目錄（預設為目前目錄）
  --code                fix：修正程式碼而不是設定
  --yes                 fix / install：不詢問，直接套用
  --apply               standard upgrade：實際套用升級
  --ignore <路徑或 glob>  draft：不從這些檔案推斷元件，並寫入宣告的 ignore（可重複指定）
  --version             顯示版本
`;

/** Everything the CLI touches outside its arguments; the real process by default, fakes in tests. */
export interface CliEnv {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** All of stdin, for the Claude Code hooks. */
  stdin: () => Promise<string>;
  /** The directory the CLI was started in: `--cwd` and file arguments are relative to it. */
  cwd: string;
  /** The project's tools; defaults to the real runner. */
  tools?: ToolRunner;
  /** Runs git and other programs; defaults to the real one. */
  exec?: Exec;
  /** How `fix` and `install` ask; defaults to the terminal. */
  interaction?: (yes: boolean) => Interaction;
  /** Defaults to today's local date. */
  today?: string;
}

const FORMATS = ["text", "json", "sarif", "vscode", "claude"] as const;
type Format = (typeof FORMATS)[number];

function format(value: string): Format {
  if (!(FORMATS as readonly string[]).includes(value)) throw new UsageError(`不支援的格式「${value}」`);
  return value as Format;
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

const OPTIONS = {
  format: { type: "string", default: "text" },
  strict: { type: "boolean", default: false },
  verbose: { type: "boolean", default: false },
  quiet: { type: "boolean", default: false },
  "exit-zero": { type: "boolean", default: false },
  only: { type: "string" },
  full: { type: "boolean", default: false },
  staged: { type: "boolean", default: false },
  cwd: { type: "string" },
  version: { type: "boolean", default: false },
  yes: { type: "boolean", default: false },
  code: { type: "boolean", default: false },
  apply: { type: "boolean", default: false },
  ignore: { type: "string", multiple: true },
  help: { type: "boolean", short: "h", default: false },
} as const;

type Flags = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

/** What every command gets: the project root, the date, the injected process. */
interface Run {
  cwd: string;
  today: string;
  env: CliEnv;
  flags: Flags;
  args: string[];
}

/**
 * The whole CLI, in-process: parses `argv`, runs the command and returns the exit code (SPEC §11: 0 passed, 1 errors,
 * 2 the CLI itself failed). Output goes through `env`; nothing here touches `process` directly.
 */
export async function runCli(argv: readonly string[], env: CliEnv): Promise<number> {
  try {
    const { values: flags, positionals } = parseArgs({ args: [...argv], allowPositionals: true, options: OPTIONS });
    if (flags.version) {
      env.stdout(`devguard ${VERSION}\n`);
      return 0;
    }
    const [command] = positionals;
    if (flags.help || command === undefined) {
      env.stdout(USAGE);
      return flags.help ? 0 : 2;
    }
    const cwd = resolve(env.cwd, flags.cwd ?? ".");
    return await dispatch(command, { cwd, today: env.today ?? localDate(), env, flags, args: positionals.slice(1) });
  } catch (e) {
    env.stderr(failureMessage(e, USAGE));
    return 2;
  }
}

function dispatch(command: string, run: Run): Promise<number> {
  switch (command) {
    case "draft":
      return draft(run);
    case "fix":
      return fix(run);
    case "install":
      return runInstall({ ...common(run), io: interaction(run) });
    case "hook":
      return hook(run);
    case "standard":
      return standard(run);
    case "check":
      return check(run);
    case "doctor":
      return doctor(run);
    default:
      throw new UsageError(`不認得的指令「${command}」`);
  }
}

const common = ({ cwd, today, env }: Run) => ({
  cwd,
  today,
  ...(env.tools ? { tools: env.tools } : {}),
  ...(env.exec ? { exec: env.exec } : {}),
});

const interaction = ({ env, flags }: Run): Interaction => (env.interaction ?? terminalInteraction)(flags.yes);

async function check(run: Run): Promise<number> {
  const { flags, env } = run;
  const shown = format(flags.format);
  const result = flags.staged ? await staged(run) : await whole(run);
  env.stdout(render(shown, result, flags.verbose));
  return exitCodeFor(result.findings, flags.strict);
}

async function whole(run: Run): Promise<CheckResult> {
  const { flags, args, env } = run;
  const scope = checkScope({ files: args, only: flags.only, full: flags.full }, run.cwd, env.cwd);
  return runCheck({ ...common(run), scope });
}

/** `check --staged`: the pre-commit hook's checks, reported like any check (SPEC §3.2). */
async function staged(run: Run): Promise<CheckResult> {
  const { flags, args, env } = run;
  if (args.length > 0 || flags.full || flags.only !== undefined) {
    throw new UsageError("--staged 檢查 staged 的檔案，不能與檔案、--full 或 --only 一起使用");
  }
  const result = await checkStaged(common(run));
  if (!result) return { standard: undefined, components: [], findings: [] };
  if (result.warning) env.stderr(result.warning);
  return result.result;
}

/** `devguard doctor`: check plus the environment checks; `--quiet` prints only the problems, nothing when none. */
async function doctor(run: Run): Promise<number> {
  const { flags, args, env } = run;
  const shown = format(flags.format);
  if (args.length > 0) throw new UsageError("doctor 不接受檔案");
  const result = await runDoctor(common(run));
  const report = flags.quiet ? problemsOnly(result) : result;
  if (!flags.quiet || report.findings.length > 0) env.stdout(render(shown, report, flags.verbose));
  return flags["exit-zero"] ? 0 : exitCodeFor(result.findings, flags.strict);
}

/** `fix` repairs the settings; `fix --code [files]` fixes the code (SPEC §9.1). */
function fix(run: Run): Promise<number> {
  const { flags, args, env } = run;
  const io = interaction(run);
  if (!flags.code) {
    if (args.length > 0) throw new UsageError("只有 fix --code 可以指定檔案");
    return runFix({ ...common(run), io });
  }
  const scope = checkScope({ files: args, full: false }, run.cwd, env.cwd);
  return runCodeFix({ ...common(run), io, scope });
}

/**
 * `devguard hook <name>`: the report goes to stderr, which git shows to the person committing; Claude Code hooks read
 * their JSON input from stdin and answer on stdout.
 */
function hook(run: Run): Promise<number> {
  const [name] = run.args;
  const handler = name === undefined ? undefined : HOOK_HANDLERS[name];
  if (!handler) {
    throw new UsageError(`不認得的 hook「${name ?? ""}」，可用的有 ${Object.keys(HOOK_HANDLERS).join("|")}`);
  }
  return handler({ ...common(run), write: run.env.stderr, stdout: run.env.stdout, stdin: run.env.stdin });
}

function standard(run: Run): Promise<number> {
  const [sub, target, ...rest] = run.args;
  if (sub !== "upgrade" || rest.length > 0)
    throw new UsageError("用法：devguard standard upgrade [目標版本] [--apply]");
  return runStandardUpgrade({ ...common(run), target, apply: run.flags.apply, write: run.env.stdout });
}

async function draft(run: Run): Promise<number> {
  try {
    const { path, components } = await writeDraft({ cwd: run.cwd, today: run.today, ignore: run.flags.ignore });
    run.env.stdout(
      `已產生宣告草稿 ${path}（${String(components.length)} 個元件）\n` +
        "請確認元件並填寫所有 TODO 理由，再執行 devguard check\n",
    );
    return 0;
  } catch (e) {
    if (!(e instanceof DeclarationExistsError)) throw e;
    run.env.stderr(`${e.message}\n`);
    return 2;
  }
}
