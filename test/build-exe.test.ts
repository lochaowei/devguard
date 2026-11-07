import { describe, expect, it } from "vitest";
import { bunCandidates, compilePlan, findBun, parseTargets, type BunProbe } from "../scripts/build-exe.ts";

const WIN_X64 = { platform: "win32", arch: "x64" } as const;

describe("compilePlan", () => {
  it("compiles the native target with icon and version info", () => {
    const [step] = compilePlan({ version: "0.1.0", host: WIN_X64, targets: [{ os: "windows", arch: "x64" }] });
    expect(step?.outfile).toBe("dist/devguard-windows-x64.exe");
    expect(step?.args).toEqual([
      "build",
      "src/cli.ts",
      "--compile",
      "--target=bun-windows-x64",
      "--outfile=dist/devguard-windows-x64.exe",
      "--windows-icon=assets/devguard.ico",
      "--windows-title=devguard",
      "--windows-publisher=devguard",
      "--windows-version=0.1.0.0",
      "--windows-description=Checks and fixes coding-standard setup",
      "--windows-copyright=devguard contributors",
    ]);
    expect(step?.warnings).toEqual([]);
  });

  it("drops Windows metadata when cross-compiling, because Bun cannot set it then", () => {
    const [step] = compilePlan({ version: "1.2.3", host: WIN_X64, targets: [{ os: "windows", arch: "arm64" }] });
    expect(step?.args).toEqual([
      "build",
      "src/cli.ts",
      "--compile",
      "--target=bun-windows-arm64",
      "--outfile=dist/devguard-windows-arm64.exe",
    ]);
    expect(step?.warnings).toEqual([
      "windows-arm64 是交叉編譯（主機為 windows-x64），Bun 無法設定圖示與版本資訊；請在 arm64 的 Windows 上建置",
    ]);
  });

  it("plans one step per target, in order", () => {
    const plan = compilePlan({
      version: "0.1.0",
      host: { platform: "win32", arch: "arm64" },
      targets: [
        { os: "windows", arch: "x64" },
        { os: "windows", arch: "arm64" },
      ],
    });
    expect(plan.map((s) => [s.target.arch, s.warnings.length])).toEqual([
      ["x64", 1],
      ["arm64", 0],
    ]);
  });

  it("compiles Linux and macOS targets without Windows metadata or warnings, from any host", () => {
    const plan = compilePlan({
      version: "0.1.0",
      host: { platform: "linux", arch: "x64" },
      targets: [
        { os: "linux", arch: "arm64" },
        { os: "macos", arch: "x64" },
      ],
    });
    expect(plan.map((s) => [s.outfile, s.args, s.warnings])).toEqual([
      [
        "dist/devguard-linux-arm64",
        ["build", "src/cli.ts", "--compile", "--target=bun-linux-arm64", "--outfile=dist/devguard-linux-arm64"],
        [],
      ],
      [
        "dist/devguard-macos-x64",
        ["build", "src/cli.ts", "--compile", "--target=bun-darwin-x64", "--outfile=dist/devguard-macos-x64"],
        [],
      ],
    ]);
  });

  it("warns about a Windows target built on another OS", () => {
    const [step] = compilePlan({
      version: "0.1.0",
      host: { platform: "darwin", arch: "x64" },
      targets: [{ os: "windows", arch: "x64" }],
    });
    expect(step?.args.some((a) => a.startsWith("--windows-"))).toBe(false);
    expect(step?.warnings[0]).toContain("主機為 macos-x64");
  });

  it("names the output after --name", () => {
    const [step] = compilePlan({
      version: "0.1.0",
      host: WIN_X64,
      targets: [{ os: "linux", arch: "x64" }],
      name: "t2-probe",
      entry: "scripts/t2-probe.ts",
    });
    expect(step?.outfile).toBe("dist/t2-probe-linux-x64");
  });

  it("rejects versions that are not plain x.y.z", () => {
    expect(() =>
      compilePlan({ version: "0.1.0-beta.1", host: WIN_X64, targets: [{ os: "windows", arch: "x64" }] }),
    ).toThrow("版本必須是 x.y.z");
  });
});

describe("parseTargets", () => {
  it("builds both architectures of the host OS by default", () => {
    expect(parseTargets([], "linux")).toEqual([
      { os: "linux", arch: "x64" },
      { os: "linux", arch: "arm64" },
    ]);
  });

  it("reads a bare architecture as the host OS and <os>-<arch> as given", () => {
    expect(parseTargets(["arm64", "macos-x64"], "windows")).toEqual([
      { os: "windows", arch: "arm64" },
      { os: "macos", arch: "x64" },
    ]);
  });

  it("rejects unknown names", () => {
    expect(() => parseTargets(["darwin-arm64"], "macos")).toThrow("不認得的目標「darwin-arm64」");
    expect(() => parseTargets(["linux-x64-musl"], "linux")).toThrow("不認得的目標");
  });

  it("needs <os>-<arch> on a host devguard is not released for", () => {
    expect(() => parseTargets([], undefined)).toThrow("請寫成 <os>-<arch>");
    expect(parseTargets(["linux-x64"], undefined)).toEqual([{ os: "linux", arch: "x64" }]);
  });
});

describe("bunCandidates", () => {
  it("falls back to the bun.cmd shim on Windows, where npm installs only that", () => {
    expect(bunCandidates("win32")).toEqual(["bun", "bun.cmd"]);
  });

  it("tries only bun elsewhere", () => {
    expect(bunCandidates("linux")).toEqual(["bun"]);
    expect(bunCandidates("darwin")).toEqual(["bun"]);
  });
});

describe("findBun", () => {
  const notFound: BunProbe = {
    error: Object.assign(new Error("spawn bun ENOENT"), { code: "ENOENT" }),
    status: null,
    stdout: "",
  };
  const found = (version: string): BunProbe => ({
    status: 0,
    stdout: `${version}
`,
  });

  it("uses bun when it starts", () => {
    const tried: string[] = [];
    const bun = findBun(["bun", "bun.cmd"], (file) => (tried.push(file), found("1.4.4")));
    expect(bun).toEqual({ file: "bun", version: "1.4.4" });
    expect(tried).toEqual(["bun"]);
  });

  it("falls back to bun.cmd when bun is not on PATH", () => {
    const bun = findBun(["bun", "bun.cmd"], (file) => (file === "bun" ? notFound : found("1.4.4")));
    expect(bun).toEqual({ file: "bun.cmd", version: "1.4.4" });
  });

  it("skips a candidate that exits non-zero", () => {
    const bun = findBun(["bun", "bun.cmd"], (file) => (file === "bun" ? { status: 1, stdout: "" } : found("1.3.0")));
    expect(bun).toEqual({ file: "bun.cmd", version: "1.3.0" });
  });

  it("is undefined when no candidate starts", () => {
    expect(findBun(["bun", "bun.cmd"], () => notFound)).toBeUndefined();
  });
});
