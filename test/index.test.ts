import { describe, expect, it } from "vitest";
import * as lib from "../src/envelope/index";

/**
 * The barrel must stay SDK-free. Importing it here, in plain Node with no WASM
 * binary available, is the assertion: if send.ts ever leaks back into the
 * barrel this file fails to load on every machine without the SDK.
 */
describe("the barrel", () => {
  it("imports with no SDK present", () => {
    expect(typeof lib.poolFor).toBe("function");
    expect(typeof lib.blindedTag).toBe("function");
    expect(typeof lib.census).toBe("function");
    expect(typeof lib.reconstruction).toBe("function");
    expect(typeof lib.fetchPool).toBe("function");
    expect(typeof lib.planFetch).toBe("function");
  });
  it("does not re-export the send path", () => {
    expect("sendEnvelope" in lib).toBe(false);
  });
  it("exposes the transport constants exactly once", () => {
    expect(lib.MAX_TAGS_PER_REQUEST).toBe(128);
    expect(lib.TRANSPORT_NOTE_CAP).toBe(500);
  });
});
