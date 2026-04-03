# Live Performance UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Strudel Collab safe for live performance — errors never stop the music, code updates land on cycle boundaries, and the whole room sees whose update failed.

**Architecture:** New `client:error` / `client:errorCleared` messages flow from the evaluating client → server → all room members. The toolbar gains a dedicated Update button (cycle-aligned eval) replacing the dual-purpose ⌘↵. The shared package gains a pure `nextCycleAtMs()` utility and two new message type pairs in the Zod schemas.

**Tech Stack:** TypeScript, React 19, Zod 3, ws 8, Strudel `@strudel/web`, Vitest (added in Task 1)

> **Known limitation:** The spec mentions making `lastGoodCode` server-authoritative. This plan keeps it client-side (`lastGoodCodeRef` in RoomPage) because Yjs already syncs editor state across all clients, so all peers share the same code at eval time. The practical gap is: a member who joins *after* a successful eval won't have a local `lastGoodCodeRef`, so their Revert button will be disabled until they witness a successful Update. This is an acceptable edge case for live performance and can be addressed in a follow-up.

---

## File Map

| File | What changes |
|---|---|
| `packages/shared/src/index.ts` | Add `client:error`, `client:errorCleared`, `room:error`, `room:errorCleared` schemas + `nextCycleAtMs()` utility |
| `packages/shared/src/index.test.ts` | New — unit tests for new schemas + `nextCycleAtMs` |
| `packages/shared/package.json` | Add vitest dev dependency + test script |
| `packages/shared/tsconfig.json` | Include test file |
| `apps/server/src/rooms.ts` | Handle `client:error` / `client:errorCleared` in `handleControlMessage` |
| `apps/web/src/hooks/useRoomControl.ts` | Add `roomErrors` state, `sendClientError`, `sendClientErrorCleared` |
| `apps/web/src/hooks/useStrudel.ts` | Add `cancelScheduled()` method |
| `apps/web/src/pages/RoomPage.tsx` | Toolbar restructure, Update button, cycle scheduling, error UI |
| `apps/web/src/styles.css` | Add `.update-queued`, `.avatar-error`, `.error-banner`, `.error-strip` |

---

## Task 1: Shared schemas + `nextCycleAtMs` utility + tests

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/package.json`
- Modify: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.test.ts`

- [ ] **Step 1.1 — Add vitest to shared package.json**

Open `packages/shared/package.json` and replace the whole file with:

```json
{
  "name": "@strudel-collab/shared",
  "version": "0.0.1",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "typescript": "^5.7.3",
    "vitest": "^2.1.9"
  }
}
```

- [ ] **Step 1.2 — Install vitest**

```bash
npm install
```

Run from the project root (`strudel-collaboration/`). npm workspaces will install vitest into `packages/shared/node_modules`.

Expected: vitest added to `packages/shared/node_modules`.

- [ ] **Step 1.3 — Include test file in tsconfig**

Open `packages/shared/tsconfig.json`. Add `"include": ["src"]` if not present, or confirm the existing include covers `src/**/*.ts`. The file should look like:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "outDir": "./dist"
  },
  "include": ["src"]
}
```

- [ ] **Step 1.4 — Write failing tests**

Create `packages/shared/src/index.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  clientControlMessageSchema,
  serverControlMessageSchema,
  nextCycleAtMs,
} from './index.js';

