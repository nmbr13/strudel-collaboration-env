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
