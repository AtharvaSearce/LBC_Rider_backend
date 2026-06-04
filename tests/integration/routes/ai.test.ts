import '../../../src/types/express';
import request from 'supertest';
import { Prisma, StopStatus } from '@prisma/client';

// Mock @google/generative-ai BEFORE importing the router. The router imports
// `GoogleGenerativeAI` and `SchemaType` at module load. We never want a live
// call to Gemini from any test — every model.generateContent call is queued
// via `__queueResponses` below.
const generateContentMock = jest.fn();

jest.mock('@google/generative-ai', () => {
  const getGenerativeModel = jest.fn().mockReturnValue({
    generateContent: generateContentMock,
  });
  return {
    GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
      getGenerativeModel,
    })),
    SchemaType: {
      OBJECT: 'object',
      STRING: 'string',
      NUMBER: 'number',
      ARRAY: 'array',
      BOOLEAN: 'boolean',
    },
  };
});

import { prismaMock } from '../../helpers/prismaMock';
import { buildApp } from '../../helpers/app';
import { riderAuthHeader } from '../../helpers/auth';
import { authMiddleware } from '../../../src/middleware/rider-auth';
import aiRouter from '../../../src/routes/ai';
import { makeManifest, makeStop } from '../../helpers/fixtures';

const app = buildApp({
  mountPath: '/api/ai',
  router: aiRouter,
  preMiddleware: [authMiddleware],
});

beforeEach(() => {
  generateContentMock.mockReset();
  process.env.GEMINI_API_KEY = 'test-gemini-key';
});

// Build a Gemini response shaped like the SDK's `result` object — the route
// only reads `result.response.candidates[0].content.parts[]`.
function geminiFunctionCall(name: string, args: Record<string, unknown>) {
  return {
    response: {
      candidates: [
        {
          content: {
            parts: [{ functionCall: { name, args } }],
          },
        },
      ],
    },
  };
}

function geminiText(text: string) {
  return {
    response: {
      candidates: [{ content: { parts: [{ text }] } }],
    },
  };
}

// ─── Auth + validation ────────────────────────────────────────────────────

describe('POST /api/ai/command — auth & validation', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).post('/api/ai/command').send({ text: 'hello' });
    expect(res.status).toBe(401);
  });

  it('400 when text is missing', async () => {
    const res = await request(app)
      .post('/api/ai/command')
      .set('Authorization', riderAuthHeader())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Command text is required' });
  });

  it('500 when GEMINI_API_KEY is not configured', async () => {
    delete process.env.GEMINI_API_KEY;

    const res = await request(app)
      .post('/api/ai/command')
      .set('Authorization', riderAuthHeader())
      .send({ text: 'optimize my route' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'AI processing failed' });
  });
});

// ─── Conversational fallback ──────────────────────────────────────────────

