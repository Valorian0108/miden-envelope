/**
 * miden-envelope · entry point
 *
 * The barrel is deliberately **SDK-free**: it re-exports the three modules that
 * run anywhere — a browser page, a Node test, a capture tool — with nothing but
 * arithmetic behind them.
 *
 * `send.ts` is *not* re-exported here on purpose. It imports `@miden-sdk/miden-sdk`,
 * which is a WASM binary with no Windows build, so pulling it into the barrel would
 * make the whole library unimportable on machines where only the measuring half can
 * run. Callers who have the SDK import it directly:
 *
 *     import { sendEnvelope } from "miden-envelope/src/envelope/send";
 *
 * Everything else comes through the barrel:
 *
 *     import { poolFor, blindedTag, census, fetchPool } from "miden-envelope";
 */

export * from "./tags";
export * from "./metric";
export * from "./fetch";
