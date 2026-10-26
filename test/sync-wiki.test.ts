import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { syncWiki, toWikiLink, toWikiPage } from "../scripts/sync-wiki.ts";

const BLOB = "https://github.com/lochaowei/devguard/blob/main/";

describe("toWikiLink", () => {
  it("turns sibling pages into wiki page names, keeping the anchor", () => {
    expect(toWikiLink("CLI-Reference.md")).toBe("CLI-Reference");
    expect(toWikiLink("CLI-Reference.md#exit-code-定義")).toBe("CLI-Reference#exit-code-定義");
  });

  it("turns repo paths into GitHub blob URLs", () => {
    expect(toWikiLink("../../src/check.ts")).toBe(`${BLOB}src/check.ts`);
    expect(toWikiLink("../../SPEC.md#9-修正fix")).toBe(`${BLOB}SPEC.md#9-修正fix`);
    expect(toWikiLink("../agents/domain.md")).toBe(`${BLOB}docs/agents/domain.md`);
  });

  it("leaves absolute URLs and in-page anchors alone", () => {
    expect(toWikiLink("https://github.com/lochaowei/devguard/releases/latest")).toBe(
      "https://github.com/lochaowei/devguard/releases/latest",
    );
    expect(toWikiLink("mailto:a@example.com")).toBe("mailto:a@example.com");
    expect(toWikiLink("#選項")).toBe("#選項");
  });
});

describe("toWikiPage", () => {
  it("adds a do-not-edit notice and rewrites links", () => {
    const page = toWikiPage("Home.md", "# Home\n\n見 [CLI](CLI-Reference.md) 與 [`check.ts`](../../src/check.ts)。\n");
    expect(page).toBe(
      "<!-- 由 docs/wiki/Home.md 自動同步（scripts/sync-wiki.ts），請勿在 GitHub Wiki 上直接編輯 -->\n" +
        `<sub>此頁由 repo 的 [docs/wiki/Home.md](${BLOB}docs/wiki/Home.md) 自動同步，請到 repo 修改。</sub>\n\n` +
        `# Home\n\n見 [CLI](CLI-Reference) 與 [\`check.ts\`](${BLOB}src/check.ts)。\n`,
    );
  });

  it("gives the sidebar only the hidden comment", () => {
    expect(toWikiPage("_Sidebar.md", "- [Home](Home.md)\n")).toBe(
      "<!-- 由 docs/wiki/_Sidebar.md 自動同步（scripts/sync-wiki.ts），請勿在 GitHub Wiki 上直接編輯 -->\n- [Home](Home)\n",
    );
  });
});

describe("syncWiki", () => {
  it("replaces every wiki page, removing pages that no longer exist in the repo", () => {
    const source = mkdtempSync(join(tmpdir(), "devguard-wiki-src-"));
    const wiki = mkdtempSync(join(tmpdir(), "devguard-wiki-dst-"));
    writeFileSync(join(source, "Home.md"), "# Home\n");
    writeFileSync(join(wiki, "Home.md"), "edited on the web\n");
    writeFileSync(join(wiki, "Old-Page.md"), "gone\n");
    writeFileSync(join(wiki, "logo.png"), "keep");

    expect(syncWiki(source, wiki)).toEqual(["Home.md"]);
    expect(readdirSync(wiki).sort()).toEqual(["Home.md", "logo.png"]);
    expect(readFileSync(join(wiki, "Home.md"), "utf8")).toContain("# Home\n");
  });
});
