/**
 * SPEC §13 T2: probes the Windows child-process behaviour devguard relies on, so the same checks can be
 * run under Node (baseline) and inside the Bun-compiled exe (Bun issues #32011, #40846, #43660).
 *
 *   node scripts/t2-probe.ts                       # baseline under Node
 *   node scripts/build-exe.ts --entry scripts/t2-probe.ts --name t2-probe x64
 *   dist\t2-probe-windows-x64.exe                  # same probes inside the compiled exe
 *
 * Prints a Markdown table and exits 1 when any probe fails.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { viaCmd } from "../src/process/cmd-shim.ts";

export interface ProbeResult {
  id: string;
  title: string;
  ok: boolean;
  detail: string;
}

const UTF8_SAMPLE = "標準檢查 ✓ — ünïcödé";
const HOOK_INPUT = JSON.stringify({ hook_event_name: "PostToolUse", tool_input: { file_path: "C:\\專案\\a b.ts" } });

/** How to start this probe again as a child: the exe itself when compiled, else interpreter + script. */
function selfCommand(): [string, ...string[]] {
  const runtime = basename(process.execPath).toLowerCase();
  const interpreted = runtime === "node.exe" || runtime === "bun.exe" || runtime === "node" || runtime === "bun";
  return interpreted ? [process.execPath, fileURLToPath(import.meta.url)] : [process.execPath];
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

type Probe = Omit<ProbeResult, "ok" | "detail"> & { run: (dir: string) => Promise<{ ok: boolean; detail: string }> };

const ECHO_ARGS_CMD = [
  "@echo off",
  "setlocal EnableDelayedExpansion",
  ":loop",
  'if "%~1"=="" goto end',
  'set "a=%~1"',
  "echo(!a!",
  "shift",
  "goto loop",
  ":end",
  "",
].join("\r\n");

function writeCmd(dir: string): string {
  const sub = join(dir, "has space & amp");
  mkdirSync(sub, { recursive: true });
  const file = join(sub, "echo args.cmd");
  writeFileSync(file, ECHO_ARGS_CMD);
  return file;
}

const probes: Probe[] = [
  {
    id: "cmd-via-cmd-exe",
    title: "透過 cmd.exe /d /s /c 執行路徑含空白與 & 的 .cmd，參數含空白與 &|<>^",
    run: (dir) => {
      const args = ["a b", "x&y", "p|q", "<lt>", "c^d"];
      const c = viaCmd(writeCmd(dir), args);
      const r = spawnSync(c.file, c.args, {
        encoding: "utf8",
        windowsVerbatimArguments: c.windowsVerbatimArguments,
        timeout: 10_000,
      });
      const lines = r.stdout.split(/\r?\n/).filter((l) => l !== "");
      const ok = r.status === 0 && JSON.stringify(lines) === JSON.stringify(args);
      return Promise.resolve({ ok, detail: `exit ${String(r.status)}，輸出 ${JSON.stringify(lines)}` });
    },
  },
  {
    id: "cmd-direct-refused",
    title: "不經 shell 直接 spawn .cmd 會被拒絕或失敗（證明必須走 cmd.exe）",
    run: (dir) => {
      const r = spawnSync(writeCmd(dir), ["x"], { encoding: "utf8", timeout: 10_000 });
      const refused = r.error !== undefined || r.status !== 0;
      const detail = r.error ? describeError(r.error) : `exit ${String(r.status)}，stdout ${JSON.stringify(r.stdout)}`;
      return Promise.resolve({ ok: refused, detail });
    },
  },
  {
    id: "native-exe-sync",
    title: "execFileSync 呼叫原生 exe（where.exe）不會卡住（#32011）",
    run: () => {
      const started = Date.now();
      try {
        const out = execFileSync("where.exe", ["cmd.exe"], { encoding: "utf8", timeout: 10_000 });
        return Promise.resolve({ ok: /cmd\.exe/i.test(out), detail: `${String(Date.now() - started)} ms` });
      } catch (e) {
        return Promise.resolve({ ok: false, detail: `${String(Date.now() - started)} ms，${describeError(e)}` });
      }
    },
  },
  {
    id: "stdin-sync-input",
    title: "spawnSync 的 input 把 hook JSON 經 stdin 傳給子程序",
    run: () => {
      const [file, ...pre] = selfCommand();
      const r = spawnSync(file, [...pre, "--echo-stdin"], { input: HOOK_INPUT, encoding: "utf8", timeout: 10_000 });
      const detail = r.error
        ? describeError(r.error)
        : `exit ${String(r.status)}，收到 ${String(r.stdout.length)} 字元`;
      return Promise.resolve({ ok: r.stdout === HOOK_INPUT, detail });
    },
  },
  {
    id: "stdin-async-pipe",
    title: "非同步 spawn 寫入 stdin 後 end()，子程序讀到 EOF 並回傳",
    run: () =>
      new Promise((done) => {
        const [file, ...pre] = selfCommand();
        const child = spawn(file, [...pre, "--echo-stdin"], { stdio: ["pipe", "pipe", "inherit"] });
        const chunks: Buffer[] = [];
        const timer = setTimeout(() => {
          child.kill();
          done({ ok: false, detail: "10 秒內沒有結束（stdin 沒有收到 EOF？）" });
        }, 10_000);
        child.stdout.on("data", (c: Buffer) => chunks.push(c));
        child.on("error", (e) => {
          clearTimeout(timer);
          done({ ok: false, detail: describeError(e) });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          const out = Buffer.concat(chunks).toString("utf8");
          done({ ok: out === HOOK_INPUT, detail: `exit ${String(code)}，收到 ${String(out.length)} 字元` });
        });
        child.stdin.end(HOOK_INPUT);
      }),
  },
  {
    id: "utf8-pipe",
    title: "子程序經管線輸出的 UTF-8 不會變亂碼（#43660）",
    run: () => {
      const [file, ...pre] = selfCommand();
      const r = spawnSync(file, [...pre, "--print-utf8"], { encoding: "utf8", timeout: 10_000 });
      const detail = r.error ? describeError(r.error) : `收到 ${JSON.stringify(r.stdout)}`;
      return Promise.resolve({ ok: r.stdout === UTF8_SAMPLE, detail });
    },
  },
  {
    id: "path-mutation",
    title: "執行期修改 process.env.PATH 後，子程序看得到新的 PATH（#40846）",
    run: (dir) => {
      const bin = join(dir, "late-bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "devguard-t2-late.cmd"), "@echo late-ok\r\n");
      const key = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
      const before = process.env[key];
      process.env[key] = `${bin}${delimiter}${before ?? ""}`;
      try {
        const c = viaCmd("devguard-t2-late.cmd", []);
        const r = spawnSync(c.file, c.args, {
          encoding: "utf8",
          windowsVerbatimArguments: true,
          timeout: 10_000,
        });
        const detail = r.error
          ? describeError(r.error)
          : `exit ${String(r.status)}，${JSON.stringify(r.stdout.trim())}`;
        return Promise.resolve({ ok: r.stdout.trim() === "late-ok", detail });
      } finally {
        process.env[key] = before;
      }
    },
  },
];

export async function runProbes(): Promise<ProbeResult[]> {
  const dir = mkdtempSync(join(tmpdir(), "devguard-t2-"));
  try {
    const results: ProbeResult[] = [];
    for (const { run, ...p } of probes) {
      try {
        results.push({ ...p, ...(await run(join(dir, p.id))) });
      } catch (e) {
        results.push({ ...p, ok: false, detail: describeError(e) });
      }
    }
    return results;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");

export function renderMarkdown(runtime: string, results: readonly ProbeResult[]): string {
  const rows = results.map((r) => `| ${r.id} | ${cell(r.title)} | ${r.ok ? "通過" : "失敗"} | ${cell(r.detail)} |`);
  return [`執行環境：${runtime}`, "", "| 項目 | 說明 | 結果 | 細節 |", "|---|---|---|---|", ...rows, ""].join("\n");
}

async function main(): Promise<void> {
  const mode = process.argv.find((a) => a.startsWith("--"));
  if (mode === "--echo-stdin") {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    process.stdout.write(Buffer.concat(chunks));
    return;
  }
  if (mode === "--print-utf8") {
    process.stdout.write(UTF8_SAMPLE);
    return;
  }
  const bun = (process.versions as Record<string, string | undefined>).bun;
  const runtime = bun === undefined ? `Node ${process.version}` : `Bun ${bun}`;
  const compiled = selfCommand().length === 1 ? "（編譯後的 exe）" : "";
  const results = await runProbes();
  process.stdout.write(renderMarkdown(`${runtime}${compiled}，${process.platform}-${process.arch}`, results));
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] === self || selfCommand().length === 1) await main();
