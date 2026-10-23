import { describe, expect, it } from "vitest";
import * as T from "../src/envelope/tags";

/** The one real account id recorded from a mock-chain run (capture/v8). */
const REAL = "0x8e1bed3ae2cca241746ef1ca4bf1ec";

function hexFromBits(bits: string): string {
  let h = "";
  for (let i = 0; i < bits.length; i += 4) h += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return "0x" + h;
}

/** An id whose top `k` bits are `prefix`; the rest is a fixed pattern. */
function idWithPrefix(prefix: number, k: number, tail = "0"): string {
  const head = prefix.toString(2).padStart(k, "0");
  return hexFromBits((head + tail.repeat(120 - k)).slice(0, 120));
}

describe("normalizeId", () => {
  it("accepts the real id with or without 0x and in any case", () => {
    expect(T.normalizeId(REAL)).toBe(REAL.slice(2));
    expect(T.normalizeId(REAL.slice(2).toUpperCase())).toBe(REAL.slice(2));
  });
  it("rejects wrong width and non-hex", () => {
    expect(() => T.normalizeId("0x8e1b")).toThrow(RangeError);
    expect(() => T.normalizeId("0x" + "z".repeat(30))).toThrow(RangeError);
  });
});

describe("the tag model", () => {
  it("reproduces the recorded default tag of the real account", () => {
    // capture/v8-stage6-metric.md: target default tag 0x8e180000
    expect(T.defaultTag(REAL)).toBe(0x8e180000);
  });
  it("an account id is 120 bits and renders as 120 characters", () => {
    expect(T.accountIdBits(REAL)).toHaveLength(120);
    expect(T.accountIdBits(REAL)).toMatch(/^[01]+$/);
  });
  it("every default-shaped tag has the low 18 bits clear", () => {
    expect(T.isDefaultShaped(T.defaultTag(REAL))).toBe(true);
    expect(T.isDefaultShaped(0x8e180001)).toBe(false);
  });
  it("coarseTag agrees with defaultTag at k = 14", () => {
    expect(T.coarseTag(REAL, 14)).toBe(T.defaultTag(REAL));
  });
  it("k outside 1..14 is refused", () => {
    expect(() => T.coarseTag(REAL, 0)).toThrow(RangeError);
    expect(() => T.coarseTag(REAL, 15)).toThrow(RangeError);
    expect(() => T.poolSize(15)).toThrow(RangeError);
  });
});

describe("pools", () => {
  it("the pool at k = 7 has 128 tags and fits one request", () => {
    expect(T.poolSize(7)).toBe(128);
    expect(T.poolFor(REAL, 7)).toHaveLength(128);
    expect(T.requestsForPool(7)).toBe(1);
    expect(T.MIN_K_ONE_REQUEST).toBe(7);
  });
  it("the pool at k = 6 needs two requests", () => {
    expect(T.poolSize(6)).toBe(256);
    expect(T.requestsForPool(6)).toBe(2);
  });
  it("the receiver's own default tag is always in their pool", () => {
    for (const k of [1, 7, 10, 14]) {
      expect(T.poolFor(REAL, k)).toContain(T.defaultTag(REAL));
    }
  });
  it("every pool member is default-shaped and shares the top k bits", () => {
    const pool = T.poolFor(REAL, 7);
    for (const tag of pool) {
      expect(T.isDefaultShaped(tag)).toBe(true);
      expect(T.tagPrefix(tag, 7)).toBe(T.accountIdPrefix(REAL, 7));
    }
  });
  it("two accounts share a pool exactly when their top k bits agree", () => {
    const a = idWithPrefix(0b0100011, 7);
    const b = idWithPrefix(0b0100011, 7, "1");
    const c = idWithPrefix(0b0100010, 7);
    expect(T.sharesPool(a, b, 7)).toBe(true);
    expect(T.sharesPool(a, c, 7)).toBe(false);
    expect(T.poolContains(a, 7, T.blindedTag(b, 7, () => 0.5))).toBe(true);
    expect(T.poolContains(c, 7, T.blindedTag(b, 7, () => 0.5))).toBe(false);
  });
});

describe("blinding", () => {
  it("a blinded tag stays inside the receiver's pool", () => {
    for (let i = 0; i < 200; i++) {
      const tag = T.blindedTag(REAL, 7);
      expect(T.poolContains(REAL, 7, tag)).toBe(true);
    }
  });
  it("a seeded rng is reproducible", () => {
    const a = T.blindedTag(REAL, 7, () => 0.25);
    const b = T.blindedTag(REAL, 7, () => 0.25);
    expect(a).toBe(b);
    expect(a).toBe(T.poolFor(REAL, 7)[32]);
  });
  it("an out-of-range rng is refused rather than wrapped", () => {
    expect(() => T.blindedTag(REAL, 7, () => 1)).toThrow(RangeError);
  });
});

describe("describeTag", () => {
  it("renders eight hex digits", () => {
    expect(T.describeTag(0x8e180000)).toBe("0x8e180000");
    expect(T.describeTag(1)).toBe("0x00000001");
  });
});
