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
        // Silently ignore cancellation — the user intentionally cancelled the queued update
        if (err instanceof Error && (err as { cancelled?: boolean }).cancelled) {
          return;
        }
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
        if (transport.running && (!evalError || updateQueued)) {
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
