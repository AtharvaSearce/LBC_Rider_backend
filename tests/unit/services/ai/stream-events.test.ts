import { formatSSE, writeSSE } from '../../../../src/services/ai/stream-events';
import type { Response } from 'express';

describe('stream-events', () => {
  it('formatSSE serializes event type and payload', () => {
    const sse = formatSSE({ type: 'status', message: 'Thinking…' });
    expect(sse).toBe('event: status\ndata: {"message":"Thinking…"}\n\n');
  });

  it('formatSSE handles tool_start events', () => {
    const sse = formatSSE({
      type: 'tool_start',
      tool: 'optimize_route',
      label: 'Optimizing your route',
    });
    expect(sse).toContain('event: tool_start');
    expect(sse).toContain('Optimizing your route');
  });

  it('writeSSE calls res.write with formatted payload', () => {
    const writes: string[] = [];
    const res = {
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
    } as unknown as Response;

    writeSSE(res, { type: 'thinking', step: 'Reading manifest', index: 0 });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('event: thinking');
    expect(writes[0]).toContain('Reading manifest');
  });
});
