import { createInterface } from "node:readline/promises";

/** How a command that changes files talks to the person running it. */
export interface Interaction {
  /** `--yes`: apply without asking. */
  yes: boolean;
  /** stdin and stdout are a terminal, so a question can be answered. */
  interactive: boolean;
  confirm(question: string): Promise<boolean>;
  write(text: string): void;
}

export interface PendingChanges {
  /** What would change (diffs, regenerated files) plus anything only printed (snippets). */
  preview: string;
  /** There is something to write; false when the preview is all there is. */
  pending: boolean;
  apply(): Promise<void>;
}

/**
 * The one place for the interaction rules of `fix` and `fix --code` (SPEC §9.3): an interactive terminal previews and
 * applies after confirmation; `--yes` applies directly; a non-interactive run without `--yes` only previews and exits
 * non-zero. Returns the exit code.
 */
export async function previewThenApply(io: Interaction, changes: PendingChanges, applyFlag = "--yes"): Promise<0 | 1> {
  io.write(changes.preview);
  if (!changes.pending) return 0;
  if (!io.yes) {
    if (!io.interactive) {
      io.write(`非互動環境：只預覽，沒有套用。加上 ${applyFlag} 才會套用。\n`);
      return 1;
    }
    if (!(await io.confirm("要套用以上修改嗎？[y/N] "))) {
      io.write("沒有套用任何修改。\n");
      return 1;
    }
  }
  await changes.apply();
  io.write("已套用。\n");
  return 0;
}

/** The real terminal: interactive when both stdin and stdout are a TTY; any answer starting with y confirms. */
export function terminalInteraction(yes: boolean): Interaction {
  return {
    yes,
    interactive: process.stdin.isTTY && process.stdout.isTTY,
    write: (text) => process.stdout.write(text),
    async confirm(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^y/i.test((await rl.question(question)).trim());
      } finally {
        rl.close();
      }
    },
  };
}