describe('clientControlMessageSchema — client:error', () => {
  it('accepts a valid client:error message', () => {
    const result = clientControlMessageSchema.safeParse({
      type: 'client:error',
      message: 'SyntaxError: Unexpected token',
    });
    expect(result.success).toBe(true);
  });

  it('accepts client:error with optional line number', () => {
    const result = clientControlMessageSchema.safeParse({
      type: 'client:error',
      message: 'SyntaxError',
      line: 3,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.line).toBe(3);
  });

  it('rejects client:error with missing message', () => {
    const result = clientControlMessageSchema.safeParse({ type: 'client:error' });
    expect(result.success).toBe(false);
  });
});

describe('clientControlMessageSchema — client:errorCleared', () => {
  it('accepts a valid client:errorCleared message', () => {
    const result = clientControlMessageSchema.safeParse({ type: 'client:errorCleared' });
    expect(result.success).toBe(true);
  });
});

describe('serverControlMessageSchema — room:error', () => {
  it('accepts a valid room:error message', () => {
    const result = serverControlMessageSchema.safeParse({
      type: 'room:error',
      sessionId: '123e4567-e89b-12d3-a456-426614174000',
      displayName: 'alice',
      message: 'SyntaxError: line 3',
    });
    expect(result.success).toBe(true);
  });

  it('accepts room:error with optional line number', () => {
    const result = serverControlMessageSchema.safeParse({
      type: 'room:error',
      sessionId: '123e4567-e89b-12d3-a456-426614174000',
      displayName: 'alice',
      message: 'SyntaxError',
      line: 3,
    });
    expect(result.success).toBe(true);
  });
});

describe('serverControlMessageSchema — room:errorCleared', () => {
  it('accepts a valid room:errorCleared message', () => {
    const result = serverControlMessageSchema.safeParse({
      type: 'room:errorCleared',
      sessionId: '123e4567-e89b-12d3-a456-426614174000',
    });
    expect(result.success).toBe(true);
  });
});

describe('nextCycleAtMs', () => {
  it('returns the next cycle start after now', () => {
    // Transport started at t=0, BPM=120 → cycle duration = 500ms
    const scheduleAtMs = 0;
    const bpm = 120;
    // Now is 750ms in → 1.5 cycles elapsed → next cycle at 1000ms
    const result = nextCycleAtMs(scheduleAtMs, bpm, 750);
    expect(result).toBe(1000);
  });

  it('returns next cycle when exactly on a boundary', () => {
    // Now is exactly at cycle 2 start (1000ms) → next cycle is 1500ms
    const result = nextCycleAtMs(0, 120, 1000);
    expect(result).toBe(1500);
  });

  it('handles BPM 60 (cycle = 1000ms)', () => {
    // BPM=60, cycle=1000ms. Now=2400ms → 2.4 cycles → next at 3000ms
    const result = nextCycleAtMs(0, 60, 2400);
    expect(result).toBe(3000);
  });

  it('works with a non-zero scheduleAtMs', () => {
    // Started at t=5000ms. BPM=120, cycle=500ms. Now=5750ms → 1.5 cycles elapsed → next at 6000ms
    const result = nextCycleAtMs(5000, 120, 5750);
    expect(result).toBe(6000);
  });
});
```

- [ ] **Step 1.5 — Run tests to confirm they fail**

```bash
cd packages/shared && npx vitest run
```

Expected: tests fail with "nextCycleAtMs is not a function" (or similar — schemas not yet added).

- [ ] **Step 1.6 — Add new schemas and utility to `packages/shared/src/index.ts`**

Add two entries to `clientControlMessageSchema`'s discriminated union array (after the existing `transport:resync` entry):

```typescript
  z.object({
    type: z.literal('client:error'),
    message: z.string(),
    line: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('client:errorCleared'),
  }),
```

Add two entries to `serverControlMessageSchema`'s discriminated union array (after the existing `welcome` entry):

```typescript
  z.object({
    type: z.literal('room:error'),
    sessionId: z.string().uuid(),
    displayName: z.string(),
    message: z.string(),
    line: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('room:errorCleared'),
    sessionId: z.string().uuid(),
  }),
```

Add the utility function at the bottom of the file (after `suggestedLookaheadMs`):

```typescript
/**
 * Returns the server timestamp (ms) of the next cycle boundary after `nowMs`.
 * Used to schedule cycle-aligned code updates.
 *
 * @param scheduleAtMs - Server time when transport started (from transport:state)
 * @param bpm - Current BPM
 * @param nowMs - Current estimated server time (use estimatedServerNow())
 */
export function nextCycleAtMs(scheduleAtMs: number, bpm: number, nowMs: number): number {
  const cycleDurationMs = (60 / bpm) * 1000;
  const elapsed = nowMs - scheduleAtMs;
  const cyclesElapsed = Math.floor(elapsed / cycleDurationMs);
  return scheduleAtMs + (cyclesElapsed + 1) * cycleDurationMs;
}
```

- [ ] **Step 1.7 — Run tests to confirm they pass**

```bash
cd packages/shared && npx vitest run
```

Expected output: all 9 tests pass.

- [ ] **Step 1.8 — Rebuild shared package so server and web pick up the new types**

```bash
cd /path/to/project && npm run build -w @strudel-collab/shared
```

Expected: `packages/shared/dist/` updated with no TypeScript errors.

- [ ] **Step 1.9 — Commit**

```bash
git add packages/shared/
git commit -m "feat(shared): add error message schemas and nextCycleAtMs utility"
```

---

## Task 2: Server handles `client:error` and `client:errorCleared`

**Files:**
- Modify: `apps/server/src/rooms.ts`

- [ ] **Step 2.1 — Write the expected behaviour as a comment (no tests — integration tested manually)**

The change is: `handleControlMessage` gains two new `case` branches. When `client:error` arrives from a session, the server looks up the member's `displayName` and broadcasts `room:error` to all room members (including sender). When `client:errorCleared` arrives, it broadcasts `room:errorCleared` to all members.

- [ ] **Step 2.2 — Add the two new cases to `handleControlMessage` in `apps/server/src/rooms.ts`**

Inside the `switch (msg.type)` block, add after the `transport:setBpm` case and before `default:`:

```typescript
    case 'client:error': {
      const member = room.members.get(sessionId);
      if (!member) break;
      broadcastControl(room, {
        type: 'room:error',
        sessionId,
        displayName: member.displayName,
        message: msg.message,
        ...(msg.line !== undefined ? { line: msg.line } : {}),
      });
      break;
    }
    case 'client:errorCleared': {
      broadcastControl(room, {
        type: 'room:errorCleared',
        sessionId,
      });
      break;
    }
```

Note: `broadcastControl` is called without an `exceptSessionId` argument so the sender receives the broadcast too — this keeps the sender's UI in sync with the rest of the room.

- [ ] **Step 2.3 — Build server to check for TypeScript errors**

```bash
npm run build -w @strudel-collab/server
```

Expected: compiles cleanly, no errors.

- [ ] **Step 2.4 — Commit**

```bash
git add apps/server/src/rooms.ts
git commit -m "feat(server): broadcast room:error and room:errorCleared messages"
```

---

## Task 3: `useRoomControl` — error message state + send functions

**Files:**
- Modify: `apps/web/src/hooks/useRoomControl.ts`

- [ ] **Step 3.1 — Add `roomErrors` state, two new send functions, and handle the new server messages**

Replace the full contents of `apps/web/src/hooks/useRoomControl.ts` with:

```typescript
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  serverControlMessageSchema,
  type ServerControlMessage,
} from '@strudel-collab/shared';
import { getWsBase } from '../wsUrl';

