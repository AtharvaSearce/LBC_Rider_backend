import { processAICommandStream } from '../../../../src/services/ai/orchestrator-stream';
import type { AIStreamEvent } from '../../../../src/services/ai/stream-events';

const generateContentStreamMock = jest.fn();

jest.mock('../../../../src/services/ai/context', () => ({
  buildRiderContext: jest.fn().mockResolvedValue({
    rider: { id: 'rider-1', name: 'Juan', hubName: 'Makati Hub' },
    manifest: {
      manifestId: 'DDR-001',
      status: 'in_progress',
      totalStops: 3,
      completed: 1,
      failed: 0,
      remaining: 2,
    },
    activeStops: [],
    nextStop: null,
  }),
}));

jest.mock('../../../../src/services/ai/handlers', () => ({
  executeTool: jest.fn().mockResolvedValue({
    data: { remaining: 2 },
    clientAction: null,
  }),
}));

jest.mock('../../../../src/services/ai/gemini', () => ({
  getGeminiModel: jest.fn().mockReturnValue({
    generateContentStream: (...args: unknown[]) =>
      generateContentStreamMock(...args),
  }),
  extractFunctionCall: jest.fn((parts: unknown[]) => {
    const fc = (parts as { functionCall?: { name: string; args: object } }[]).find(
      (p) => p.functionCall
    );
    return fc?.functionCall
      ? { name: fc.functionCall.name, args: fc.functionCall.args ?? {} }
      : null;
  }),
  extractText: jest.fn((parts: unknown[]) => {
    const text = (parts as { text?: string }[]).find((p) => p.text)?.text;
    return text ?? null;
  }),
  getResponseParts: jest.fn(
    (response: { candidates?: { content?: { parts?: unknown[] } }[] }) =>
      response.candidates?.[0]?.content?.parts ?? []
  ),
}));

async function collectEvents(generator: AsyncGenerator<AIStreamEvent>) {
  const events: AIStreamEvent[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

beforeEach(() => {
  generateContentStreamMock.mockReset();
});

describe('processAICommandStream', () => {
  it('emits status, thinking, message_delta, and done for conversational replies', async () => {
    generateContentStreamMock.mockResolvedValueOnce({
      stream: (async function* () {
        yield { text: () => 'Hello rider!' };
      })(),
      response: Promise.resolve({
        candidates: [{ content: { parts: [{ text: 'Hello rider!' }] } }],
      }),
    });

    const events = await collectEvents(
      processAICommandStream('rider-1', { text: 'hi' })
    );

    expect(events.map((e) => e.type)).toEqual([
      'status',
      'thinking',
      'thinking',
      'thinking',
      'status',
      'message_delta',
      'done',
    ]);
    expect(events[events.length - 1]).toMatchObject({
      type: 'done',
      response: {
        intent: 'CONVERSATIONAL',
        message: 'Hello rider!',
      },
    });
  });

  it('emits tool_start and tool_end when a function is called', async () => {
    generateContentStreamMock
      .mockResolvedValueOnce({
        stream: (async function* () {
          yield {
            text: () => '',
            functionCalls: () => [{ name: 'query_status', args: { metric: 'remaining' } }],
          };
        })(),
        response: Promise.resolve({
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      name: 'query_status',
                      args: { metric: 'remaining' },
                    },
                  },
                ],
              },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        stream: (async function* () {
          yield { text: () => 'Two stops left.' };
        })(),
        response: Promise.resolve({
          candidates: [{ content: { parts: [{ text: 'Two stops left.' }] } }],
        }),
      });

    const events = await collectEvents(
      processAICommandStream('rider-1', { text: 'how many left?' })
    );

    const types = events.map((e) => e.type);
    expect(types).toContain('tool_start');
    expect(types).toContain('tool_end');
    expect(types).toContain('message_delta');
    expect(types[types.length - 1]).toEqual('done');
    expect(events[events.length - 1]).toMatchObject({
      type: 'done',
      response: { intent: 'query_status', message: 'Two stops left.' },
    });
  });
});
