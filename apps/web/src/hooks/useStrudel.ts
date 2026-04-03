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
      if (cancelled) throw Object.assign(new Error('scheduleRun cancelled'), { cancelled: true });

      const repl = await ensureInit();
      if (cancelled) throw Object.assign(new Error('scheduleRun cancelled'), { cancelled: true });
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
