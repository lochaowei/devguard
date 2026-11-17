const escape = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/**
 * Reads syntax a dialect adds to the common globs (EditorConfig's braces and character classes): the regex source for
 * what starts at `at` in `glob` and how many characters it used, or undefined when the common rules apply there.
 */
export type GlobExtension = (glob: string, at: number) => { source: string; length: number } | undefined;

/**
 * A glob as regex source: `**` crosses directories (`**` + `/` also matches no directory at all), `*` and `?` stay
 * within one path segment, everything else is literal. Every glob dialect in the CLI starts here.
 */
export function globSource(glob: string, extension?: GlobExtension): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const extra = extension?.(glob, i);
    if (extra) {
      out += extra.source;
      i += extra.length - 1;
      continue;
    }
    const c = glob.charAt(i);
    if (glob.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 2;
    } else if (glob.startsWith("**", i)) {
      out += ".*";
      i += 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += escape(c);
  }
  return out;
}
