import { describe, expect, it } from "vitest";
import { renderMarkdown, runProbes } from "../scripts/t2-probe.ts";

describe.runIf(process.platform === "win32")("T2 probe (Node baseline)", () => {
  it("passes every probe under Node", async () => {
    const results = await runProbes();
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.map((r) => r.id)).toEqual([
      "cmd-via-cmd-exe",
      "cmd-direct-refused",
      "native-exe-sync",
      "stdin-sync-input",
      "stdin-async-pipe",
      "utf8-pipe",
      "path-mutation",
    ]);
  }, 60_000);

  it("renders a Markdown table with the runtime", () => {
    const md = renderMarkdown("Node 24.0.0", [{ id: "x", title: "X|Y", ok: false, detail: "a\nb" }]);
    expect(md).toContain("執行環境：Node 24.0.0");
    expect(md).toContain("| x | X\\|Y | 失敗 | a<br>b |");
  });
});
