import { randomBytes, randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { customAlphabet } from 'nanoid';
import {
  MAX_ROOM_MEMBERS,
  clientControlMessageSchema,
  type ClientControlMessage,
  type ServerControlMessage,
} from '@strudel-collab/shared';
import { z } from 'zod';

const roomCode = customAlphabet('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', 6);

export type Member = {
  sessionId: string;
  displayName: string;
  controlSocket: WebSocket | null;
  joinedAt: number;
};

export type Room = {
  id: string;
  code: string;
  createdAt: number;
  members: Map<string, Member>;
  leaderSessionId: string | null;
  transport: { running: boolean; bpm: number };
};

const roomsById = new Map<string, Room>();
const roomsByCode = new Map<string, string>();
const sessions = new Map<
  string,
  { roomId: string; sessionId: string; token: string }
>();

function pickLeader(room: Room): string | null {
  let oldest: Member | null = null;
  for (const m of room.members.values()) {
    if (!oldest || m.joinedAt < oldest.joinedAt) oldest = m;
  }
  return oldest?.sessionId ?? null;
}

export function createRoom(): { roomId: string; code: string } {
  const id = randomUUID();
  const code = roomCode();
  const room: Room = {
    id,
    code,
    createdAt: Date.now(),
    members: new Map(),
    leaderSessionId: null,
    transport: { running: false, bpm: 120 },
  };
  roomsById.set(id, room);
  roomsByCode.set(code.toUpperCase(), id);
  return { roomId: id, code };
}

export function getRoomByCode(code: string): Room | undefined {
  const id = roomsByCode.get(code.trim().toUpperCase());
  if (!id) return undefined;
  return roomsById.get(id);
}

export function getRoomById(id: string): Room | undefined {
  return roomsById.get(id);
}

export function issueSessionToken(): string {
  return randomBytes(32).toString('hex');
}

export function registerSession(roomId: string, sessionId: string, token: string): void {
  sessions.set(token, { roomId, sessionId, token });
}

export function getSessionByToken(token: string): { roomId: string; sessionId: string } | null {
  const s = sessions.get(token);
  return s ? { roomId: s.roomId, sessionId: s.sessionId } : null;
}

export function joinRoom(
  code: string,
  displayName: string,
): { ok: true; room: Room; sessionId: string; token: string } | { ok: false; reason: string } {
  const room = getRoomByCode(code);
  if (!room) return { ok: false, reason: 'ROOM_NOT_FOUND' };
  if (room.members.size >= MAX_ROOM_MEMBERS) return { ok: false, reason: 'ROOM_FULL' };
  const sessionId = randomUUID();
  const token = issueSessionToken();
  room.members.set(sessionId, {
    sessionId,
    displayName,
    controlSocket: null,
    joinedAt: Date.now(),
  });
  if (!room.leaderSessionId) room.leaderSessionId = sessionId;
  registerSession(room.id, sessionId, token);
  return { ok: true, room, sessionId, token };
}

const leaveGraceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function leaveKey(roomId: string, sessionId: string): string {
  return `${roomId}:${sessionId}`;
}

export function attachControlSocket(roomId: string, sessionId: string, ws: WebSocket): Room | null {
  const room = roomsById.get(roomId);
  if (!room) return null;
  const m = room.members.get(sessionId);
  if (!m) return null;
  const k = leaveKey(roomId, sessionId);
  const t = leaveGraceTimers.get(k);
  if (t) {
    clearTimeout(t);
    leaveGraceTimers.delete(k);
  }
  m.controlSocket = ws;
  return room;
}

export function scheduleControlDisconnect(roomId: string, sessionId: string): void {
  const room = roomsById.get(roomId);
  if (!room) return;
  const m = room.members.get(sessionId);
  if (m) m.controlSocket = null;
  broadcastRoster(room);
  const k = leaveKey(roomId, sessionId);
  clearTimeout(leaveGraceTimers.get(k));
  leaveGraceTimers.set(
    k,
    setTimeout(() => {
      leaveGraceTimers.delete(k);
      const r = roomsById.get(roomId);
      const mem = r?.members.get(sessionId);
      if (mem && !mem.controlSocket) removeMember(roomId, sessionId);
    }, 15000),
  );
}

/** Call when Yjs / control disconnect may leave member with no sockets — control disconnect always removes member after ws close */
export function removeMember(roomId: string, sessionId: string): void {
  const room = roomsById.get(roomId);
  if (!room) return;
  room.members.delete(sessionId);
  for (const [tok, s] of sessions.entries()) {
    if (s.sessionId === sessionId && s.roomId === roomId) sessions.delete(tok);
  }
  if (room.leaderSessionId === sessionId) {
    room.leaderSessionId = pickLeader(room);
    room.transport.running = false;
  }
  if (room.members.size === 0) {
    roomsById.delete(room.id);
    roomsByCode.delete(room.code.toUpperCase());
  } else {
    broadcastRoster(room);
  }
}

export function rosterPayload(room: Room): ServerControlMessage {
  return {
    type: 'room:roster',
    members: Array.from(room.members.values()).map((m) => ({
      sessionId: m.sessionId,
      displayName: m.displayName,
    })),
    leaderSessionId: room.leaderSessionId,
  };
}

export function broadcastRoster(room: Room): void {
  const msg = JSON.stringify(rosterPayload(room));
  for (const m of room.members.values()) {
    if (m.controlSocket?.readyState === 1) m.controlSocket.send(msg);
  }
}

export function broadcastControl(room: Room, msg: ServerControlMessage, exceptSessionId?: string): void {
  const raw = JSON.stringify(msg);
  for (const m of room.members.values()) {
    if (exceptSessionId && m.sessionId === exceptSessionId) continue;
    if (m.controlSocket?.readyState === 1) m.controlSocket.send(raw);
  }
}

export function sendControl(ws: WebSocket, msg: ServerControlMessage): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

export function validateTokenForRoom(token: string, roomIdFromPath: string): { roomId: string; sessionId: string } | null {
  const s = sessions.get(token);
  if (!s || s.roomId !== roomIdFromPath) return null;
  return { roomId: s.roomId, sessionId: s.sessionId };
}

export function handleControlMessage(
  room: Room,
  sessionId: string,
  raw: unknown,
): void {
  const parsed = clientControlMessageSchema.safeParse(raw);
  if (!parsed.success) return;

  const msg: ClientControlMessage = parsed.data;
  const leader = room.leaderSessionId;

  switch (msg.type) {
    case 'ping': {
      const m = room.members.get(sessionId);
      if (m?.controlSocket)
        sendControl(m.controlSocket, {
          type: 'pong',
          clientSentAt: msg.clientSentAt,
          serverSentAt: Date.now(),
        });
      break;
    }
    case 'transport:play':
    case 'transport:resync': {
      room.transport.running = true;
      room.transport.bpm = msg.bpm;
      broadcastControl(room, {
        type: 'transport:state',
        running: true,
        bpm: msg.bpm,
        scheduleAtMs: msg.scheduleAtMs,
        fromSessionId: sessionId,
      });
      break;
    }
    case 'transport:stop':
    case 'transport:reset': {
      room.transport.running = false;
      broadcastControl(room, {
        type: 'transport:state',
        running: false,
        bpm: room.transport.bpm,
        fromSessionId: sessionId,
      });
      break;
    }
    case 'transport:setBpm': {
      room.transport.bpm = msg.bpm;
      broadcastControl(room, {
        type: 'transport:state',
        running: room.transport.running,
        bpm: msg.bpm,
        fromSessionId: sessionId,
      });
      break;
    }
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
    default:
      break;
  }
}

/** Pathname like `/ws/yjs/<roomUuid>` (query string stripped by caller). */
export function parseRoomIdFromYjsPath(pathname: string): string | null {
  const path = pathname.split('?')[0] ?? pathname;
  const parts = path.replace(/^\//, '').split('/').filter(Boolean);
  if (parts[0] === 'ws' && parts[1] === 'yjs' && parts[2]) {
    return z.string().uuid().safeParse(parts[2]).success ? parts[2] : null;
  }
  return null;
}
