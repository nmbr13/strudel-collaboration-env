import { suggestedLookaheadMs } from '@strudel-collab/shared';
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
    // Seed the first snapshot from whatever is in the doc when the editor is ready
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

  // Inline join state — used when landing on the room URL without a session
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
    sendPlay,
    sendStop,
    sendReset,
    sendSetBpm,
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
    apiRef.current?.setText(good);
    setEvalError(null);
  }, []);

  // Shared eval logic — used by debounced observer and Cmd+Enter shortcut
  const runCurrentCode = useCallback(() => {
    const snap = apiRef.current?.getCode() ?? '';
    void strudel.runCode(snap)
      .then(() => {
        setEvalError(null);
        lastGoodCodeRef.current = snap;
        setHasSnapshot(true);
      })
      .catch((err: unknown) => {
        setEvalError(err instanceof Error ? err.message : 'Evaluation error');
      });
  }, [strudel]);

  // Global keyboard shortcuts — declared after all callbacks are defined
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      // Allow browser defaults when focus is on a plain input (e.g. BPM field)
      if (e.target instanceof HTMLInputElement) return;

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (transport.running) {
          runCurrentCode(); // force immediate re-evaluation
        } else {
          void strudel.ensureInit();
          playWithSchedule();
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
  }, [transport.running, strudel, playWithSchedule, sendStop, runCurrentCode, handleRevert]);

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
    }
    setBpmLocal(transport.bpm);
  }, [transport, clockSkewMs, strudel]);

  useEffect(() => {
    if (!transport.running) return;
    const ytext = apiRef.current?.ytext;
    if (!ytext) return;
    let timer = 0;
    const onChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!playingRef.current) return;
        // Option B: syntax gate — skip evaluation if the parse tree has errors
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
        // Option A: silent error recovery — keep audio alive on runtime errors
        runCurrentCode();
      }, 1200);
    };
    ytext.observe(onChange);
    return () => {
      if (timer) window.clearTimeout(timer);
      ytext.unobserve(onChange);
    };
  }, [transport.running, editorGen, strudel, runCurrentCode]);


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

  return (
    <div className="shell">
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

      <div className="avatar-list" style={{ marginBottom: '0.75rem' }}>
        {roster.map((m) => (
          <span key={m.sessionId} className={`avatar ${m.sessionId === leaderSessionId ? 'leader' : ''}`}>
            {m.displayName}
            {m.sessionId === mySessionId ? ' (you)' : ''}
          </span>
        ))}
      </div>

      <CollabEditor
        roomId={session.roomId}
        sessionToken={session.sessionToken}
        displayName={session.displayName}
        apiRef={apiRef}
        onReady={onEditorMounted}
        hasError={!!evalError}
      />
      {evalError ? <p className="error" style={{ marginTop: '0.4rem', fontSize: '0.8rem' }}>{evalError}</p> : null}

      <div className="row toolbar">
        <button
          type="button"
          className={transport.running ? 'ghost' : 'primary'}
          disabled={transport.running}
          title="Play (⌘Enter)"
          onClick={() => {
            void strudel.ensureInit();
            playWithSchedule();
          }}
        >
          Play
        </button>
        <button
          type="button"
          className={transport.running ? 'danger' : 'ghost'}
          title="Stop (⌘.)"
          onClick={() => sendStop()}
        >
          Stop
        </button>
        <button
          type="button"
          className="ghost"
          onClick={handleRevert}
          disabled={!hasSnapshot}
          title="Revert to last version that played without errors (⌘⇧Z)"
        >
          Revert
        </button>
        <button type="button" className="ghost" onClick={() => sendReset()}>
          Reset
        </button>
        <label className="row muted" style={{ gap: '0.35rem' }}>
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