describe('POST /api/ai/command — conversational response', () => {
  it('returns CONVERSATIONAL intent when Gemini returns plain text (no tool call)', async () => {
    (prismaMock.manifest.findFirst as jest.Mock).mockResolvedValue(null);
    generateContentMock.mockResolvedValueOnce(geminiText('Hello there, rider!'));

    const res = await request(app)
      .post('/api/ai/command')
      .set('Authorization', riderAuthHeader({ riderId: 'rider-1' }))
      .send({ text: 'hi' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      intent: 'CONVERSATIONAL',
      message: 'Hello there, rider!',
      action: null,
      data: null,
    });

    // Only one Gemini call (no follow-up summary because no tool call).
    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to a default message when Gemini returns no parts', async () => {
    (prismaMock.manifest.findFirst as jest.Mock).mockResolvedValue(null);
    generateContentMock.mockResolvedValueOnce({
      response: { candidates: [{ content: { parts: [] } }] },
    });

    const res = await request(app)
      .post('/api/ai/command')
      .set('Authorization', riderAuthHeader())
      .send({ text: 'lol' });

    expect(res.status).toBe(200);
    expect(res.body.intent).toBe('CONVERSATIONAL');
    expect(res.body.message).toMatch(/I'm not sure how to help/);
  });
});

// ─── filter_deliveries (no DB writes) ─────────────────────────────────────

describe('POST /api/ai/command — filter_deliveries tool', () => {
  it('200 returns NAVIGATE action with provided filters and a follow-up summary message', async () => {
    (prismaMock.manifest.findFirst as jest.Mock).mockResolvedValue(makeManifest());
    (prismaMock.stop.findMany as jest.Mock).mockResolvedValue([]);

    generateContentMock
      .mockResolvedValueOnce(
        geminiFunctionCall('filter_deliveries', { date: 'yesterday', status: 'failed' })
      )
      .mockResolvedValueOnce(geminiText('Showing yesterday’s failed deliveries.'));

    const res = await request(app)
      .post('/api/ai/command')
      .set('Authorization', riderAuthHeader({ riderId: 'rider-1' }))
      .send({ text: 'show yesterday failures' });

    expect(res.status).toBe(200);
    expect(res.body.intent).toBe('filter_deliveries');
    expect(res.body.message).toBe('Showing yesterday’s failed deliveries.');
    expect(res.body.action).toEqual({
      action: {
        type: 'NAVIGATE',
        tab: 'deliveries',
        filters: { date: 'yesterday', status: 'failed' },
      },
    });
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it('200 fills filter defaults to today/all when Gemini omits args', async () => {
    (prismaMock.manifest.findFirst as jest.Mock).mockResolvedValue(makeManifest());
    (prismaMock.stop.findMany as jest.Mock).mockResolvedValue([]);

    generateContentMock
      .mockResolvedValueOnce(geminiFunctionCall('filter_deliveries', {}))
      .mockResolvedValueOnce(geminiText('Showing today.'));

    const res = await request(app)
      .post('/api/ai/command')
      .set('Authorization', riderAuthHeader())
      .send({ text: 'show deliveries' });

    expect(res.body.action.action.filters).toEqual({ date: 'today', status: 'all' });
  });
});

// ─── query_status (read-only DB) ──────────────────────────────────────────

describe('POST /api/ai/command — query_status tool', () => {
  it('200 returns the requested metric (cod_total) computed from stops', async () => {
    (prismaMock.manifest.findFirst as jest.Mock).mockResolvedValue(makeManifest());
    // First findMany builds the prompt context. Second findMany powers query_status.
    (prismaMock.stop.findMany as jest.Mock)
      .mockResolvedValueOnce([
        { ...makeStop(), order: { recipientName: 'Maria', addressText: '123 Ayala' } },
      ])
      .mockResolvedValueOnce([
        {
          ...makeStop({ status: StopStatus.completed }),
          order: { recipientName: 'Maria' },
          deliveryResult: { codCollected: new Prisma.Decimal(500) },
        },
        {
          ...makeStop({ id: 'stop-2', status: StopStatus.completed }),
          order: { recipientName: 'Pedro' },
          deliveryResult: { codCollected: new Prisma.Decimal(750) },
        },
        {
          ...makeStop({ id: 'stop-3', status: StopStatus.failed }),
          order: { recipientName: 'Ana' },
          deliveryResult: null,
        },
      ]);

    generateContentMock
      .mockResolvedValueOnce(geminiFunctionCall('query_status', { metric: 'cod_total' }))
      .mockResolvedValueOnce(geminiText('You have collected 1250 PHP today.'));

    const res = await request(app)
      .post('/api/ai/command')
      .set('Authorization', riderAuthHeader({ riderId: 'rider-1' }))
      .send({ text: 'how much COD have I collected?' });

    expect(res.status).toBe(200);
    expect(res.body.intent).toBe('query_status');
    expect(res.body.action).toEqual({ metric: 'cod_total', data: 1250 });
  });

  it('200 returns the summary metric with totals/remaining/completed/failed', async () => {
    (prismaMock.manifest.findFirst as jest.Mock).mockResolvedValue(makeManifest());
    (prismaMock.stop.findMany as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { ...makeStop({ status: StopStatus.pending }), order: { recipientName: 'A' }, deliveryResult: null },
        { ...makeStop({ id: 's2', status: StopStatus.in_progress }), order: { recipientName: 'B' }, deliveryResult: null },
        { ...makeStop({ id: 's3', status: StopStatus.completed }), order: { recipientName: 'C' }, deliveryResult: null },
        { ...makeStop({ id: 's4', status: StopStatus.failed }), order: { recipientName: 'D' }, deliveryResult: null },
        { ...makeStop({ id: 's5', status: StopStatus.rts }), order: { recipientName: 'E' }, deliveryResult: null },
      ]);

    generateContentMock
      .mockResolvedValueOnce(geminiFunctionCall('query_status', { metric: 'summary' }))
      .mockResolvedValueOnce(geminiText('Here is your summary.'));

    const res = await request(app)
      .post('/api/ai/command')
      .set('Authorization', riderAuthHeader())
      .send({ text: 'summary please' });

    expect(res.body.action.data).toEqual({
      total: 5,
      remaining: 2,
      completed: 1,
      failed: 2, // failed + rts
      codTotal: 0,
    });
  });

  it('200 with no manifest → action contains the no-manifest error', async () => {
    (prismaMock.manifest.findFirst as jest.Mock).mockResolvedValue(null);
    (prismaMock.stop.findMany as jest.Mock).mockResolvedValue([]);

    generateContentMock
      .mockResolvedValueOnce(geminiFunctionCall('query_status', { metric: 'remaining' }))
      .mockResolvedValueOnce(geminiText('No manifest active.'));

    const res = await request(app)
      .post('/api/ai/command')
      .set('Authorization', riderAuthHeader())
      .send({ text: 'how many left?' });

    expect(res.body.action).toEqual({ error: 'No manifest found' });
  });
});

// ─── optimize_route (writes sequences) ────────────────────────────────────

describe('POST /api/ai/command — optimize_route tool', () => {
  it('200 promotes priorityStopId to the front and re-sequences pending stops past completed offset', async () => {
    (prismaMock.manifest.findFirst as jest.Mock).mockResolvedValue(makeManifest());

    // First findMany → context-prompt stops; not relevant here, return [].
    // Second findMany → executeOptimizeRoute pendingStops list.
    (prismaMock.stop.findMany as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeStop({ id: 's1', stopId: 'stop-001', sequence: 3 }),
        makeStop({ id: 's2', stopId: 'stop-002', sequence: 4 }),
        makeStop({ id: 's3', stopId: 'stop-003', sequence: 5 }),
      ]);

    (prismaMock.stop.count as jest.Mock).mockResolvedValue(2); // 2 already completed
    (prismaMock.stop.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

    generateContentMock
      .mockResolvedValueOnce(
        geminiFunctionCall('optimize_route', { priorityStopId: 'stop-003' })
      )
      .mockResolvedValueOnce(geminiText('Route optimized.'));

    const res = await request(app)
      .post('/api/ai/command')
      .set('Authorization', riderAuthHeader({ riderId: 'rider-1' }))
      .send({ text: 'prioritize stop-003' });

    expect(res.status).toBe(200);
    expect(res.body.action.newOrder).toEqual(['stop-003', 'stop-001', 'stop-002']);

    // Sequences continue after the completed offset (2): 3, 4, 5.
    const calls = (prismaMock.stop.updateMany as jest.Mock).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0][0]).toEqual({ where: { stopId: 'stop-003' }, data: { sequence: 3 } });
    expect(calls[1][0]).toEqual({ where: { stopId: 'stop-001' }, data: { sequence: 4 } });
    expect(calls[2][0]).toEqual({ where: { stopId: 'stop-002' }, data: { sequence: 5 } });
  });

  it('200 resolves priorityRecipientName → stopId via insensitive contains match', async () => {
    (prismaMock.manifest.findFirst as jest.Mock).mockResolvedValue(makeManifest());

    (prismaMock.stop.findMany as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeStop({ id: 's1', stopId: 'stop-001', sequence: 1 }),
        makeStop({ id: 's2', stopId: 'stop-resolved', sequence: 2 }),
      ]);

    (prismaMock.stop.findFirst as jest.Mock).mockResolvedValue(
      makeStop({ stopId: 'stop-resolved' })
    );
    (prismaMock.stop.count as jest.Mock).mockResolvedValue(0);
    (prismaMock.stop.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

    generateContentMock
      .mockResolvedValueOnce(
        geminiFunctionCall('optimize_route', { priorityRecipientName: 'maria' })
      )
      .mockResolvedValueOnce(geminiText('Done.'));

    const res = await request(app)
      .post('/api/ai/command')
      .set('Authorization', riderAuthHeader())
      .send({ text: 'do maria first' });

    expect(res.status).toBe(200);
    expect(res.body.action.newOrder).toEqual(['stop-resolved', 'stop-001']);

    const findFirstArgs = (prismaMock.stop.findFirst as jest.Mock).mock.calls[0][0];
    expect(findFirstArgs.where.order.recipientName).toEqual({
      contains: 'maria',
      mode: 'insensitive',
    });
  });

  it('200 with no pending stops → returns the no-op message and never writes', async () => {
    (prismaMock.manifest.findFirst as jest.Mock).mockResolvedValue(makeManifest());
    (prismaMock.stop.findMany as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    generateContentMock
      .mockResolvedValueOnce(geminiFunctionCall('optimize_route', {}))
      .mockResolvedValueOnce(geminiText('Nothing to do.'));

    const res = await request(app)
      .post('/api/ai/command')
      .set('Authorization', riderAuthHeader())
      .send({ text: 'optimize' });

    expect(res.body.action).toEqual({
      message: 'No pending stops to optimize',
      newOrder: [],
    });
    expect((prismaMock.stop.updateMany as jest.Mock)).not.toHaveBeenCalled();
  });
});

// ─── Unknown tool name guard ──────────────────────────────────────────────

describe('POST /api/ai/command — unknown tool guard', () => {
  it('200 wraps the unknown function name in an action error rather than throwing', async () => {
    (prismaMock.manifest.findFirst as jest.Mock).mockResolvedValue(null);
    (prismaMock.stop.findMany as jest.Mock).mockResolvedValue([]);

    generateContentMock
      .mockResolvedValueOnce(geminiFunctionCall('teleport_rider', { dest: 'beach' }))
      .mockResolvedValueOnce(geminiText('Sorry, I cannot do that.'));

    const res = await request(app)
      .post('/api/ai/command')
      .set('Authorization', riderAuthHeader())
      .send({ text: 'beam me up' });

    expect(res.status).toBe(200);
    expect(res.body.intent).toBe('teleport_rider');
    expect(res.body.action).toEqual({ error: 'Unknown function: teleport_rider' });
  });
});
