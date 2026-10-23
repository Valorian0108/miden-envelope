import { describe, expect, it } from "vitest";
import * as M from "../src/envelope/metric";
import * as T from "../src/envelope/tags";

function hexFromBits(bits: string): string {
  let h = "";
  for (let i = 0; i < bits.length; i += 4) h += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return "0x" + h;
}
function idWithPrefix(prefix: number, k: number, tail = "0"): string {
  const head = prefix.toString(2).padStart(k, "0");
  return hexFromBits((head + tail.repeat(120 - k)).slice(0, 120));
}

/** Four accounts: three crowded into one k=7 block, one alone. */
const CROWD = [
  idWithPrefix(0b0100011, 7),
  idWithPrefix(0b0100011, 7, "1"),
  idWithPrefix(0b0100011, 7, "01"),
  idWithPrefix(0b1010101, 7),
];

describe("the closed form", () => {
  it("is the sample-independent unique rate", () => {
    // (1 - 2^-7)^127 — the mean a 128-account crowd shows at k = 7
    expect(M.predictedUniqueRate(7, 128)).toBeCloseTo(Math.pow(1 - 1 / 128, 127), 12);
  });
  it("rises towards 1 as k widens and falls as the crowd grows", () => {
    expect(M.predictedUniqueRate(14, 128)).toBeGreaterThan(M.predictedUniqueRate(7, 128));
    expect(M.predictedUniqueRate(7, 1000)).toBeLessThan(M.predictedUniqueRate(7, 128));
  });
  it("a crowd of one is always named", () => {
    expect(M.predictedUniqueRate(7, 1)).toBe(1);
  });
  it("expected pairs is the birthday count", () => {
    expect(M.predictedPairs(7, 128)).toBeCloseTo((128 * 127) / 2 / 128, 12);
  });
  it("predictedLinked is all notes when the pool is one tag", () => {
    expect(M.predictedLinked(6, 1)).toBe(6);
    expect(M.predictedLinked(0, 128)).toBe(0);
  });
});

describe("census", () => {
  it("counts a known crowd exactly", () => {
    const row = M.census(CROWD, [7])[0];
    expect(row.accounts).toBe(4);
    expect(row.occupiedBlocks).toBe(2);
    expect(row.largestBlock).toBe(3);
    expect(row.alone).toBe(1);
    expect(row.uniqueRate).toBeCloseTo(0.25, 12);
    expect(row.meanSet).toBeCloseTo((9 + 1) / 4, 12);
    expect(row.pairs).toBe(3);
  });
  it("at k = 14 every account stands alone", () => {
    const row = M.census(CROWD, [14])[0];
    expect(row.alone).toBe(4);
    expect(row.uniqueRate).toBe(1);
    expect(row.largestBlock).toBe(1);
  });
  it("refuses an empty directory", () => {
    expect(() => M.census([], [7])).toThrow(RangeError);
  });
});

describe("occupancy and candidates", () => {
  it("occupancy counts the account itself", () => {
    expect(M.occupancyOf(CROWD, CROWD[0], 7)).toBe(3);
    expect(M.occupancyOf(CROWD, CROWD[3], 7)).toBe(1);
  });
  it("a tag names exactly the directory members in its block", () => {
    const tag = T.coarseTag(CROWD[0], 7);
    expect(M.candidatesForTag(CROWD, tag, 7)).toHaveLength(3);
    expect(M.candidatesForTag(CROWD, T.coarseTag(CROWD[3], 7), 7)).toEqual([CROWD[3].slice(2)]);
  });
  it("a non-default-shaped tag names nobody", () => {
    expect(M.candidatesForTag(CROWD, 0x8e180001, 7)).toEqual([]);
  });
});

describe("the tag-only observer", () => {
  it("six identical labels link all six", () => {
    const p = M.linkProfile([0x8e180000, 0x8e180000, 0x8e180000, 0x8e180000, 0x8e180000, 0x8e180000]);
    expect(p.linked).toBe(6);
    expect(p.linkRate).toBe(1);
    expect(p.distinctTags).toBe(1);
  });
  it("six distinct labels link none", () => {
    const tags = T.poolFor("0x8e1bed3ae2cca241746ef1ca4bf1ec", 7).slice(0, 6);
    const p = M.linkProfile(tags);
    expect(p.linked).toBe(0);
    expect(p.linkRate).toBe(0);
  });
});

describe("reconstruction", () => {
  it("reports the directory observer and the tag-only observer together", () => {
    const m = M.reconstruction(CROWD, {}, 7);
    expect(m.accounts).toBe(4);
    expect(m.attribution).toBeCloseTo(0.25, 12);
    expect(m.poolTags).toBe(128);
    expect(m.requests).toBe(1);
    expect(m.reads).toContain("k= 7");
  });
  it("observed attribution is 0-or-1 per receiver, because the block is fixed", () => {
    const crowded = CROWD[0];
    const alone = CROWD[3];
    const tags = [T.blindedTag(crowded, 7, () => 0.1), T.blindedTag(alone, 7, () => 0.2)];
    const m = M.reconstruction(CROWD, { [crowded.slice(2)]: [tags[0]], [alone.slice(2)]: [tags[1]] }, 7);
    expect(m.observedAttribution).toBeCloseTo(0.5, 12);
  });
});
