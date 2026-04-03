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
    if (result.success) expect(result.data.line).toBe(3); // add this line
  });

  it('rejects room:error with missing sessionId', () => {
    const result = serverControlMessageSchema.safeParse({
      type: 'room:error',
      displayName: 'alice',
      message: 'SyntaxError',
    });
    expect(result.success).toBe(false);
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
    const result = nextCycleAtMs(0, 120, 750);
    expect(result).toBe(1000);
  });

  it('returns next cycle when exactly on a boundary', () => {
    const result = nextCycleAtMs(0, 120, 1000);
    expect(result).toBe(1500);
  });

  it('handles BPM 60 (cycle = 1000ms)', () => {
    const result = nextCycleAtMs(0, 60, 2400);
    expect(result).toBe(3000);
  });

  it('works with a non-zero scheduleAtMs', () => {
    const result = nextCycleAtMs(5000, 120, 5750);
    expect(result).toBe(6000);
  });
});
