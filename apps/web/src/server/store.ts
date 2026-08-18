import { Redis } from "@upstash/redis";

/**
 * Room persistence: Upstash Redis when provisioned (shared across serverless
 * instances — the only way in-memory rooms survive Vercel's Fluid compute),
 * in-process Map otherwise (local dev, single process).
 */

const ROOM_TTL_SECONDS = 3 * 60 * 60;
const LOCK_TTL_MS = 4_000;
const LOCK_RETRIES = 10;
const LOCK_RETRY_MS = 150;

export interface RoomStore {
  get(id: string): Promise<unknown | null>;
  set(id: string, doc: unknown): Promise<void>;
  /** Serialize concurrent mutations of one room across instances. */
  withLock<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class RedisStore implements RoomStore {
  constructor(private readonly redis: Redis) {}

  async get(id: string): Promise<unknown | null> {
    return await this.redis.get(`room:${id}`);
  }

  async set(id: string, doc: unknown): Promise<void> {
    await this.redis.set(`room:${id}`, doc, { ex: ROOM_TTL_SECONDS });
  }

  async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const key = `lock:room:${id}`;
    const owner = Math.random().toString(36).slice(2);
    for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
      const acquired = await this.redis.set(key, owner, { nx: true, px: LOCK_TTL_MS });
      if (acquired) {
        try {
          return await fn();
        } finally {
          // Best-effort owner-checked release; an expired lock self-heals.
          const current = await this.redis.get<string>(key);
          if (current === owner) await this.redis.del(key);
        }
      }
      await sleep(LOCK_RETRY_MS * (attempt + 1));
    }
    throw new Error("table is busy — try again");
  }
}

class MemoryStore implements RoomStore {
  private readonly docs = new Map<string, unknown>();
  private chain = Promise.resolve<unknown>(null);

  async get(id: string): Promise<unknown | null> {
    // Deep-copy so callers can't mutate the stored doc outside a lock.
    const doc = this.docs.get(id);
    return doc === undefined ? null : JSON.parse(JSON.stringify(doc));
  }

  async set(id: string, doc: unknown): Promise<void> {
    this.docs.set(id, JSON.parse(JSON.stringify(doc)));
  }

  withLock<T>(_id: string, fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => null);
    return next;
  }
}

let store: RoomStore | null = null;

export function roomStore(): RoomStore {
  if (!store) {
    store =
      process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL
        ? new RedisStore(
            process.env.UPSTASH_REDIS_REST_URL
              ? Redis.fromEnv()
              : new Redis({
                  url: process.env.KV_REST_API_URL as string,
                  token: process.env.KV_REST_API_TOKEN as string,
                }),
          )
        : new MemoryStore();
  }
  return store;
}

export function usingRedis(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL);
}
