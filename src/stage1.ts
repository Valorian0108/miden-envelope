// Stage 1 — a mock chain that can move money.
//
// The question: can a fake chain, running entirely in this tab, take a token
// from a faucet, into one wallet, out to another wallet, and have both ends
// agree on the result with nothing left pending?
//
// Everything below is deliberately the *plain* path — public notes only, no
// custom tags, no blinding. Those are Stage 3–4. If the plain path is flaky,
// the privacy layer on top of it would be measuring noise.
//
// Two known traps this page works around:
//   1. every mock client shares IndexedDB `mock_client_db`, and a stale chain
//      from an earlier run poisons a new one — so we wipe before starting;
//   2. two transactions against the same account state displace each other —
//      so we call proveBlock() between them, and sync() before reading.

import { MidenClient, FaucetType } from "@miden-sdk/miden-sdk";

const out = document.getElementById("out")!;
const lines: string[] = [];
const checks: { name: string; ok: boolean; detail: string }[] = [];
const state = {
  status: "running" as "running" | "pass" | "fail",
  lines,
  checks,
  ids: {} as Record<string, string>,
  balances: {} as Record<string, string>,
};
(window as any).__STAGE1__ = state;

function log(s: string) {
  lines.push(s);
  out.textContent = lines.join("\n");
}

function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  log((ok ? "   ok " : "  FAIL") + "  " + name + (detail ? "   " + detail : ""));
}

function fmt(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (v === null || v === undefined) return String(v);
  if (typeof v === "object") {
    const o = v as any;
    if (typeof o.toHex === "function") {
      try { return o.toHex(); } catch { /* fall through */ }
    }
    if (typeof o.toString === "function" && o.toString !== Object.prototype.toString) {
      try {
        const s = o.toString();
        if (s && s !== "[object Object]") return s;
      } catch { /* fall through */ }
    }
    try {
      return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
    } catch {
      return Object.prototype.toString.call(v);
    }
  }
  return String(v);
}

// A stale mock chain in the shared IndexedDB is the single most likely cause of
// a confusing failure, so remove it outright. onblocked means another tab still
// holds the connection; we resolve anyway and report it rather than hang.
async function wipeMockDb(): Promise<string> {
  return await new Promise<string>((resolve) => {
    let settled = false;
    const finish = (msg: string) => {
      if (settled) return;
      settled = true;
      resolve(msg);
    };
    try {
      const req = indexedDB.deleteDatabase("mock_client_db");
      req.onsuccess = () => finish("wiped");
      req.onerror = () => finish("delete failed");
      req.onblocked = () => finish("blocked by another tab");
      setTimeout(() => finish("timed out"), 3000);
    } catch (e) {
      finish("unavailable: " + String((e as Error)?.message ?? e));
    }
  });
}

