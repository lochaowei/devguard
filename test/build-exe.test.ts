import { describe, expect, it } from "vitest";
import { bunCandidates, compilePlan, findBun, type BunProbe } from "../scripts/build-exe.ts";

describe("compilePlan", () => {
  it("compiles the native target with icon and version info", () => {
    const [step] = compilePlan({ version: "0.1.0", hostArch: "x64", targets: ["x64"] });
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
    const [step] = compilePlan({ version: "1.2.3", hostArch: "x64", targets: ["arm64"] });
    expect(step?.args).toEqual([
      "build",
      "src/cli.ts",
      "--compile",
      "--target=bun-windows-arm64",
      "--outfile=dist/devguard-windows-arm64.exe",
    ]);
    expect(step?.warnings).toEqual([
      "windows-arm64 是交叉編譯（主機為 x64），Bun 無法設定圖示與版本資訊；請在 arm64 的 Windows 上建置",
    ]);
  });

  it("plans one step per target, in order", () => {
    const plan = compilePlan({ version: "0.1.0", hostArch: "arm64", targets: ["x64", "arm64"] });
    expect(plan.map((s) => [s.target, s.warnings.length])).toEqual([
      ["x64", 1],
      ["arm64", 0],
    ]);
  });

  it("rejects versions that are not plain x.y.z", () => {
    expect(() => compilePlan({ version: "0.1.0-beta.1", hostArch: "x64", targets: ["x64"] })).toThrow(
      "版本必須是 x.y.z",
    );
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
