import { Keypair } from '@stellar/stellar-sdk';
import { incCounter } from './metrics.js';
import { getRedis, publish } from './redis.js';

const SIGNATURE_TTL_S = Number(process.env.ORACLE_SIGNATURE_TTL_S || 300);
const BREAKER_THRESHOLD = 2;
const BREAKER_WINDOW_S = 24 * 60 * 60;
const LOSSES_KEY = 'oracle:breaker:losses';
const TRIPPED_KEY = 'oracle:breaker:tripped';
const ALERT_CHANNEL = 'stellar:alerts:oracle';

// In-memory fallback used when Redis is not configured or unavailable.
const mem = { losses: [], tripped: false };

/** Registered providers: ORACLE_PROVIDERS='{"<providerId>":"G...public key"}'. */
function providerKey(id) {
  try {
    return JSON.parse(process.env.ORACLE_PROVIDERS || '{}')[id];
  } catch {
    return undefined;
  }
}

/** Canonical signed challenge: binds market ID, outcome and timestamp (replay protection). */
export function challengePayload({ market_id, outcome, timestamp }) {
  return `${market_id}:${outcome}:${timestamp}`;
}

/**
 * Verify an ed25519 signature against the provider's registered Stellar key.
 * @returns {boolean} true only for a well-formed, fresh, valid signature.
 */
export function verifySubmission(body, nowS = Math.floor(Date.now() / 1000)) {
  const { provider, market_id, outcome, timestamp, signature } = body ?? {};
  if (
    !provider ||
    market_id === undefined ||
    market_id === null ||
    outcome === undefined ||
    outcome === null ||
    typeof signature !== 'string'
  ) {
    return false;
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowS - ts) > SIGNATURE_TTL_S)
    return false;
  const pub = providerKey(provider);
  if (!pub) return false;
  try {
    return Keypair.fromPublicKey(pub).verify(
      Buffer.from(challengePayload({ market_id, outcome, timestamp })),
      Buffer.from(signature, 'base64'),
    );
  } catch {
    return false;
  }
}

export async function isBreakerTripped(redis = getRedis()) {
  try {
    if (redis) return (await redis.exists(TRIPPED_KEY)) === 1;
  } catch {
    // fall through to in-memory state
  }
  return mem.tripped;
}

/**
 * Record the outcome of a submission after its challenge window. A win resets
 * the consecutive-loss streak; reaching the threshold within 24h trips the
 * breaker until an operator resets it.
 * @returns {Promise<boolean>} whether the breaker is now tripped
 */
export async function recordChallengeResult(lost, redis = getRedis()) {
  const now = Date.now();
  let count;
  try {
    if (!redis) throw new Error('no redis');
    if (!lost) {
      await redis.del(LOSSES_KEY);
      return await isBreakerTripped(redis);
    }
    await redis.rpush(LOSSES_KEY, now);
    await redis.expire(LOSSES_KEY, BREAKER_WINDOW_S);
    const recent = (await redis.lrange(LOSSES_KEY, 0, -1)).map(Number);
    count = recent.filter((t) => now - t < BREAKER_WINDOW_S * 1000).length;
  } catch {
    if (!lost) {
      mem.losses = [];
      return mem.tripped;
    }
    mem.losses = [...mem.losses, now].filter(
      (t) => now - t < BREAKER_WINDOW_S * 1000,
    );
    count = mem.losses.length;
  }
  if (count >= BREAKER_THRESHOLD) await tripBreaker(count, redis);
  return count >= BREAKER_THRESHOLD || (await isBreakerTripped(redis));
}

async function tripBreaker(count, redis) {
  mem.tripped = true;
  try {
    await redis?.set(TRIPPED_KEY, String(Date.now()));
  } catch {
    // in-memory flag already set
  }
  incCounter(
    'oracle_circuit_breaker_trips_total',
    'Oracle circuit breaker trips',
  );
  const alert = {
    severity: 'high',
    event: 'oracle_circuit_breaker_tripped',
    consecutiveLosses: count,
    at: new Date().toISOString(),
  };
  console.error(JSON.stringify(alert));
  await publish(ALERT_CHANNEL, alert, redis);
}

export async function resetBreaker(redis = getRedis()) {
  mem.tripped = false;
  mem.losses = [];
  try {
    await redis?.del(TRIPPED_KEY, LOSSES_KEY);
  } catch {
    // in-memory state already cleared
  }
}

/** Mount oracle routes. `requireAdmin` guards operator-only endpoints. */
export function registerOracleRoutes(app, requireAdmin, asyncHandler) {
  app.post(
    '/api/oracle/submit',
    asyncHandler(async (req, res) => {
      if (!verifySubmission(req.body)) {
        return res.status(401).json({ error: 'Invalid or expired signature' });
      }
      if (await isBreakerTripped()) {
        return res
          .status(503)
          .json({ error: 'Auto-submissions paused by circuit breaker' });
      }
      res.status(202).json({ ok: true });
    }),
  );

  app.post(
    '/api/oracle/challenge-result',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const tripped = await recordChallengeResult(req.body?.lost === true);
      res.json({ tripped });
    }),
  );

  app.post(
    '/api/oracle/breaker/reset',
    requireAdmin,
    asyncHandler(async (_req, res) => {
      await resetBreaker();
      res.json({ ok: true });
    }),
  );
}