export type RosterMember = { sessionId: string; displayName: string };

export type RoomError = {
  displayName: string;
  message: string;
  line?: number;
};

export function useRoomControl(sessionToken: string | null): {
  roster: RosterMember[];
  leaderSessionId: string | null;
  mySessionId: string | null;
  transport: { running: boolean; bpm: number; scheduleAtMs?: number; fromSessionId?: string };
  rttMs: number | null;
  clockSkewMs: number;
  lastError: string | null;
  roomChannelError: string | null;
  /** Map of sessionId → error info for all members currently in an error state */
  roomErrors: Record<string, RoomError>;
  sendPlay: (bpm: number, scheduleAtMs: number, cycleAtSchedule?: number) => void;
  sendStop: () => void;
  sendReset: () => void;
  sendSetBpm: (bpm: number) => void;
  sendResync: (bpm: number, scheduleAtMs: number, cycleAtSchedule?: number) => void;
  sendClientError: (message: string, line?: number) => void;
  sendClientErrorCleared: () => void;
} {
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [leaderSessionId, setLeaderSessionId] = useState<string | null>(null);
  const [mySessionId, setMySessionId] = useState<string | null>(null);
  const [transport, setTransport] = useState<{
    running: boolean;
    bpm: number;
    scheduleAtMs?: number;
    fromSessionId?: string;
  }>({ running: false, bpm: 120 });
  const [rttMs, setRttMs] = useState<number | null>(null);
  const skewRef = useRef(0);
  const [clockSkewMs, setClockSkewMs] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const [roomChannelError, setRoomChannelError] = useState<string | null>(null);
  const [roomErrors, setRoomErrors] = useState<Record<string, RoomError>>({});
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!sessionToken) return;

    let cancelled = false;
    setRoomChannelError(null);
    setRoomErrors({});

    const url = `${getWsBase()}/ws/room?token=${encodeURIComponent(sessionToken)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onmessage = (ev) => {
      const parsed = serverControlMessageSchema.safeParse(JSON.parse(String(ev.data)));
      if (!parsed.success) return;
      const msg: ServerControlMessage = parsed.data;
      switch (msg.type) {
        case 'welcome':
          setMySessionId(msg.sessionId);
          setLeaderSessionId(msg.leaderSessionId);
          skewRef.current = msg.serverTimeMs - Date.now();
          setClockSkewMs(skewRef.current);
          break;
        case 'room:roster':
          setRoster(msg.members);
          setLeaderSessionId(msg.leaderSessionId);
          break;
        case 'transport:state':
          setTransport({
            running: msg.running,
            bpm: msg.bpm,
            scheduleAtMs: msg.scheduleAtMs,
            fromSessionId: msg.fromSessionId,
          });
          break;
        case 'pong': {
          const now = Date.now();
          const rtt = now - msg.clientSentAt;
          setRttMs(rtt);
          const skew = msg.serverSentAt - (msg.clientSentAt + now) / 2;
          skewRef.current = skew;
          setClockSkewMs(skew);
          break;
        }
        case 'error':
          setLastError(msg.message);
          break;
        case 'room:error':
          setRoomErrors((prev) => ({
            ...prev,
            [msg.sessionId]: {
              displayName: msg.displayName,
              message: msg.message,
              line: msg.line,
            },
          }));
          break;
        case 'room:errorCleared':
          setRoomErrors((prev) => {
            const next = { ...prev };
            delete next[msg.sessionId];
            return next;
          });
          break;
        default:
          break;
      }
    };

    ws.onerror = () => {
      if (cancelled) return;
      setRoomChannelError(
        'Room connection failed. Is the dev server running? (API + WebSocket on port 4000, proxied from Vite.)',
      );
    };

    ws.onclose = (ev) => {
      if (cancelled) return;
      if (!ev.wasClean) {
        setRoomChannelError(
          'Disconnected from room server. Check that npm run dev is running and port 4000 is not blocked.',
        );
      }
    };

    const ping = window.setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping', clientSentAt: Date.now() }));
      }
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(ping);
      ws.close();
      wsRef.current = null;
    };
  }, [sessionToken]);

  const send = useCallback((payload: unknown) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }, []);

  const sendPlay = useCallback(
    (bpm: number, scheduleAtMs: number, cycleAtSchedule?: number) => {
      send({
        type: 'transport:play',
        bpm,
        scheduleAtMs,
        ...(cycleAtSchedule !== undefined ? { cycleAtSchedule } : {}),
      });
    },
    [send],
  );

  const sendStop = useCallback(() => send({ type: 'transport:stop' }), [send]);
  const sendReset = useCallback(() => send({ type: 'transport:reset' }), [send]);
  const sendSetBpm = useCallback((bpm: number) => send({ type: 'transport:setBpm', bpm }), [send]);
  const sendResync = useCallback(
    (bpm: number, scheduleAtMs: number, cycleAtSchedule?: number) => {
      send({
        type: 'transport:resync',
        bpm,
        scheduleAtMs,
        ...(cycleAtSchedule !== undefined ? { cycleAtSchedule } : {}),
      });
    },
    [send],
  );

  const sendClientError = useCallback(
    (message: string, line?: number) => {
      send({
        type: 'client:error',
        message,
        ...(line !== undefined ? { line } : {}),
      });
    },
    [send],
  );

  const sendClientErrorCleared = useCallback(
    () => send({ type: 'client:errorCleared' }),
    [send],
  );

  return {
    roster,
    leaderSessionId,
    mySessionId,
    transport,
    rttMs,
    clockSkewMs,
    lastError,
    roomChannelError,
    roomErrors,
    sendPlay,
    sendStop,
    sendReset,
    sendSetBpm,
    sendResync,
    sendClientError,
    sendClientErrorCleared,
  };
}

/** Estimated server time (ms) using skew from pong. */
export function estimatedServerNow(skewMs: number): number {
  return Date.now() + skewMs;
}
```

