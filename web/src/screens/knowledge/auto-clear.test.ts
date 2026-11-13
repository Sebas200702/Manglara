import { describe, expect, test } from "bun:test";
import type { KnowledgeSource } from "../../lib/knowledge-client";
import { createAutoClear } from "./auto-clear";
import { patchSourceIn } from "./knowledge-screen-store";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createAutoClear", () => {
  test("a replaced value keeps its own full lifetime", async () => {
    const seen: (string | null)[] = [];
    const slot = createAutoClear<string>((v) => seen.push(v), 40);
    slot.show("first");
    await wait(25);
    slot.show("second");
    await wait(25);
    // the first timer would have fired here; the second value must survive
    expect(seen).toEqual(["first", "second"]);
    await wait(30);
    expect(seen).toEqual(["first", "second", null]);
  });

  test("clear hides immediately and cancels the pending timer", async () => {
    const seen: (string | null)[] = [];
    const slot = createAutoClear<string>((v) => seen.push(v), 20);
    slot.show("x");
    slot.clear();
    await wait(30);
    expect(seen).toEqual(["x", null]);
  });
});

describe("patchSourceIn", () => {
  const row = (id: string, active: boolean) =>
    ({ id, active, status: "ready" }) as KnowledgeSource;

  test("patches only the matching row and keeps order", () => {
    const list = [row("a", false), row("b", false)];
    const next = patchSourceIn(list, "b", { active: true });
    expect(next.map((r) => [r.id, r.active])).toEqual([
      ["a", false],
      ["b", true],
    ]);
    expect(next[0]).toBe(list[0]);
    expect(list[1].active).toBe(false);
  });

  test("returns the same list when the id is unknown", () => {
    const list = [row("a", false)];
    expect(patchSourceIn(list, "zz", { active: true })).toBe(list);
  });
});
