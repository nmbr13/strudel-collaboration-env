import { z } from 'zod';

export const MAX_ROOM_MEMBERS = 4 as const;

export const ROOM_CODE_REGEX = /^[A-HJ-NP-Z2-9]{6}$/i;

export const createRoomResponseSchema = z.object({
  roomId: z.string().uuid(),
  code: z.string().regex(ROOM_CODE_REGEX),
});

export const joinRoomBodySchema = z.object({
  displayName: z.string().min(1).max(32).trim(),
});

export const joinRoomResponseSchema = z.object({
  roomId: z.string().uuid(),
  code: z.string(),
  sessionId: z.string().uuid(),
  sessionToken: z.string().min(16),
  /** If omitted, browser client should use `ws(s)://` + `location.host` (e.g. Vite proxy). */
  wsBaseUrl: z.string().url().optional(),
});

export const roomInfoResponseSchema = z.object({
  exists: z.boolean(),
  memberCount: z.number().int().min(0).max(MAX_ROOM_MEMBERS),
  full: z.boolean(),
});

/** Client → server control messages */
export const clientControlMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ping'),
    clientSentAt: z.number(),
  }),
  z.object({
    type: z.literal('transport:play'),
    bpm: z.number().min(20).max(300),
    /** Server time when all clients should start (ms since epoch) */
    scheduleAtMs: z.number(),
    /** Logical cycle position at schedule time (optional alignment) */
    cycleAtSchedule: z.number().optional(),
  }),
  z.object({
    type: z.literal('transport:stop'),
  }),
  z.object({
    type: z.literal('transport:reset'),
  }),
  z.object({
    type: z.literal('transport:setBpm'),
    bpm: z.number().min(20).max(300),
  }),
  z.object({
    type: z.literal('transport:resync'),
    bpm: z.number().min(20).max(300),
    scheduleAtMs: z.number(),
    cycleAtSchedule: z.number().optional(),
  }),
  z.object({
    type: z.literal('client:error'),
    message: z.string(),
    line: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('client:errorCleared'),
  }),
]);

/** Server → client control messages */
export const serverControlMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('pong'),
    clientSentAt: z.number(),
    serverSentAt: z.number(),
  }),
  z.object({
    type: z.literal('room:roster'),
    members: z.array(
      z.object({
        sessionId: z.string().uuid(),
        displayName: z.string(),
      }),
    ),
    leaderSessionId: z.string().uuid().nullable(),
  }),
  z.object({
    type: z.literal('transport:state'),
    running: z.boolean(),
    bpm: z.number(),
    scheduleAtMs: z.number().optional(),
    fromSessionId: z.string().uuid(),
  }),
  z.object({
    type: z.literal('error'),
    code: z.string(),
    message: z.string(),
  }),
  z.object({
    type: z.literal('welcome'),
    sessionId: z.string().uuid(),
    leaderSessionId: z.string().uuid().nullable(),
    serverTimeMs: z.number(),
  }),
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
]);

export type CreateRoomResponse = z.infer<typeof createRoomResponseSchema>;
export type JoinRoomBody = z.infer<typeof joinRoomBodySchema>;
export type JoinRoomResponse = z.infer<typeof joinRoomResponseSchema>;
export type RoomInfoResponse = z.infer<typeof roomInfoResponseSchema>;
export type ClientControlMessage = z.infer<typeof clientControlMessageSchema>;
export type ServerControlMessage = z.infer<typeof serverControlMessageSchema>;

/** Adaptive play lookahead from RTT (client-side). */
export function suggestedLookaheadMs(rttMs: number, base = 80): number {
  return Math.min(400, Math.max(base, Math.round(rttMs * 0.75 + base)));
}

/**
 * Returns the server timestamp (ms) of the next cycle boundary after `nowMs`.
 * Used to schedule cycle-aligned code updates.
 *
 * @param scheduleAtMs - Server time when transport started (from transport:state)
 * @param bpm - Current BPM
 * @param nowMs - Current estimated server time (use estimatedServerNow())
 */
export function nextCycleAtMs(scheduleAtMs: number, bpm: number, nowMs: number): number {
  const cycleDurationMs = (60 / bpm) * 1000; // 1 Strudel cycle = 1 beat at the given BPM
  const elapsed = nowMs - scheduleAtMs;
  if (elapsed < 0) return scheduleAtMs; // nowMs is before transport start; first cycle hasn't begun
  const cyclesElapsed = Math.floor(elapsed / cycleDurationMs);
  return scheduleAtMs + (cyclesElapsed + 1) * cycleDurationMs;
}