- [ ] **Step 3.2 — Build web to check for TypeScript errors**

```bash
npm run build -w @strudel-collab/web
```

Expected: compiles cleanly. (RoomPage will show a TS error about `sendReset` no longer being used — that's resolved in Task 6.)

- [ ] **Step 3.3 — Commit**

```bash
git add apps/web/src/hooks/useRoomControl.ts
git commit -m "feat(web): add roomErrors state and sendClientError/sendClientErrorCleared to useRoomControl"
```

---

## Task 4: `useStrudel` — add `cancelScheduled`

**Files:**
- Modify: `apps/web/src/hooks/useStrudel.ts`

- [ ] **Step 4.1 — Add `cancelScheduled` method**

Replace the full contents of `apps/web/src/hooks/useStrudel.ts` with:

```typescript
import { useCallback, useMemo, useRef } from 'react';
import { evaluate, initStrudel } from '@strudel/web';

type Repl = Awaited<ReturnType<typeof initStrudel>>;

export function useStrudel(): {
  ensureInit: () => Promise<Repl>;
  stop: () => void;
  setBpm: (bpm: number) => Promise<void>;
  runCode: (code: string, autoplay?: boolean) => Promise<void>;
  scheduleRun: (code: string, bpm: number, delayMs: number) => Promise<void>;
  cancelScheduled: () => void;
} {
  const initRef = useRef<Promise<Repl> | null>(null);

  const ensureInit = useCallback(async () => {
    if (!initRef.current) initRef.current = initStrudel();
    return initRef.current;
  }, []);

  /** Safe before `initStrudel` resolves — `hush()` from @strudel/web crashes if `repl` is not ready. */
  const stop = useCallback(() => {
    const p = initRef.current;
    if (!p) return;
    void p
      .then((repl) => {
        repl.stop();
      })
      .catch(() => {});
  }, []);

  const setBpm = useCallback(async (bpm: number) => {
    const repl = await ensureInit();
    repl.setCps(bpm / 60);
  }, [ensureInit]);

  const runCode = useCallback(
    async (code: string, autoplay = true) => {
      await ensureInit();
      await evaluate(code, autoplay);
    },
    [ensureInit],
  );

  const pendingRunCancelRef = useRef<(() => void) | null>(null);

  const cancelScheduled = useCallback(() => {
    pendingRunCancelRef.current?.();
    pendingRunCancelRef.current = null;
  }, []);

  const scheduleRun = useCallback(
    async (code: string, bpm: number, delayMs: number) => {
      // Cancel any previously scheduled run before starting a new one
      pendingRunCancelRef.current?.();
      let cancelled = false;
      pendingRunCancelRef.current = () => { cancelled = true; };

      await new Promise((r) => setTimeout(r, Math.max(0, delayMs)));
      if (cancelled) return;

      const repl = await ensureInit();
      if (cancelled) return;
      repl.setCps(bpm / 60);
      await evaluate(code, true);
    },
    [ensureInit],
  );

  return useMemo(
    () => ({ ensureInit, stop, setBpm, runCode, scheduleRun, cancelScheduled }),
    [ensureInit, stop, setBpm, runCode, scheduleRun, cancelScheduled],
  );
}
```

- [ ] **Step 4.2 — Build web to confirm no TypeScript errors**

```bash
npm run build -w @strudel-collab/web
```

Expected: compiles cleanly.

- [ ] **Step 4.3 — Commit**

```bash
git add apps/web/src/hooks/useStrudel.ts
git commit -m "feat(web): expose cancelScheduled in useStrudel"
```

---

## Task 5: CSS — new styles

**Files:**
- Modify: `apps/web/src/styles.css`

- [ ] **Step 5.1 — Append new CSS rules to `apps/web/src/styles.css`**

Add the following at the end of the file:

```css
/* ── Live performance additions ─────────────────────────────── */

/* Update button — queued/pulsing state */
@keyframes update-pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.45; }
}

button.update-queued {
  background: var(--accent-dim);
  color: var(--text);
  border: 1px solid var(--accent);
  animation: update-pulse 1s ease-in-out infinite;
}

/* Avatar error badge */
.avatar-wrap {
  position: relative;
  display: inline-flex;
}

.avatar-error-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--danger);
  color: #fff;
  font-size: 9px;
  font-weight: 900;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}

/* Room-wide error banner */
.error-banner {
  background: #2d0a0a;
  border: 1px solid #7f1d1d;
  border-radius: 6px;
  padding: 0.4rem 0.75rem;
  font-size: 0.82rem;
  color: #fca5a5;
  margin-bottom: 0.4rem;
}

/* Error detail strip below editor */
.error-strip {
  background: #1c0808;
  border: 1px solid #7f1d1d55;
  border-top: none;
  border-radius: 0 0 6px 6px;
  padding: 0.3rem 0.75rem;
  font-size: 0.78rem;
  color: var(--danger);
  font-family: 'JetBrains Mono', 'SF Mono', Consolas, monospace;
}
```

- [ ] **Step 5.2 — Commit**

```bash
git add apps/web/src/styles.css
git commit -m "feat(web): add CSS for update-queued, error-banner, error-strip, avatar-error-badge"
```

---

## Task 6: `RoomPage` — toolbar restructure + Update button

**Files:**
- Modify: `apps/web/src/pages/RoomPage.tsx`

- [ ] **Step 6.1 — Replace `RoomPage.tsx` with the new implementation**

Replace the full contents of `apps/web/src/pages/RoomPage.tsx` with:

```typescript
import { nextCycleAtMs, suggestedLookaheadMs } from '@strudel-collab/shared';
import { syntaxTree } from '@codemirror/language';
import { type FormEvent, type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { CollabEditor, type CodeApi } from '../components/CollabEditor';
import { estimatedServerNow, useRoomControl } from '../hooks/useRoomControl';
import { useStrudel } from '../hooks/useStrudel';
import { loadJoin, persistJoin, type JoinPayload } from './HomePage';

export function RoomPage(): ReactElement {
  const { code: codeParam } = useParams<{ code: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const [editorGen, setEditorGen] = useState(0);
  const onEditorMounted = useCallback(() => {
    setEditorGen((g) => g + 1);
    const initial = apiRef.current?.getCode();
    if (initial && !lastGoodCodeRef.current) {
      lastGoodCodeRef.current = initial;
      setHasSnapshot(true);
    }
  }, []);
  const code = (codeParam ?? '').toUpperCase();

  const state = location.state as JoinPayload | undefined;
  const stored = code ? loadJoin(code) : null;
  const session = state ?? stored;

  const apiRef = useRef<CodeApi | null>(null);
  const strudel = useStrudel();
  const playingRef = useRef(false);
  const lastGoodCodeRef = useRef<string | null>(null);
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const [updateQueued, setUpdateQueued] = useState(false);

  // Inline join state
  const [joinName, setJoinName] = useState(() => sessionStorage.getItem('strudel-collab-name') ?? '');
  const [joining, setJoining] = useState(false);
  const [joinErr, setJoinErr] = useState<string | null>(null);

  const {
    roster,
    leaderSessionId,
    mySessionId,
    transport,
    rttMs,
    clockSkewMs,
    lastError,
    roomChannelError,
    roomErrors,
    sendPlay,
    sendStop,
    sendSetBpm,
    sendClientError,
    sendClientErrorCleared,
  } = useRoomControl(session?.sessionToken ?? null);

  const [bpm, setBpmLocal] = useState(120);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState(false);

  const handleInlineJoin = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    if (!code) return;
    setJoining(true);
    setJoinErr(null);
    try {
      const dn = joinName.trim() || 'Player';
      const jr = await fetch(`/api/rooms/${encodeURIComponent(code)}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: dn }),
      });
      if (!jr.ok) {
        const j = await jr.json().catch(() => ({})) as { error?: string };
        throw new Error(j.error ?? 'Join failed');
      }
      const body = await jr.json() as { roomId: string; code: string; sessionId: string; sessionToken: string };
      sessionStorage.setItem('strudel-collab-name', dn);
      const payload: JoinPayload = { ...body, displayName: dn };
      persistJoin(body.code, payload);
      navigate(`/room/${body.code}`, { state: payload });
    } catch (err) {
      setJoinErr(err instanceof Error ? err.message : 'Error');
    } finally {
      setJoining(false);
    }
  }, [code, joinName, navigate]);

  useEffect(() => {
    playingRef.current = transport.running;
  }, [transport.running]);

  useEffect(() => {
    if (transport.running) void strudel.setBpm(transport.bpm);
  }, [transport.bpm, transport.running, strudel]);

  const playWithSchedule = useCallback(() => {
    const la = suggestedLookaheadMs(rttMs ?? 60, 100);
    const at = estimatedServerNow(clockSkewMs) + la;
    sendPlay(bpm, at);
  }, [bpm, clockSkewMs, rttMs, sendPlay]);

  const handleLeave = useCallback(() => {
    if (transport.running && !window.confirm('Music is playing — leave anyway?')) return;
    navigate('/');
  }, [transport.running, navigate]);

  const handleCopyLink = useCallback(() => {
    void navigator.clipboard.writeText(window.location.href).then(() => {
      setCopyFeedback(true);
      window.setTimeout(() => setCopyFeedback(false), 2000);
    });
  }, []);

  const flushBpm = useCallback(() => {
    sendSetBpm(bpm);
  }, [bpm, sendSetBpm]);

  const handleRevert = useCallback(() => {
    const good = lastGoodCodeRef.current;
    if (!good) return;
    strudel.cancelScheduled();
    setUpdateQueued(false);
    apiRef.current?.setText(good);
    setEvalError(null);
    sendClientErrorCleared();
  }, [strudel, sendClientErrorCleared]);

  /**
   * Queue the current editor code to evaluate at the next cycle boundary.
   * If an update is already queued, cancels it instead.
   */
  const handleUpdate = useCallback(() => {
    if (updateQueued) {
      strudel.cancelScheduled();
      setUpdateQueued(false);
      return;
    }

    const snap = apiRef.current?.getCode() ?? '';
    const schedAt = transport.scheduleAtMs;
    if (!schedAt) return; // transport not running or no schedule time yet

    const now = estimatedServerNow(clockSkewMs);
    const targetMs = nextCycleAtMs(schedAt, transport.bpm, now);
    const delayMs = Math.max(0, targetMs - now);

    setUpdateQueued(true);

    void strudel.scheduleRun(snap, transport.bpm, delayMs)
      .then(() => {
        setUpdateQueued(false);
        setEvalError(null);
        lastGoodCodeRef.current = snap;
        setHasSnapshot(true);
        sendClientErrorCleared();
      })
      .catch((err: unknown) => {
        setUpdateQueued(false);
        const message = err instanceof Error ? err.message : 'Evaluation error';
        // Extract line number from message if present (e.g. "SyntaxError: ... line 3")
        const lineMatch = message.match(/line[: ]+(\d+)/i);
        const line = lineMatch ? parseInt(lineMatch[1], 10) : undefined;
        setEvalError(message);
        sendClientError(message, line);
      });
  }, [updateQueued, transport, clockSkewMs, strudel, sendClientError, sendClientErrorCleared]);

  // Global keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.target instanceof HTMLInputElement) return;

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        // ⌘↵ → Update (only when transport is running and no error)
        if (transport.running && !evalError) {
          handleUpdate();
        }
      } else if (e.key === '.') {
        e.preventDefault();
        sendStop();
      } else if ((e.key === 'z' || e.key === 'Z') && e.shiftKey) {
        e.preventDefault();
        handleRevert();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [transport.running, evalError, handleUpdate, sendStop, handleRevert]);

  const lastAppliedTransport = useRef<string>('');

  useEffect(() => {
    const key = `${transport.running}-${transport.scheduleAtMs ?? 'x'}-${transport.bpm}-${transport.fromSessionId ?? ''}`;
    if (key === lastAppliedTransport.current) return;
    lastAppliedTransport.current = key;

    if (transport.running && transport.scheduleAtMs != null) {
      const delay = Math.max(0, transport.scheduleAtMs - estimatedServerNow(clockSkewMs));
      const code = apiRef.current?.getCode() ?? '';
      void strudel.scheduleRun(code, transport.bpm, delay);
    } else if (!transport.running) {
      strudel.stop();
      setEvalError(null);
      setUpdateQueued(false);
    }
    setBpmLocal(transport.bpm);
  }, [transport, clockSkewMs, strudel]);

  // Debounced auto-eval on Yjs doc changes (while transport is running)
  useEffect(() => {
    if (!transport.running) return;
    const ytext = apiRef.current?.ytext;
    if (!ytext) return;
    let timer = 0;
    const onChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!playingRef.current) return;
        const view = apiRef.current?.getView();
        if (view) {
          let hasParseError = false;
          syntaxTree(view.state).iterate({
            enter(node) { if (node.type.isError) hasParseError = true; },
          });
          if (hasParseError) {
            setEvalError('Syntax error — fix before playback updates');
            return;
          }
        }
        const snap = apiRef.current?.getCode() ?? '';
        void strudel.runCode(snap)
          .then(() => {
            setEvalError(null);
            lastGoodCodeRef.current = snap;
            setHasSnapshot(true);
          })
          .catch((err: unknown) => {
            // Do NOT stop audio — keep last good code playing
            setEvalError(err instanceof Error ? err.message : 'Evaluation error');
          });
      }, 1200);
    };
    ytext.observe(onChange);
    return () => {
      if (timer) window.clearTimeout(timer);
      ytext.unobserve(onChange);
    };
  }, [transport.running, editorGen, strudel]);

  if (!session || !code) {
    return (
      <div className="shell">
        <h1 style={{ fontWeight: 600 }}>Join Room {code || '—'}</h1>
        <form onSubmit={(e) => void handleInlineJoin(e)} className="card" style={{ marginTop: '1.5rem' }}>
          <label className="muted" htmlFor="inline-name">Display name</label>
          <div className="row" style={{ marginTop: '0.35rem' }}>
            <input
              id="inline-name"
              className="grow"
              value={joinName}
              onChange={(e) => setJoinName(e.target.value)}
              placeholder="Your name"
              maxLength={32}
            />
          </div>
          <div className="row" style={{ marginTop: '1rem' }}>
            <button type="submit" className="primary" disabled={joining}>
              {joining ? 'Joining…' : 'Join room'}
            </button>
            <button type="button" className="ghost" onClick={() => navigate('/')}>Back</button>
          </div>
          {joinErr ? <p className="error" style={{ marginTop: '0.75rem' }}>{joinErr}</p> : null}
        </form>
      </div>
    );
  }

  if (session.code.toUpperCase() !== code) {
    return (
      <div className="shell">
        <p className="error">Room code mismatch.</p>
        <button type="button" className="ghost" onClick={() => navigate('/')}>Back</button>
      </div>
    );
  }

  const roomErrorEntries = Object.entries(roomErrors);

  return (
    <div className="shell">
      {/* Header */}
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: '0.75rem' }}>
        <div className="row" style={{ gap: '0.6rem', alignItems: 'center' }}>
          {transport.running && <span className="live-dot" title="Playing" />}
          <h1 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 600 }}>Room {code}</h1>
        </div>
        <div className="row" style={{ gap: '0.5rem' }}>
          {copyFeedback
            ? <span className="copy-feedback">Copied!</span>
            : <button type="button" className="ghost" onClick={handleCopyLink}>Copy invite link</button>
          }
          <button type="button" className="ghost" onClick={handleLeave}>Leave</button>
        </div>
      </div>

      {/* Avatar list — with error badges */}
      <div className="avatar-list" style={{ marginBottom: '0.75rem' }}>
        {roster.map((m) => (
          <span key={m.sessionId} className="avatar-wrap">
            <span className={`avatar ${m.sessionId === leaderSessionId ? 'leader' : ''}`}>
              {m.displayName}
              {m.sessionId === mySessionId ? ' (you)' : ''}
            </span>
            {roomErrors[m.sessionId] ? (
              <span className="avatar-error-badge" title={roomErrors[m.sessionId].message}>!</span>
            ) : null}
          </span>
        ))}
      </div>

      {/* Room-wide error banners */}
      {roomErrorEntries.map(([sid, err]) => (
        <p key={sid} className="error-banner">
          ⚠ <strong>{err.displayName}&apos;s</strong> update didn&apos;t land — playing last good version
        </p>
      ))}

      {/* Editor */}
      <CollabEditor
        roomId={session.roomId}
        sessionToken={session.sessionToken}
        displayName={session.displayName}
        apiRef={apiRef}
        onReady={onEditorMounted}
        hasError={!!evalError}
      />

      {/* Error detail strip */}
      {evalError ? <p className="error-strip">{evalError}</p> : null}

      {/* Toolbar */}
      <div className="row toolbar">
        {/* Play / Stop toggle */}
        {transport.running ? (
          <button
            type="button"
            className="danger"
            title="Stop (⌘.)"
            onClick={() => sendStop()}
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            title="Play"
            onClick={() => {
              void strudel.ensureInit();
              playWithSchedule();
            }}
          >
            Play
          </button>
        )}

        {/* Update button */}
        <button
          type="button"
          className={updateQueued ? 'update-queued' : 'ghost'}
          disabled={!transport.running || (!!evalError && !updateQueued)}
          title={updateQueued ? 'Cancel queued update (⌘↵)' : 'Update at next cycle (⌘↵)'}
          onClick={handleUpdate}
        >
          {updateQueued ? '⟳ queued…' : '⟳ Update'}
        </button>

        {/* Revert — only shown in error state */}
        {evalError && hasSnapshot ? (
          <button
            type="button"
            className="ghost"
            onClick={handleRevert}
            title="Restore last code that played without errors (⌘⇧Z)"
          >
            ↺ Revert
          </button>
        ) : null}

        {/* BPM */}
        <label className="row muted" style={{ gap: '0.35rem', marginLeft: 'auto' }}>
          BPM
          <input
            type="number"
            min={20}
            max={300}
            value={bpm}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) setBpmLocal(v);
            }}
            onBlur={flushBpm}
            onKeyDown={(e) => { if (e.key === 'Enter') flushBpm(); }}
            style={{ width: '4.5rem' }}
          />
        </label>
      </div>

      {roomChannelError ? <p className="error">{roomChannelError}</p> : null}
      {lastError ? <p className="error">{lastError}</p> : null}
    </div>
  );
}
```

- [ ] **Step 6.2 — Build web to check for TypeScript errors**

```bash
npm run build -w @strudel-collab/web
```

Expected: compiles cleanly with no errors.

- [ ] **Step 6.3 — Manual smoke test in dev**

```bash
npm run dev
```

Open two browser tabs at `http://localhost:5173`.

