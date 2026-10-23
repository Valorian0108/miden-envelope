// Stage 0 — toolchain smoke test.
//
// The only question this page answers: can the browser load the Miden WASM,
// construct a mock client, and list accounts — under pnpm, through Vite?
//
// If this passes, every later stage can assume the environment works. If it
// fails with WASM_CLASS_MISMATCH, two copies of the SDK are bundled; if it
// fails to fetch the .wasm, pnpm's symlinking broke asset resolution.

import * as SDK from "@miden-sdk/miden-sdk";

const out = document.getElementById("out")!;
const lines: string[] = [];
const state = { status: "running" as "running" | "pass" | "fail", lines };
(window as any).__STAGE0__ = state;

function log(s: string) {
  lines.push(s);
  out.textContent = lines.join("\n");
}

async function main() {
  log("stage 0 — toolchain smoke test");
  log("sdk exports: " + Object.keys(SDK).length);

  const MidenClient = (SDK as any).MidenClient;
  if (!MidenClient) throw new Error("MidenClient is not exported by the SDK");
  log("MidenClient: present");

  const t0 = performance.now();
  const client = await MidenClient.createMock();
  log("createMock: ok in " + Math.round(performance.now() - t0) + " ms");

  log("usesMockChain: " + client.usesMockChain());

  const accounts = await client.accounts.list();
  log("accounts: " + accounts.length);

  log("");
  log("PASS — WASM loaded, mock client alive, accounts listable");
  state.status = "pass";
}

main().catch((e) => {
  log("");
  log("FAIL: " + String((e as Error)?.message ?? e).split("\n")[0]);
  state.status = "fail";
});
