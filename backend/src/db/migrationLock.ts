/**
 * Distributed lock so only one backend container runs `prisma migrate deploy`
 * at a time. Waiters poll instead of blocking forever, and the lock has a TTL
 * plus a compare-and-delete release so a crashed holder cannot deadlock the fleet.
 */

export const MIGRATION_LOCK_KEY = 'backend:prisma:migrate:lock';

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

const EXTEND_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end
`;

export interface MigrationLockClient {
  set(
    key: string,
    value: string,
    expiryMode: 'PX',
    ttlMs: number,
    setMode: 'NX'
  ): Promise<'OK' | null>;
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

export interface MigrationLockOptions {
  key?: string;
  ttlMs?: number;
  retryMs?: number;
  /** Upper bound a waiter will spin before giving up. Prevents deadlock. */
  waitTimeoutMs?: number;
  token?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class MigrationLockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationLockTimeoutError';
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function acquireMigrationLock(
  client: MigrationLockClient,
  options: MigrationLockOptions = {}
): Promise<{ token: string; release: () => Promise<void>; extend: () => Promise<boolean> }> {
  const key = options.key ?? MIGRATION_LOCK_KEY;
  const ttlMs = options.ttlMs ?? 120_000;
  const retryMs = options.retryMs ?? 250;
  const waitTimeoutMs = options.waitTimeoutMs ?? 10 * 60_000;
  const token = options.token ?? `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + waitTimeoutMs;

  while (now() < deadline) {
    const acquired = await client.set(key, token, 'PX', ttlMs, 'NX');
    if (acquired === 'OK') {
      return {
        token,
        extend: async () => {
          const refreshed = await client.eval(EXTEND_SCRIPT, 1, key, token, String(ttlMs));
          return Number(refreshed) === 1;
        },
        release: async () => {
          await client.eval(RELEASE_SCRIPT, 1, key, token);
        },
      };
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    const jitter = Math.floor(Math.random() * Math.min(retryMs, 100));
    await sleep(Math.min(retryMs + jitter, remaining));
  }

  throw new MigrationLockTimeoutError(
    `timed out after ${waitTimeoutMs}ms waiting for migration lock ${key}`
  );
}

export async function withMigrationLock<T>(
  client: MigrationLockClient,
  fn: (lock: { extend: () => Promise<boolean> }) => Promise<T>,
  options: MigrationLockOptions = {}
): Promise<T> {
  const lock = await acquireMigrationLock(client, options);
  const ttlMs = options.ttlMs ?? 120_000;
  const heartbeat = setInterval(() => {
    void lock.extend().catch(() => undefined);
  }, Math.max(1000, Math.floor(ttlMs / 3)));
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  try {
    return await fn(lock);
  } finally {
    clearInterval(heartbeat);
    await lock.release();
  }
}
