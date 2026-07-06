import '../../../src/types/express';
import request from 'supertest';
import { Prisma, StopStatus } from '@prisma/client';

const generateContentMock = jest.fn();
const optimizeManifestRouteMock = jest.fn();

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

jest.mock('../../../src/services/route-optimization', () => ({
  ...jest.requireActual('../../../src/services/route-optimization'),
  optimizeManifestRoute: (...args: unknown[]) =>
    optimizeManifestRouteMock(...args),
}));

import { prismaMock } from '../../helpers/prismaMock';
import { buildApp } from '../../helpers/app';
import { riderAuthHeader } from '../../helpers/auth';
import { authMiddleware } from '../../../src/middleware/rider-auth';
import aiRouter, { resetGeminiModelCache } from '../../../src/routes/ai';
import { makeManifest, makeRiderWithHub, makeStop } from '../../helpers/fixtures';

const app = buildApp({
  mountPath: '/api/ai',
  router: aiRouter,
  preMiddleware: [authMiddleware],
});

function mockRiderContext(manifest = makeManifest(), stops: ReturnType<typeof makeStop>[] = []) {
  (prismaMock.rider.findUnique as unknown as jest.Mock).mockResolvedValue(makeRiderWithHub());
  (prismaMock.manifest.findFirst as unknown as jest.Mock).mockResolvedValue(manifest);
  (prismaMock.stop.findMany as unknown as jest.Mock).mockResolvedValue(
    stops.map((s) => ({
      ...s,
      order: {
        recipientName: 'Maria Santos',
        addressText: '123 Ayala Ave',
        trackingNumber: 'TRK0001',
        codAmount: new Prisma.Decimal(0),
        specialInstructions: '',
      },
    }))
  );
}

beforeEach(() => {
  generateContentMock.mockReset();
  optimizeManifestRouteMock.mockReset();
  resetGeminiModelCache();
  process.env.GEMINI_API_KEY = 'test-gemini-key';
});

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
    resetGeminiModelCache();

    const res = await request(app)
      .post('/api/ai/command')
      .set('Authorization', riderAuthHeader())
      .send({ text: 'optimize my route' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'AI processing failed' });
  });
});

