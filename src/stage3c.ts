// Stage 3c — Phase D re-run with a correct counter.
//
// Stage 3's Phase D restarted its index each step, so most `tags.add` calls were
// duplicates of tags already registered. That accidentally proved idempotence —
// `tags.list()` returned exactly 4096 + 104 — but it meant the per-tag costs were
// measured on duplicate writes, not on a growing distinct set.
//
// This re-runs it properly: one running counter, every tag distinct, and no
// accounts in the client so the auto-registered baseline is zero and
// `tags.list()` must equal the number added.

import * as SDK from "@miden-sdk/miden-sdk";
import * as T from "./envelope/tags";

const out = document.getElementById("out")!;
const lines: string[] = [];
const checks: { name: string; ok: boolean; detail: string }[] = [];
const state = {
  status: "running" as "running" | "pass" | "fail",
  lines,
  checks,
  cost: [] as Record<string, unknown>[],
};
(window as any).__STAGE3C__ = state;

function log(s: string) {
  lines.push(s);
  out.textContent = lines.join("\n");
}
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  log((ok ? "   ok " : "  FAIL") + "  " + name + (detail ? "   " + detail : ""));
}
const E = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0].slice(0, 200);

async function wipeStores(): Promise<void> {
  try {
    const dbs = await indexedDB.databases();
    await Promise.all(
      dbs.map(
        (d) =>
          new Promise<void>((resolve) => {
            if (!d.name) return resolve();
            const req = indexedDB.deleteDatabase(d.name);
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            req.onblocked = () => resolve();
            setTimeout(resolve, 2000);
          }),
      ),
    );
  } catch { /* ignore */ }
}

async function main() {
  const t0 = performance.now();
  const { MidenClient } = SDK as any;

  log("stage 3c — how many distinct tags will a client track, and what does each cost");
  log("");

  await wipeStores();
  const client = await MidenClient.createMock();
  log("client up in " + Math.round(performance.now() - t0) + " ms");

  const baseline = (await client.tags.list()).length;
  log("baseline tags with no accounts in the client: " + baseline);

  let next = 0;
  const steps = [128, 128, 256, 512, 1024, 2048];
  for (const step of steps) {
    const t = performance.now();
    let err: string | null = null;
    try {
      for (let i = 0; i < step; i++) {
        await client.tags.add(((next++) << T.RESERVED_LOW_BITS) >>> 0);
      }
    } catch (e) {
      err = E(e);
    }
    const ms = performance.now() - t;
    state.cost.push({ step, total: next, ms: Math.round(ms), perTag: +(ms / step).toFixed(2), error: err });
    log(`  +${String(step).padStart(5)} distinct tags → ${String(next).padStart(5)} total`
      + `   ${String(Math.round(ms)).padStart(6)} ms   ${(ms / step).toFixed(1)} ms/tag`
      + (err ? "   ERROR: " + err : ""));
    if (err) break;
  }

  const listed = (await client.tags.list()).length;
  log("");
  log("tags.list() returns " + listed);

  // Idempotence, stated rather than inferred.
  await client.tags.add(0);
  await client.tags.add(((next - 1) << T.RESERVED_LOW_BITS) >>> 0);
  const afterDup = (await client.tags.list()).length;
  log("after re-adding the first and last tag: " + afterDup);

  // Removal, since the library will need to rotate a pool.
  let afterRemove = -1;
  try {
    await client.tags.remove(0);
    afterRemove = (await client.tags.list()).length;
    log("after removing one tag: " + afterRemove);
  } catch (e) {
    log("tags.remove failed: " + E(e));
  }

  check("no client-side ceiling up to " + next + " distinct tags", listed === next, `listed=${listed} added=${next}`);
  check("re-adding an existing tag does not duplicate it", afterDup === listed, `${listed} → ${afterDup}`);
  check("tags.remove() takes one back out", afterRemove === listed - 1, `${listed} → ${afterRemove}`);
  check(
    "per-tag cost grows as the set grows",
    state.cost.length >= 4 &&
      (state.cost[state.cost.length - 1].perTag as number) > (state.cost[0].perTag as number) * 3,
    `${state.cost[0]?.perTag} ms/tag at ${state.cost[0]?.step} → ${state.cost[state.cost.length - 1]?.perTag} ms/tag at ${state.cost[state.cost.length - 1]?.total}`
  );
  check(
    "a 128-tag pool registers in well under a second",
    (state.cost[0]?.ms as number) < 1000,
    state.cost[0]?.ms + " ms for the first 128"
  );

  log("");
  log("what that means for the library:");
  for (const k of [4, 5, 6, 7, 8, 10, 14]) {
    log(`  k=${String(k).padStart(2)}  pool ${String(T.poolSize(k)).padStart(5)} tags`
      + `  → ${T.requestsForPool(k)} transport request(s)`);
  }

  log("");
  log("done in " + Math.round(performance.now() - t0) + " ms");
  const failed = checks.filter((c) => !c.ok);
  state.status = failed.length === 0 ? "pass" : "fail";
  log(failed.length === 0 ? "PASS" : "FAILED " + failed.length + ": " + failed.map((c) => c.name).join(" | "));

  try { await (client as any)[Symbol.asyncDispose](); } catch { try { client.terminate(); } catch { /* ignore */ } }
}

main().catch((e) => {
  log("");
  log("FAIL: " + E(e));
  state.status = "fail";
});
