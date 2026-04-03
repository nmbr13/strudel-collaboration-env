import { type FormEvent, type ReactElement, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { joinRoomBodySchema, MAX_ROOM_MEMBERS } from '@strudel-collab/shared';

const STORAGE_PREFIX = 'strudel-collab:';

export type JoinPayload = {
  roomId: string;
  code: string;
  sessionId: string;
  sessionToken: string;
  displayName: string;
};

export function persistJoin(code: string, payload: JoinPayload): void {
  sessionStorage.setItem(`${STORAGE_PREFIX}${code.toUpperCase()}`, JSON.stringify(payload));
}

export function loadJoin(code: string): JoinPayload | null {
  const raw = sessionStorage.getItem(`${STORAGE_PREFIX}${code.toUpperCase()}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as JoinPayload;
  } catch {
    return null;
  }
}

export function HomePage(): ReactElement {
  const nav = useNavigate();
  const [creating, setCreating] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [name, setName] = useState(() => sessionStorage.getItem('strudel-collab-name') ?? '');
  const [err, setErr] = useState<string | null>(null);

  async function createRoom(): Promise<void> {
    setErr(null);
    setCreating(true);
    try {
      const res = await fetch('/api/rooms', { method: 'POST' });
      if (!res.ok) throw new Error('Could not create room');
      const data = (await res.json()) as { roomId: string; code: string };
      const dn = name.trim() || 'Player';
      const jr = await fetch(`/api/rooms/${encodeURIComponent(data.code)}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(joinRoomBodySchema.parse({ displayName: dn })),
      });
      if (!jr.ok) {
        const j = await jr.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error ?? 'Join failed');
      }
      const body = (await jr.json()) as {
        roomId: string;
        code: string;
        sessionId: string;
        sessionToken: string;
      };
      sessionStorage.setItem('strudel-collab-name', dn);
      const payload: JoinPayload = {
        roomId: body.roomId,
        code: body.code,
        sessionId: body.sessionId,
        sessionToken: body.sessionToken,
        displayName: dn,
      };
      persistJoin(body.code, payload);
      nav(`/room/${body.code}`, { state: payload });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Error');
    } finally {
      setCreating(false);
    }
  }

  async function joinRoom(e: FormEvent): Promise<void> {
    e.preventDefault();
    setErr(null);
    const code = joinCode.trim().toUpperCase();
    if (code.length < 4) {
      setErr('Enter a room code');
      return;
    }
    try {
      const info = await fetch(`/api/rooms/${encodeURIComponent(code)}`);
      const meta = (await info.json()) as { exists: boolean; full: boolean };
      if (!meta.exists) {
        setErr('Room not found');
        return;
      }
      if (meta.full) {
        setErr(`Room is full (max ${MAX_ROOM_MEMBERS})`);
        return;
      }
      const dn = name.trim() || 'Player';
      const jr = await fetch(`/api/rooms/${encodeURIComponent(code)}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(joinRoomBodySchema.parse({ displayName: dn })),
      });
      if (!jr.ok) {
        const j = await jr.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error ?? 'Join failed');
      }
      const body = (await jr.json()) as {
        roomId: string;
        code: string;
        sessionId: string;
        sessionToken: string;
      };
      sessionStorage.setItem('strudel-collab-name', dn);
      const payload: JoinPayload = {
        roomId: body.roomId,
        code: body.code,
        sessionId: body.sessionId,
        sessionToken: body.sessionToken,
        displayName: dn,
      };
      persistJoin(body.code, payload);
      nav(`/room/${body.code}`, { state: payload });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Error');
    }
  }

  return (
    <div className="shell">
      <h1 style={{ fontWeight: 600, letterSpacing: '-0.02em' }}>Strudel Collab</h1>
      <p className="muted" style={{ maxWidth: '36rem', lineHeight: 1.5 }}>
        Live-code Strudel patterns with up to {MAX_ROOM_MEMBERS} people in a room. Audio runs locally in each
        browser; transport stays aligned via the room leader.
      </p>
      <div className="card" style={{ marginTop: '1.5rem' }}>
        <label className="muted" htmlFor="name">
          Display name
        </label>
        <div className="row" style={{ marginTop: '0.35rem' }}>
          <input
            id="name"
            className="grow"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            maxLength={32}
          />
        </div>
        <div className="row" style={{ marginTop: '1.25rem' }}>
          <button type="button" className="primary" disabled={creating} onClick={() => void createRoom()}>
            {creating ? 'Creating…' : 'Create room'}
          </button>
        </div>
        <p className="muted" style={{ marginTop: '1.25rem' }}>
          Or join with a code
        </p>
        <form onSubmit={(e) => void joinRoom(e)} className="row" style={{ marginTop: '0.5rem' }}>
          <input
            className="grow"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            placeholder="ROOM CODE"
            style={{ textTransform: 'uppercase' }}
          />
          <button type="submit" className="ghost">
            Join
          </button>
        </form>
        {err ? (
          <p className="error" style={{ marginTop: '0.75rem' }}>
            {err}
          </p>
        ) : null}
      </div>
    </div>
  );
}
