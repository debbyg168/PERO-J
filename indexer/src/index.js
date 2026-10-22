import dotenv from "dotenv";
import { SorobanRpc, StrKey } from "@stellar/stellar-sdk";
import { startApi } from "./api.js";
import { db } from "./db.js";
import { registerFixtures } from "./registerFixtures.js";
import { reloadSacMap } from "./sac.js";
import { validateNetwork } from "./validateNetwork.js";
import { resolvePollMs } from "./resolvePollMs.js";
import { dispatchContractEvent } from "./router/registry.js";

export { isExplorerUpdateEvent, updateEventContractId } from "./router/registry.js";

dotenv.config();

/** @typedef {import('./types.js').HealthState} HealthState */

const RPC_URL = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const START_LEDGER = Number(process.env.START_LEDGER || 0);
const POLL_MS = resolvePollMs();
const RPC_ERROR_THRESHOLD = 3;

/**
 * Advisory lock id used to serialize migrations across indexer instances.
 * Any two instances sharing this id will not run migrations concurrently.
 */
const MIGRATION_LOCK_ID = 836;

let rpc = new SorobanRpc.Server(RPC_URL, { allowHttp: true });

/**
 * Shared health state exposed to the REST API via api.js.
 * Updated each time a ledger is successfully indexed.
 *
 * @type {HealthState}
 */
export const health = {
  /** Timestamp (ms) of the last successfully processed ledger, or null if none yet. */
  lastIndexedAt: null,
  /** Most-recently processed ledger sequence number. */
  lastLedger: null,
  /** Process start time for uptime calculation. */
  startedAt: Date.now(),
};

/**
 * Recursively walk decoded topic/data values and collect every Stellar
 * public key (strkey `G…`, 56 chars) found in the structure.
 *
 * Handles nested arrays and plain objects so addresses embedded in
 * structs, vectors, and maps are all discovered.
 *
 * @param {*} values - Decoded value(s) to scan.
 * @param {Set<string>} [found] - Accumulator for deduplication.
 * @returns {string[]} Deduplicated list of Stellar public keys.
 */
export function extractAddresses(values, found = new Set()) {
  if (values === null || values === undefined) {
    return [...found];
  }

  if (typeof values === "string") {
    if (values.length === 56 && values.startsWith("G")) {
      try {
        if (StrKey.isValidEd25519PublicKey(values)) {
          found.add(values);
        }
      } catch {
        // Not a valid strkey — ignore.
      }
    }
    return [...found];
  }

  if (Array.isArray(values)) {
    for (const item of values) {
      extractAddresses(item, found);
    }
    return [...found];
  }

  if (typeof values === "object") {
    for (const value of Object.values(values)) {
      extractAddresses(value, found);
    }
  }

  return [...found];
}

export async function indexLedger(
  ledger,
  rpcClient = rpc,
  { onlyLedger = null, submitOnchain = true } = {}
) {
  let paginationCursor;
  let latestLedger = ledger;

  while (true) {
    const res = await rpcClient.getEvents({
      startLedger: ledger,
      filters: [{ type: "contract" }],
      pagination: { limit: 200, ...(paginationCursor ? { cursor: paginationCursor } : {}) },
    });
    latestLedger = res.latestLedger ?? latestLedger;

    let reachedEndLedger = false;
    for (const ev of res.events) {
      if (onlyLedger !== null && ev.ledger > onlyLedger) {
        reachedEndLedger = true;
        break;
      }
      if (onlyLedger === null || ev.ledger === onlyLedger) {
        await dispatchContractEvent(ev, { submitOnchain });
      }
    }

    const nextCursor = res.cursor;
    if (
      reachedEndLedger ||
      res.events.length === 0 ||
      !nextCursor ||
      nextCursor === paginationCursor
    ) {
      break;
    }
    paginationCursor = nextCursor;
  }

  // Record the time we finished processing this ledger batch
  health.lastIndexedAt = Date.now();
  health.lastLedger = onlyLedger ?? latestLedger;

  return onlyLedger ?? latestLedger;
}

let shuttingDown = false;

function gracefulShutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log("Shutdown signal received, finishing current iteration…");
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
process.on("SIGHUP", () => {
  console.log("SIGHUP received, reloading environment and SAC map...");
  dotenv.config({ override: true });
  reloadSacMap();
});

/**
 * Run migrations under a Postgres advisory lock so that two indexer instances
 * starting at the same time cannot run migrations concurrently (which would
 * cause duplicate-key errors or partial state).
 *
 * The lock is always released in `finally`; a failed unlock is logged but
 * never masks the original migration error.
 */
async function initWithMigrationLock() {
  await db.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
  try {
    await db.init();
  } catch (err) {
    // Roll back any partial migration state before releasing the lock.
    try {
      await db.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("[migrations] rollback failed:", rollbackErr.message);
    }
    throw err;
  } finally {
    try {
      await db.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
    } catch (unlockErr) {
      console.error("[migrations] failed to release advisory lock:", unlockErr.message);
    }
  }
}

async function run() {
  await initWithMigrationLock();
  await registerFixtures().catch((err) => {
    console.error("[fixtures] failed to register ABI fixtures:", err.message);
  });

  startApi();

  await validateNetwork(rpc);

  const persisted = await db.getCursor();
  let cursor = persisted ?? (START_LEDGER || (await rpc.getLatestLedger()).sequence - 100);
  if (persisted !== null) {
    console.log(`Resuming from persisted ledger ${cursor}`);
  }

  let consecutiveErrors = 0;

  while (!shuttingDown) {
    try {
      const latest = await indexLedger(cursor);
      cursor = latest + 1;
      await db.setCursor(latest);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      console.error("Indexer error:", err.message);
      if (consecutiveErrors >= RPC_ERROR_THRESHOLD) {
        console.warn(`${consecutiveErrors} consecutive RPC errors — recreating RPC client`);
        rpc = new SorobanRpc.Server(RPC_URL, { allowHttp: true });
        consecutiveErrors = 0;
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  await db.close();
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run();
}
