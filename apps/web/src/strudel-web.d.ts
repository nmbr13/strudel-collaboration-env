declare module '@strudel/web' {
  export function initStrudel(options?: Record<string, unknown>): Promise<{
    setCps: (cps: number) => void;
    evaluate: (code: string, autoplay?: boolean) => Promise<unknown>;
    stop: () => void;
  }>;

  export function evaluate(code: string, autoplay?: boolean): Promise<unknown>;
}
