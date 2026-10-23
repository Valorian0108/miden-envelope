import { describe, expect, it } from "vitest";
import * as F from "../src/envelope/fetch";
import * as T from "../src/envelope/tags";

const POOL = T.poolFor("0x8e1bed3ae2cca241746ef1ca4bf1ec", 7); // 128 tags

/**
 * The smallest client the library will talk to: a tag set, a note store keyed by
 * tag, and a sync that copies matching notes into the list. Enough to exercise
 * batching, dedup and saturation without the SDK.
 */
function stubClient(notesByTag: Map<number, string[]>) {
  const registered = new Set<number>();
  const store = new Map<string, true>();
  return {
    registered,
    tags: {
      add: async (tag: number) => { registered.add(tag); },
      remove: async (tag: number) => { registered.delete(tag); },
    },
    sync: async () => {
      for (const tag of registered) {
        for (const id of notesByTag.get(tag) ?? []) store.set(id, true);
      }
    },
    notes: { list: async () => Array.from(store.keys()).map((id) => ({ id: () => id })) },
  };
}

describe("planFetch", () => {
  it("splits 128 tags into four batches of 32 by default", () => {
    const plan = F.planFetch(POOL);
    expect(plan).toHaveLength(4);
    expect(plan.every((b) => b.length === 32)).toBe(true);
    expect(F.assertPoolCovered(POOL, plan)).toBeUndefined();
  });
  it("one batch of 128 is allowed and is exactly the ceiling", () => {
    expect(F.planFetch(POOL, 128)).toHaveLength(1);
  });
  it("wider than the transport ceiling is refused", () => {
    expect(() => F.planFetch(POOL, 129)).toThrow(RangeError);
    expect(() => F.planFetch(POOL, 0)).toThrow(RangeError);
    expect(() => F.planFetch([])).toThrow(RangeError);
  });
});

describe("describePlan", () => {
  it("states the headroom against a single request", () => {
    const d = F.describePlan(128, 32);
    expect(d.batches).toBe(4);
    expect(d.budget).toBe(2000);
    expect(d.seams).toContain("4 request(s)");
    expect(d.seams).toContain("4.0×");
  });
});

describe("fetchPool", () => {
  it("recovers every note exactly once across batches", async () => {
    const byTag = new Map<number, string[]>();
    byTag.set(POOL[0], ["n1", "n2"]);
    byTag.set(POOL[40], ["n2", "n3"]); // n2 also filed under another tag: dedup must catch it
    byTag.set(POOL[127], ["n4"]);
    const r = await F.fetchPool(stubClient(byTag), POOL);
    expect(r.total).toBe(4);
    expect(r.requests).toBe(4);
    expect(r.saturatedBatches).toBe(0);
    expect(r.batches.map((b) => b.found)).toEqual([2, 1, 0, 1]);
  });
  it("reports a batch that hit the cap instead of hiding it", async () => {
    const byTag = new Map<number, string[]>();
    const flood = Array.from({ length: 500 }, (_, i) => "f" + i);
    byTag.set(POOL[0], flood);
    const r = await F.fetchPool(stubClient(byTag), POOL.slice(0, 32), { tagsPerRequest: 32 });
    expect(r.batches[0].saturated).toBe(true);
    expect(r.saturatedBatches).toBe(1);
  });
  it("a batch returning more than the cap is not saturation — the cap did not apply", async () => {
    const byTag = new Map<number, string[]>();
    byTag.set(POOL[0], Array.from({ length: 600 }, (_, i) => "g" + i));
    const r = await F.fetchPool(stubClient(byTag), POOL.slice(0, 32), { cap: 500 });
    expect(r.batches[0].saturated).toBe(false);
  });
  it("a throwing batch is recorded and the rest of the plan still runs", async () => {
    const c = stubClient(new Map());
    let calls = 0;
    c.sync = async () => { if (++calls === 1) throw new Error("transport down"); };
    const r = await F.fetchPool(c, POOL.slice(0, 64), { tagsPerRequest: 32 });
    expect(r.batches[0].error).toContain("transport down");
    expect(r.batches[1].error).toBeUndefined();
    expect(r.requests).toBe(1);
  });
  it("removeAfterBatch unregisters each batch's tags", async () => {
    const c = stubClient(new Map());
    await F.fetchPool(c, POOL.slice(0, 64), { tagsPerRequest: 32, removeAfterBatch: true });
    expect(c.registered.size).toBe(0);
  });
  it("maxBatches bounds the run", async () => {
    const r = await F.fetchPool(stubClient(new Map()), POOL, { maxBatches: 2 });
    expect(r.batches).toHaveLength(2);
  });
  it("onBatch fires once per batch, in order", async () => {
    const seen: number[] = [];
    await F.fetchPool(stubClient(new Map()), POOL, { onBatch: (b) => seen.push(b.index) });
    expect(seen).toEqual([0, 1, 2, 3]);
  });
});
