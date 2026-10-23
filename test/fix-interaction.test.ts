import { describe, expect, it } from "vitest";
import { previewThenApply, type Interaction } from "../src/fix/interaction.ts";

function io(over: Partial<Interaction> & { answer?: boolean } = {}) {
  const out: string[] = [];
  const asked: string[] = [];
  const session: Interaction = {
    yes: false,
    interactive: false,
    write: (t) => out.push(t),
    confirm: (q) => {
      asked.push(q);
      return Promise.resolve(over.answer ?? false);
    },
    ...over,
  };
  return { session, out, asked };
}

function changes() {
  const applied: string[] = [];
  return {
    applied,
    plan: { preview: "PREVIEW\n", pending: true, apply: () => Promise.resolve(void applied.push("x")) },
  };
}

describe("previewThenApply (SPEC §9.3, shared by fix and fix --code)", () => {
  it("--yes applies without asking", async () => {
    const { session, asked, out } = io({ yes: true });
    const { plan, applied } = changes();
    expect(await previewThenApply(session, plan)).toBe(0);
    expect(applied).toHaveLength(1);
    expect(asked).toHaveLength(0);
    expect(out.join("")).toContain("PREVIEW");
  });

  it("an interactive terminal previews, then applies once confirmed", async () => {
    const { session, asked, out } = io({ interactive: true, answer: true });
    const { plan, applied } = changes();
    expect(await previewThenApply(session, plan)).toBe(0);
    expect(out[0]).toBe("PREVIEW\n");
    expect(asked).toHaveLength(1);
    expect(applied).toHaveLength(1);
  });

  it("an interactive terminal that declines changes nothing and exits non-zero", async () => {
    const { session } = io({ interactive: true, answer: false });
    const { plan, applied } = changes();
    expect(await previewThenApply(session, plan)).toBe(1);
    expect(applied).toHaveLength(0);
  });

  it("non-interactive without --yes only previews and exits non-zero", async () => {
    const { session, asked, out } = io();
    const { plan, applied } = changes();
    expect(await previewThenApply(session, plan)).toBe(1);
    expect(applied).toHaveLength(0);
    expect(asked).toHaveLength(0);
    expect(out.join("")).toContain("--yes");
  });

  it("nothing to apply passes without asking", async () => {
    const { session, asked } = io({ interactive: true });
    const { plan, applied } = changes();
    expect(await previewThenApply(session, { ...plan, pending: false })).toBe(0);
    expect(asked).toHaveLength(0);
    expect(applied).toHaveLength(0);
  });
});
