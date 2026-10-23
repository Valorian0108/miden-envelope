import { describe, expect, it, vi } from "vitest";

/* send.ts imports the SDK at module scope for the send path. The planning half
   never touches it, and the SDK has no Windows binary, so the test mocks the
   module away rather than loading WASM. */
vi.mock("@miden-sdk/miden-sdk", () => ({}));

const { planBatch, planEnvelope } = await import("../src/envelope/send");
const T = await import("../src/envelope/tags");

const REAL = "0x8e1bed3ae2cca241746ef1ca4bf1ec";

describe("planEnvelope", () => {
  it("defaults to k = 7, the coarsest width that fits one request", () => {
    const p = planEnvelope(REAL);
    expect(p.k).toBe(7);
    expect(p.poolSize).toBe(128);
    expect(p.defaultTag).toBe(0x8e180000);
    expect(T.poolContains(REAL, 7, p.tag)).toBe(true);
  });
  it("a blinded plan almost never lands on the default tag", () => {
    let hits = 0;
    for (let i = 0; i < 400; i++) if (planEnvelope(REAL).landedOnDefault) hits++;
    expect(hits).toBeLessThan(20); // expectation 400/128 ≈ 3.1
  });
  it("an explicit tag inside the pool is honoured", () => {
    const p = planEnvelope(REAL, { tag: T.defaultTag(REAL) });
    expect(p.tag).toBe(T.defaultTag(REAL));
    expect(p.landedOnDefault).toBe(true);
  });
  it("a tag outside the pool is refused — it would orphan the note", () => {
    const stranger = T.defaultTag("0x3d98cf80d8c5e3411436c4fb243984");
    expect(() => planEnvelope(REAL, { tag: stranger })).toThrow(RangeError);
  });
  it("the plan is pure: same seed, same tag", () => {
    const a = planEnvelope(REAL, { rng: () => 0.5 });
    const b = planEnvelope(REAL, { rng: () => 0.5 });
    expect(a.tag).toBe(b.tag);
  });
});

describe("planBatch", () => {
  it("spreads n payments over the pool", () => {
    const plans = planBatch(REAL, 60);
    expect(plans).toHaveLength(60);
    expect(new Set(plans.map((p) => p.tag)).size).toBeGreaterThan(20);
  });
  it("a seeded batch is reproducible", () => {
    const lcg = (seed: number) => {
      let s = seed;
      return () => (s = (s * 16807) % 2147483647) / 2147483647;
    };
    const a = planBatch(REAL, 12, { rng: lcg(1) });
    const b = planBatch(REAL, 12, { rng: lcg(1) });
    expect(a.map((p) => p.tag)).toEqual(b.map((p) => p.tag));
  });
});
