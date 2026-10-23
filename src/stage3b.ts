// Stage 3b — two questions stage 3 could not settle.
//
// 1. LAYOUT. `AccountId` exposes `prefix()` and `suffix()`, but no single
//    `(prefix << n) | suffix` reconstructed the 120-bit hex id for any n. Six
//    consecutive id bit positions (55..61) were constant across all 24 accounts,
//    which is structural, and it sits right where a prefix/suffix boundary would
//    be. So the id is not a naive concatenation of the two accessors. Print the
//    raw values and test the candidate formulas instead of guessing.
//
// 2. THE MSB. Public wallets set id bit 119 — the most significant bit, and
//    therefore the top bit of every note tag — in only 1 of 10 cases. At n=10
//    that is a 1% fluke, which is suggestive and proves nothing. Account creation
//    costs ~800 ms, so a few hundred accounts is affordable: enough to separate
//    a real leak from noise, and enough to map which of the 120 id bit positions
//    are structural at all.
//
//    If the storage mode shows up in the bits a tag encodes, then the tag leaks
//    whether the receiver is a private or a public account — a channel nothing in
//    the corpus has recorded, and one that blinding inside a pool cannot fix.

import * as SDK from "@miden-sdk/miden-sdk";
import * as T from "./envelope/tags";

const out = document.getElementById("out")!;
const lines: string[] = [];
const checks: { name: string; ok: boolean; detail: string }[] = [];
const state = {
  status: "running" as "running" | "pass" | "fail",
  lines,
  checks,
  layout: [] as Record<string, unknown>[],
  bias: {} as Record<string, unknown>,
};
(window as any).__STAGE3B__ = state;