Tab 1: Create a room, enter a name, click Play.
- Confirm the toolbar shows **Stop** + **⟳ Update** buttons.
- Confirm **Play** is gone while transport is running.

Tab 1: Click **⟳ Update**.
- Confirm the button pulses with "⟳ queued…" for a brief moment, then returns to normal.
- Confirm no errors appear.

Tab 1: Introduce a syntax error in the editor (e.g. delete a closing paren).
- Click **⟳ Update**.
- Confirm the error strip appears below the editor.
- Confirm audio keeps playing.
- Confirm **↺ Revert** button appears.
- Confirm **⟳ Update** is disabled.

Tab 2: Join the same room.
- Confirm the error banner appears: "[name]'s update didn't land — playing last good version".
- Confirm a red `!` badge appears on Tab 1's avatar.

Tab 1: Click **↺ Revert**.
- Confirm error strip disappears.
- Confirm **⟳ Update** re-enables.
- Confirm Tab 2's banner and badge disappear.

- [ ] **Step 6.4 — Commit**

```bash
git add apps/web/src/pages/RoomPage.tsx
git commit -m "feat(web): add Update button with cycle-aligned scheduling, safe error handling, room-wide error UI"
```

---

## Task 7: Push and deploy

- [ ] **Step 7.1 — Push to GitHub**

```bash
git push
```

- [ ] **Step 7.2 — Confirm Railway auto-deploys**

Railway watches the `main` branch. Open the Railway dashboard and confirm a new deployment starts. Wait for it to go green.

- [ ] **Step 7.3 — Smoke test on production URL**

Open the Railway-provided URL in two browser tabs and repeat the smoke test from Step 6.3 against the live deployment.
