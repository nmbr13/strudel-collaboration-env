import * as Y from 'yjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setPersistence } = require('y-websocket/bin/utils') as {
  setPersistence: (p: PersistenceAdapter | null) => void;
};

type PersistenceAdapter = {
  bindState: (docName: string, ydoc: Y.Doc) => void | Promise<void>;
  writeState: (docName: string, ydoc: Y.Doc) => Promise<void>;
};

const memorySnapshots = new Map<string, Uint8Array>();

type RedisLike = {
  getBuffer(key: string): Promise<Buffer | null>;
  set(key: string, value: Buffer, mode: string, duration: number): Promise<unknown>;
};

let redis: RedisLike | null = null;

export async function initPersistence(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) {
    setPersistenceAdapter(false);
    return;
  }
  try {
    const IORedis = await import('ioredis');
    const Ctor = IORedis.default as unknown as new (u: string) => RedisLike;
    redis = new Ctor(url);
    setPersistenceAdapter(true);
  } catch (e) {
    console.warn('[persistence] REDIS_URL set but ioredis failed, using memory:', e);
    setPersistenceAdapter(false);
  }
}

function setPersistenceAdapter(useRedis: boolean): void {
  setPersistence({
    bindState: (docName: string, ydoc: Y.Doc) => {
      void (async () => {
        try {
          let buf: Uint8Array | undefined;
          if (useRedis && redis) {
            const b = await redis.getBuffer(`yjs:${docName}`);
            if (b?.length) buf = new Uint8Array(b);
          } else {
            buf = memorySnapshots.get(docName);
          }
          if (buf?.length) Y.applyUpdate(ydoc, buf);
        } catch (err) {
          console.error('[persistence] bindState', err);
        }
        ydoc.on('update', () => {
          const state = Y.encodeStateAsUpdate(ydoc);
          if (useRedis && redis) {
            void redis.set(`yjs:${docName}`, Buffer.from(state), 'EX', 86400);
          } else {
            memorySnapshots.set(docName, state);
          }
        });
      })();
    },
    writeState: async (docName: string, ydoc: Y.Doc) => {
      const state = Y.encodeStateAsUpdate(ydoc);
      if (useRedis && redis) {
        await redis.set(`yjs:${docName}`, Buffer.from(state), 'EX', 86400);
      } else {
        memorySnapshots.set(docName, state);
      }
    },
  });
}