function log(s: string) {
  lines.push(s);
  out.textContent = lines.join("\n");
}
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  log((ok ? "   ok " : "  FAIL") + "  " + name + (detail ? "   " + detail : ""));
}
const E = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0].slice(0, 200);
const bh = (v: bigint) => "0x" + v.toString(16).padStart(2, "0");

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
  const { MidenClient, FaucetType, AccountId } = SDK as any;

  log("stage 3b — id layout, and whether the tag leaks the storage mode");
  log("");

  await wipeStores();
  const client = await MidenClient.createMock();
  log("client up in " + Math.round(performance.now() - t0) + " ms");

  // ══ Part 1 — what prefix() and suffix() actually are ════════════════════
  log("");
  log("── 1 · the id layout ──");

  const probe: { hex: string; mode: string }[] = [];
  for (let i = 0; i < 3; i++) {
    const a = await client.accounts.create({ storage: "private" });
    probe.push({ hex: T.normalizeId(a.id().toString()), mode: "private" });
  }
  for (let i = 0; i < 3; i++) {
    const a = await client.accounts.create({ storage: "public" });
    probe.push({ hex: T.normalizeId(a.id().toString()), mode: "public" });
  }
  const f = await client.accounts.create({
    type: FaucetType.FungibleFaucet, symbol: "PRB", decimals: 6, maxSupply: 1_000_000_000n,
  });
  probe.push({ hex: T.normalizeId(f.id().toString()), mode: "faucet" });

  const formulas = [
    { name: "(prefix << 56) | suffix", fn: (p: bigint, s: bigint) => (p << 56n) | s },
    { name: "(prefix << 64) | suffix", fn: (p: bigint, s: bigint) => (p << 64n) | s },
    { name: "(prefix << 56) | (suffix >> 8)", fn: (p: bigint, s: bigint) => (p << 56n) | (s >> 8n) },
    { name: "(prefix << 64) | (suffix >> 8)", fn: (p: bigint, s: bigint) => (p << 64n) | (s >> 8n) },
    { name: "(suffix << 56) | prefix", fn: (p: bigint, s: bigint) => (s << 56n) | p },
    { name: "prefix + suffix", fn: (p: bigint, s: bigint) => p + s },
  ];
  const formulaHits = new Map<string, number>();

  for (const p of probe) {
    const aid = AccountId.fromHex("0x" + p.hex);
    const pre = aid.prefix().asInt();
    const suf = aid.suffix().asInt();
    const whole = BigInt("0x" + p.hex);
    const rec: Record<string, unknown> = {
      mode: p.mode, hex: p.hex,
      prefixHex: bh(pre), prefixBits: pre.toString(2).length,
      suffixHex: bh(suf), suffixBits: suf.toString(2).length,
      isPrivate: aid.isPrivate(), isPublic: aid.isPublic(),
      matched: [] as string[],
    };
    for (const fm of formulas) {
      try {
        if (fm.fn(pre, suf) === whole) {
          (rec.matched as string[]).push(fm.name);
          formulaHits.set(fm.name, (formulaHits.get(fm.name) ?? 0) + 1);
        }
      } catch { /* ignore */ }
    }
    state.layout.push(rec);

    log("");
    log("  " + p.mode.padEnd(8) + " id      0x" + p.hex);
    log("           prefix  " + bh(pre).padEnd(20) + " (" + pre.toString(2).length + " bits)");
    log("           suffix  " + bh(suf).padEnd(20) + " (" + suf.toString(2).length + " bits)");
    log("           id      " + bh(whole).padEnd(20) + " (120 bits)");
    log("           matches " + ((rec.matched as string[]).join(", ") || "none"));
    // Where does the prefix sit inside the id, if anywhere?
    const idHex = p.hex;
    const preHex = pre.toString(16);
    const sufHex = suf.toString(16);
    log("           prefix hex is a substring of id: " + idHex.includes(preHex)
      + " · suffix hex is a substring: " + idHex.includes(sufHex));
  }

  log("");
  log("  formula tally over " + probe.length + " ids: "
    + (formulaHits.size ? [...formulaHits].map(([k, v]) => `${k}=${v}`).join(", ") : "no formula reproduced the id"));
  check("some (prefix, suffix) formula reproduces the 120-bit id", formulaHits.size > 0,
    formulaHits.size ? [...formulaHits.keys()].join(", ") : "none matched");

  // ══ Part 2 — the storage-mode question, with enough accounts to matter ══
  log("");
  log("── 2 · does the tag leak the storage mode? ──");

  const BUDGET_MS = 200_000;
  const priv: string[] = probe.filter((p) => p.mode === "private").map((p) => p.hex);
  const pub: string[] = probe.filter((p) => p.mode === "public").map((p) => p.hex);
  const tP = performance.now();
  let made = 0;

  while (performance.now() - tP < BUDGET_MS) {
    const wantPublic = made % 2 === 1;
    const a = await client.accounts.create({ storage: wantPublic ? "public" : "private" });
    const hex = T.normalizeId(a.id().toString());
    // Trust the id, not the request: record what the SDK says it is.
    const aid = AccountId.fromHex("0x" + hex);
    if (aid.isPrivate()) priv.push(hex); else pub.push(hex);
    made++;
    if (made % 25 === 0) {
      log("  " + made + " accounts created · " + Math.round(performance.now() - tP) + " ms elapsed"
        + " · private " + priv.length + " / public " + pub.length);
    }
  }
  log("  sample: " + priv.length + " private, " + pub.length + " public  ("
    + Math.round((performance.now() - tP) / Math.max(1, made)) + " ms per account)");
  state.bias.n = { private: priv.length, public: pub.length };

  const ones = (ids: string[], i: number) => {
    let c = 0;
    for (const id of ids) if (T.accountIdBits(id)[i] === "1") c++;
    return c;
  };
  const frac = (ids: string[], i: number) => (ids.length ? ones(ids, i) / ids.length : 0);

  // 2a — every one of the 120 bit positions, both modes.
  const structural: string[] = [];
  const modeSplit: string[] = [];
  const rows: { bit: number; priv: number; pub: number }[] = [];
  for (let i = 0; i < T.ID_BITS; i++) {
    const bitNo = T.ID_BITS - 1 - i;
    const fp = frac(priv, i);
    const fu = frac(pub, i);
    const all = frac([...priv, ...pub], i);
    rows.push({ bit: bitNo, priv: fp, pub: fu });
    if (all <= 0.02 || all >= 0.98) structural.push(`bit${bitNo}=${all.toFixed(3)}`);
    // A real mode-dependent bit would sit near 0 for one mode and near 1 for the other.
    if (Math.abs(fp - fu) >= 0.35) modeSplit.push(`bit${bitNo} priv=${fp.toFixed(2)} pub=${fu.toFixed(2)}`);
  }

  log("");
  log("  structural bit positions (≤2% or ≥98% ones across the whole sample):");
  log("    " + (structural.length ? structural.join(" ") : "none — all 120 positions look random"));
  log("");
  log("  positions that differ between private and public by ≥0.35:");
  log("    " + (modeSplit.length ? modeSplit.join(" | ") : "none"));

  // 2b — the 14 tag bits specifically, which is what a note tag publishes.
  log("");
  log("  the 14 bits a note tag encodes (id bits 119..106, MSB first):");
  log("    bit   private   public   gap");
  for (let i = 0; i < T.DEFAULT_TAG_LEN; i++) {
    const r = rows[i];
    log("    " + String(r.bit).padStart(4) + "   " + r.priv.toFixed(3).padStart(6)
      + "   " + r.pub.toFixed(3).padStart(6) + "   " + (r.priv - r.pub >= 0 ? "+" : "")
      + (r.priv - r.pub).toFixed(3));
  }

  const msbPriv = frac(priv, 0);
  const msbPub = frac(pub, 0);
  log("");
  log("  id bit 119 (the MSB, and the top bit of every tag):");
  log("    private  " + ones(priv, 0) + "/" + priv.length + " = " + msbPriv.toFixed(3));
  log("    public   " + ones(pub, 0) + "/" + pub.length + " = " + msbPub.toFixed(3));

  state.bias.rows = rows;
  state.bias.structural = structural;
  state.bias.modeSplit = modeSplit;
  state.bias.msb = { private: msbPriv, public: msbPub, privN: priv.length, pubN: pub.length };

  // 2c — the verdicts.
  const gap = Math.abs(msbPriv - msbPub);
  // At n≈148 per mode the SE of a proportion is ~0.041, so a 0.14 gap would be
  // ~2.4 SE. Anything under that is noise, whatever the 10-account sample said.
  check("the MSB bias from the 10-account sample does not survive a larger one", gap < 0.14,
    `private ${msbPriv.toFixed(3)} vs public ${msbPub.toFixed(3)}, gap ${gap.toFixed(3)} (n=${priv.length} each)`);

  // The discovery: exactly one bit separates the modes, and it is not in a tag.
  check("exactly one id bit separates the two storage modes, and it is bit 60",
    modeSplit.length === 1 && modeSplit[0].startsWith("bit60"),
    modeSplit.length ? modeSplit.join(" | ") : "none differ by ≥0.35");
  check("no bit a note tag can reach separates the two storage modes",
    rows.slice(0, 32).every((r) => Math.abs(r.priv - r.pub) < 0.35),
    "checked id bits 119..88 — everything a k=32 tag, the widest the SDK builds, can encode");
  check("the constant id bits are exactly the prefix's low bits, 55..59 and 61",
    JSON.stringify(structural.map((s) => s.split("=")[0]).sort()) ===
      JSON.stringify(["bit55", "bit56", "bit57", "bit58", "bit59", "bit61"]),
    structural.join(" ") || "none");
  check("the 14 tag bits are uniform in both modes",
    rows.slice(0, T.DEFAULT_TAG_LEN).every((r) => r.priv > 0.2 && r.priv < 0.8 && r.pub > 0.2 && r.pub < 0.8),
    "all inside 0.2..0.8");
  log("");
  log("  structural positions found: " + structural.length + " of 120");
  state.bias.structuralCount = structural.length;

  log("");
  log("done in " + Math.round(performance.now() - t0) + " ms");
  const failed = checks.filter((c) => !c.ok);
  state.status = failed.length === 0 ? "pass" : "fail";
  log(failed.length === 0 ? "PASS" : "FAILED " + failed.length + " check(s): " + failed.map((c) => c.name).join(" | "));

  try { await (client as any)[Symbol.asyncDispose](); } catch { try { client.terminate(); } catch { /* ignore */ } }
}

main().catch((e) => {
  log("");
  log("FAIL: " + E(e));
  log(String((e as Error)?.stack ?? "").split("\n").slice(1, 4).join(" | "));
  state.status = "fail";
});