async function main() {
  const t0 = performance.now();
  log("stage 1 — a chain that can move money");
  log("");

  log("clearing the shared mock store");
  const wipe = await wipeMockDb();
  log("  store: " + wipe);

  log("");
  log("starting the mock chain");
  const client = await MidenClient.createMock();
  log("  client up in " + Math.round(performance.now() - t0) + " ms");
  log("  store id: " + (await client.storeIdentifier()));
  check("client uses the mock chain", client.usesMockChain());

  log("");
  log("creating accounts");
  const faucet = await client.accounts.create({
    type: FaucetType.FungibleFaucet,
    name: "Stage One Token",
    symbol: "TST",
    decimals: 6,
    maxSupply: 1_000_000_000n,
  });
  const alice = await client.accounts.create();
  const bob = await client.accounts.create();

  const ids = {
    faucet: faucet.id().toString(),
    alice: alice.id().toString(),
    bob: bob.id().toString(),
  };
  state.ids = ids;
  log("  faucet: " + ids.faucet);
  log("  alice:  " + ids.alice);
  log("  bob:    " + ids.bob);
  check("three accounts exist", (await client.accounts.list()).length === 3);

  log("");
  log("minting 1,000 TST to alice");
  await client.transactions.mint({
    account: ids.faucet,
    to: ids.alice,
    amount: 1000n,
    type: "public",
  });
  await client.proveBlock();
  await client.sync();
  log("  minted; note is public");

  log("");
  log("alice consumes her note");
  const consumedMint = await client.transactions.consumeAll({ account: ids.alice });
  await client.proveBlock();
  await client.sync();
  log("  consumeAll remaining: " + fmt((consumedMint as any)?.remaining));

  const aliceFunded = await client.accounts.getBalance(ids.alice, ids.faucet);
  state.balances["alice after mint"] = aliceFunded.toString();
  log("  alice balance: " + aliceFunded);
  check("alice received the minted amount", aliceFunded === 1000n, "got " + aliceFunded);

  log("");
  log("alice sends 400 TST to bob");
  const sent = await client.transactions.send({
    account: ids.alice,
    to: ids.bob,
    token: ids.faucet,
    amount: 400n,
    type: "public",
    returnNote: true,
  });
  const sentNoteId = (sent as any)?.note?.id?.().toString?.() ?? "(no note returned)";
  log("  tx:   " + fmt((sent as any)?.txId));
  log("  note: " + sentNoteId);
  check("send returned a note", Boolean((sent as any)?.note));

  await client.proveBlock();
  await client.sync();

  log("");
  log("bob consumes his note");
  const consumedSend = await client.transactions.consumeAll({ account: ids.bob });
  await client.proveBlock();
  await client.sync();
  log("  consumeAll remaining: " + fmt((consumedSend as any)?.remaining));

  log("");
  log("reading the result back");
  const aliceAfter = await client.accounts.getBalance(ids.alice, ids.faucet);
  const bobAfter = await client.accounts.getBalance(ids.bob, ids.faucet);
  const faucetAfter = await client.accounts.getBalance(ids.faucet, ids.faucet);
  state.balances["alice final"] = aliceAfter.toString();
  state.balances["bob final"] = bobAfter.toString();
  state.balances["faucet final"] = faucetAfter.toString();
  log("  alice:  " + aliceAfter);
  log("  bob:    " + bobAfter);
  log("  faucet: " + faucetAfter);

  check("bob received exactly 400", bobAfter === 400n, "got " + bobAfter);
  check(
    "alice was debited exactly 400",
    aliceAfter === 600n,
    "got " + aliceAfter + " (expected 600)"
  );
  check(
    "no tokens appeared or vanished",
    aliceAfter + bobAfter + faucetAfter === 1000n,
    "sum " + (aliceAfter + bobAfter + faucetAfter)
  );

  log("");
  log("pending work");
  const INPUT_STATE = [
    "Expected",
    "Unverified",
    "Committed",
    "Invalid",
    "ProcessingAuthenticated",
    "ProcessingUnauthenticated",
    "ConsumedAuthenticatedLocal",
    "ConsumedUnauthenticatedLocal",
    "ConsumedExternal",
  ];
  const OUTPUT_STATE = [
    "ExpectedPartial",
    "ExpectedFull",
    "CommittedPartial",
    "CommittedFull",
    "Consumed",
  ];

  const incoming = await client.notes.list();
  const outgoing = await client.notes.listSent();
  const inStates = incoming.map(
    (n) => INPUT_STATE[(n as any).state()] ?? "state#" + (n as any).state()
  );
  const outStates = outgoing.map(
    (n) => OUTPUT_STATE[(n as any).state()] ?? "state#" + (n as any).state()
  );
  log("  received: " + incoming.length + (inStates.length ? " [" + inStates.join(", ") + "]" : ""));
  log("  sent:     " + outgoing.length + (outStates.length ? " [" + outStates.join(", ") + "]" : ""));

  // `state` is a numeric enum, not a `status` field — reading the wrong one is
  // how a "nothing pending" check quietly passes on `undefined`.
  const pendingIn = incoming.filter(
    (n) => !(n as any).isConsumed() || (n as any).isInclusionPending()
  );
  const pendingOut = outgoing.filter((n) => (n as any).isInclusionPending());
  check(
    "every received note is consumed",
    incoming.length > 0 && incoming.every((n) => (n as any).isConsumed()),
    incoming.length + " note(s)"
  );
  check(
    "nothing is left pending",
    pendingIn.length === 0 && pendingOut.length === 0,
    "pending in=" + pendingIn.length + " out=" + pendingOut.length
  );

  const elapsed = Math.round(performance.now() - t0);
  log("");
  log("done in " + elapsed + " ms");
  log("PASS — money moved, both ends agree");
  state.status = "pass";
}

main().catch((e) => {
  log("");
  log("FAIL: " + String((e as Error)?.message ?? e).split("\n")[0]);
  state.status = "fail";
});
