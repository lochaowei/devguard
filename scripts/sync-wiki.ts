/**
 * Publishes docs/wiki/ (the source of truth) to a checkout of the GitHub Wiki repo.
 * Every page is replaced, so edits made directly on the wiki are overwritten.
 *
 *   node scripts/sync-wiki.ts <wiki checkout>
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_DIR = "docs/wiki";
const BLOB_URL = "https://github.com/lochaowei/devguard/blob/main/";

/** Rewrites a repo-relative link target into one that resolves on the wiki. */
export function toWikiLink(target: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) return target;
  const [path = "", anchor] = target.split("#", 2);
  const suffix = anchor === undefined ? "" : `#${anchor}`;
  const resolved = posix.normalize(posix.join(SOURCE_DIR, path));
  const page = posix.relative(SOURCE_DIR, resolved);
  if (!page.startsWith("..") && !page.includes("/") && page.endsWith(".md")) return page.slice(0, -3) + suffix;
  return BLOB_URL + resolved + suffix;
}

/** Turns a docs/wiki/ page into its wiki form: wiki-style links plus a do-not-edit notice. */
export function toWikiPage(name: string, text: string): string {
  const body = text.replace(/\]\(([^)\s]+)\)/g, (_, target: string) => `](${toWikiLink(target)})`);
  const source = `${BLOB_URL}${SOURCE_DIR}/${name}`;
  const comment = `<!-- 由 ${SOURCE_DIR}/${name} 自動同步（scripts/sync-wiki.ts），請勿在 GitHub Wiki 上直接編輯 -->\n`;
  // Sidebar and footer pages are shown on every page, so they only get the comment.
  if (name.startsWith("_")) return comment + body;
  return `${comment}<sub>此頁由 repo 的 [${SOURCE_DIR}/${name}](${source}) 自動同步，請到 repo 修改。</sub>\n\n${body}`;
}

/** Replaces every page in `wikiDir` with the transformed pages from `sourceDir`. */
export function syncWiki(sourceDir: string, wikiDir: string): string[] {
  for (const name of readdirSync(wikiDir).filter((f) => f.endsWith(".md"))) rmSync(join(wikiDir, name));
  const pages = readdirSync(sourceDir).filter((f) => f.endsWith(".md"));
  for (const name of pages) {
    writeFileSync(join(wikiDir, name), toWikiPage(name, readFileSync(join(sourceDir, name), "utf8")));
  }
  return pages;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const wikiDir = process.argv[2];
  if (wikiDir === undefined) {
    console.error("用法：node scripts/sync-wiki.ts <wiki checkout>");
    process.exit(2);
  }
  for (const name of syncWiki(SOURCE_DIR, wikiDir)) console.log(`synced ${name}`);
}