describe('POST /api/ai/command — conversational response', () => {
  it('returns CONVERSATIONAL intent when Gemini returns plain text (no tool call)', async () => {
    mockRiderContext(null as unknown as ReturnType<typeof makeManifest>, []);
    (prismaMock.manifest.findFirst as unknown as jest.Mock).mockResolvedValue(null);
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
    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to a default message when Gemini returns no parts', async () => {
    mockRiderContext(null as unknown as ReturnType<typeof makeManifest>, []);
    (prismaMock.manifest.findFirst as unknown as jest.Mock).mockResolvedValue(null);
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

describe('POST /api/ai/command — filter_deliveries tool', () => {
  it('200 returns flat NAVIGATE action with filters and follow-up message', async () => {
    mockRiderContext();

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
      type: 'NAVIGATE',
      tab: 'deliveries',
      requiresConfirmation: true,
      confirmLabel: 'Open in app',
      filters: { date: 'yesterday', status: 'failed' },
    });
    expect(res.body.data).toEqual({
      navigated: 'deliveries',
      filters: { date: 'yesterday', status: 'failed' },
      stopId: null,
    });
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it('200 fills filter defaults to today/all when Gemini omits args', async () => {
    mockRiderContext();

    generateContentMock
      .mockResolvedValueOnce(geminiFunctionCall('filter_deliveries', {}))
      .mockResolvedValueOnce(geminiText('Showing today.'));

    const res = await request(app)
      .post('/api/ai/command')
      .set('Authorization', riderAuthHeader())
      .send({ text: 'show deliveries' });

    expect(res.body.action.filters).toEqual({ date: 'today', status: 'all' });
  });
});

describe('POST /api/ai/command — query_status tool', () => {
  it('200 returns the requested metric (cod_total) computed from stops', async () => {
    mockRiderContext(makeManifest(), [makeStop()]);

    (prismaMock.stop.findMany as unknown as jest.Mock)
      .mockResolvedValueOnce([
        {
          ...makeStop(),
          order: {
            recipientName: 'Maria',
            addressText: '123 Ayala',
            trackingNumber: 'TRK0001',
            codAmount: new Prisma.Decimal(0),
            specialInstructions: '',
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          ...makeStop({ status: StopStatus.completed }),
          order: { recipientName: 'Maria', trackingNumber: 'TRK0001' },
          deliveryResult: { codCollected: new Prisma.Decimal(500) },
        },
        {
          ...makeStop({ id: 'stop-2', status: StopStatus.completed }),
          order: { recipientName: 'Pedro', trackingNumber: 'TRK0002' },
          deliveryResult: { codCollected: new Prisma.Decimal(750) },
        },
        {
          ...makeStop({ id: 'stop-3', status: StopStatus.failed }),
          order: { recipientName: 'Ana', trackingNumber: 'TRK0003' },
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
    expect(res.body.data).toEqual({ metric: 'cod_total', data: 1250 });
    expect(res.body.action).toBeNull();
  });

  it('200 returns the summary metric with totals/remaining/completed/failed', async () => {
    mockRiderContext(makeManifest(), []);

    (prismaMock.stop.findMany as unknown as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          ...makeStop({ status: StopStatus.pending }),
          order: { recipientName: 'A', trackingNumber: 'T1' },
          deliveryResult: null,
        },
        {
          ...makeStop({ id: 's2', status: StopStatus.in_progress }),
          order: { recipientName: 'B', trackingNumber: 'T2' },
          deliveryResult: null,
        },
        {
          ...makeStop({ id: 's3', status: StopStatus.completed }),
          order: { recipientName: 'C', trackingNumber: 'T3' },
          deliveryResult: null,
        },
        {
          ...makeStop({ id: 's4', status: StopStatus.failed }),
          order: { recipientName: 'D', trackingNumber: 'T4' },
          deliveryResult: null,
        },
        {
          ...makeStop({ id: 's5', status: StopStatus.rts }),
          order: { recipientName: 'E', trackingNumber: 'T5' },
          deliveryResult: null,
        },
      ]);

    generateContentMock
      .mockResolvedValueOnce(geminiFunctionCall('query_status', { metric: 'summary' }))
      .mockResolvedValueOnce(geminiText('Here is your summary.'));

    const res = await request(app)
      .post('/api/ai/command')
      .set('Authorization', riderAuthHeader())
      .send({ text: 'summary please' });

    expect(res.body.data.data).toEqual({
      total: 5,
      remaining: 2,
      completed: 1,
      failed: 2,
      codTotal: 0,
    });
  });

  it('200 with no manifest → data contains the no-manifest error', async () => {
    (prismaMock.rider.findUnique as unknown as jest.Mock).mockResolvedValue(makeRiderWithHub());
    (prismaMock.manifest.findFirst as unknown as jest.Mock).mockResolvedValue(null);
    (prismaMock.stop.findMany as unknown as jest.Mock).mockResolvedValue([]);

    generateContentMock
      .mockResolvedValueOnce(geminiFunctionCall('query_status', { metric: 'remaining' }))
      .mockResolvedValueOnce(geminiText('No manifest active.'));

    const res = await request(app)
      .post('/api/ai/command')
      .set('Authorization', riderAuthHeader())
      .send({ text: 'how many left?' });

    expect(res.body.data).toEqual({ error: 'No manifest found' });
  });
});

describe('POST /api/ai/command — optimize_route tool', () => {
  it('200 calls geo optimizer and returns REFRESH_MANIFEST action', async () => {
    mockRiderContext();

    optimizeManifestRouteMock.mockResolvedValue({
      newOrder: ['stop-003', 'stop-001', 'stop-002'],
      firstStopId: 'stop-003',
      message: 'Route optimized with stop-003 prioritized first',
    });

    generateContentMock
      .mockResolvedValueOnce(
        geminiFunctionCall('optimize_route', { priorityStopId: 'stop-003' })
      )
      .mockResolvedValueOnce(geminiText('Route optimized.'));

    const res = await request(app)
      .post('/api/ai/command')
      .set('Authorization', riderAuthHeader({ riderId: 'rider-1' }))
      .send({
        text: 'prioritize stop-003',
        origin: { lat: 14.55, lng: 121.02 },
      });

    expect(res.status).toBe(200);
    expect(res.body.data.newOrder).toEqual(['stop-003', 'stop-001', 'stop-002']);
    expect(res.body.action).toEqual({ type: 'REFRESH_MANIFEST' });
    expect(optimizeManifestRouteMock).toHaveBeenCalledWith('manifest-1', {
      priorityStopId: 'stop-003',
      origin: { lat: 14.55, lng: 121.02 },
    });
  });

  it('200 resolves priorityRecipientName via DB lookup before optimizing', async () => {
    mockRiderContext();

    (prismaMock.stop.findFirst as unknown as jest.Mock).mockResolvedValue(
      makeStop({ stopId: 'stop-resolved' })
    );
    optimizeManifestRouteMock.mockResolvedValue({
      newOrder: ['stop-resolved', 'stop-001'],
      firstStopId: 'stop-resolved',
      message: 'Route optimized with stop-resolved prioritized first',
    });

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
    expect(optimizeManifestRouteMock).toHaveBeenCalledWith(
      'manifest-1',
      expect.objectContaining({ priorityStopId: 'stop-resolved' })
    );
  });

  it('200 with no pending stops → returns the no-op message', async () => {
    mockRiderContext();

    optimizeManifestRouteMock.mockResolvedValue({
      newOrder: [],
      message: 'No pending stops to optimize',
    });

    generateContentMock
      .mockResolvedValueOnce(geminiFunctionCall('optimize_route', {}))
      .mockResolvedValueOnce(geminiText('Nothing to do.'));

    const res = await request(app)
      .post('/api/ai/command')
      .set('Authorization', riderAuthHeader())
      .send({ text: 'optimize' });

    expect(res.body.data).toEqual({
      newOrder: [],
      message: 'No pending stops to optimize',
    });
  });
});

describe('POST /api/ai/command — find_stop tool', () => {
  it('200 returns matching stops', async () => {
    mockRiderContext();

    (prismaMock.stop.findMany as unknown as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          ...makeStop({ stopId: 'stop-maria' }),
          order: {
            recipientName: 'Maria Santos',
            trackingNumber: 'TRK0001',
            addressText: '123 Ayala',
            codAmount: new Prisma.Decimal(100),
            recipientPhone: '+639170000010',
          },
        },
      ]);

    generateContentMock
      .mockResolvedValueOnce(geminiFunctionCall('find_stop', { query: 'maria' }))
      .mockResolvedValueOnce(geminiText('Found Maria at stop-maria.'));

    const res = await request(app)
      .post('/api/ai/command')
      .set('Authorization', riderAuthHeader())
      .send({ text: 'find maria' });

    expect(res.status).toBe(200);
    expect(res.body.intent).toBe('find_stop');
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.stops[0].stopId).toBe('stop-maria');
  });
});

describe('POST /api/ai/command — unknown tool guard', () => {
  it('200 wraps the unknown function name in data error rather than throwing', async () => {
    mockRiderContext();

    generateContentMock
      .mockResolvedValueOnce(geminiFunctionCall('teleport_rider', { dest: 'beach' }))
      .mockResolvedValueOnce(geminiText('Sorry, I cannot do that.'));

    const res = await request(app)
      .post('/api/ai/command')
      .set('Authorization', riderAuthHeader())
      .send({ text: 'beam me up' });

    expect(res.status).toBe(200);
    expect(res.body.intent).toBe('teleport_rider');
    expect(res.body.data).toEqual({ error: 'Unknown function: teleport_rider' });
    expect(res.body.action).toBeNull();
  });
});

describe('POST /api/ai/command — prompt structure', () => {
  it('sends XML-structured context to Gemini', async () => {
    mockRiderContext(makeManifest(), [
      makeStop({ stopId: 'stop-001', sequence: 1, status: StopStatus.in_progress }),
    ]);

    generateContentMock.mockResolvedValueOnce(geminiText('OK'));

    await request(app)
      .post('/api/ai/command')
      .set('Authorization', riderAuthHeader())
      .send({ text: 'status?' });

    const prompt = generateContentMock.mock.calls[0][0] as string;
    expect(prompt).toContain('<role>');
    expect(prompt).toContain('<limitations>');
    expect(prompt).toContain('<user_command>');
    expect(prompt).toContain('status?');
    expect(prompt).toContain('stop-001');
  });

  it('includes conversation history in the prompt', async () => {
    mockRiderContext(makeManifest(), [
      makeStop({ stopId: 'stop-001', sequence: 1, status: StopStatus.in_progress }),
    ]);

    generateContentMock.mockResolvedValueOnce(
      geminiFunctionCall('query_manifest_history', { date: 'this_week' })
    );
    generateContentMock.mockResolvedValueOnce(geminiText('Here is this week.'));

    await request(app)
      .post('/api/ai/command')
      .set('Authorization', riderAuthHeader())
      .send({
        text: 'This week',
        history: [
          { role: 'user', content: 'details of manifest completed yesterday' },
          {
            role: 'assistant',
            content:
              'I can only look up manifests from today, yesterday, or this week. Which would you like to see?',
          },
        ],
      });

    const prompt = generateContentMock.mock.calls[0][0] as string;
    expect(prompt).toContain('<conversation_history>');
    expect(prompt).toContain('Which would you like to see?');
    expect(prompt).toContain('<user_command>\nThis week');
  });
});
