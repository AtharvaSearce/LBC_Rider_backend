import '../../../src/types/express';
import request from 'supertest';
import { StopStatus } from '@prisma/client';
import { prismaMock } from '../../helpers/prismaMock';
import { buildApp } from '../../helpers/app';
import { riderAuthHeader } from '../../helpers/auth';
import { authMiddleware } from '../../../src/middleware/rider-auth';
import routeRouter from '../../../src/routes/route';
import { makeManifest, makeStop } from '../../helpers/fixtures';

const app = buildApp({
  mountPath: '/api/route',
  router: routeRouter,
  preMiddleware: [authMiddleware],
});

beforeEach(() => {
  (prismaMock.$transaction as unknown as jest.Mock).mockImplementation(
    async (cb: (tx: typeof prismaMock) => unknown) => cb(prismaMock)
  );
});

const ORIGINAL_FETCH = global.fetch;
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

function makeStopWithOrder(
  overrides: Partial<{
    id: string;
    stopId: string;
    sequence: number;
    status: StopStatus;
    attemptCount: number;
    maxAttempts: number;
    addressLat: number;
    addressLng: number;
  }> = {}
) {
  return {
    ...makeStop({
      id: overrides.id ?? 'db-1',
      stopId: overrides.stopId ?? 'stop-aaaa',
      sequence: overrides.sequence ?? 1,
      status: overrides.status ?? StopStatus.pending,
      attemptCount: overrides.attemptCount ?? 0,
      maxAttempts: overrides.maxAttempts ?? 3,
    }),
    order: {
      addressLat: overrides.addressLat ?? 14.5547,
      addressLng: overrides.addressLng ?? 121.0244,
    },
  };
}

// ─── POST /optimize ───────────────────────────────────────────────────────

describe('POST /api/route/optimize', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).post('/api/route/optimize').send({});
    expect(res.status).toBe(401);
  });

  it('500 when GOOGLE_MAPS_API_KEY is unset', async () => {
    const original = process.env.GOOGLE_MAPS_API_KEY;
    delete process.env.GOOGLE_MAPS_API_KEY;

    const res = await request(app)
      .post('/api/route/optimize')
      .set('Authorization', riderAuthHeader())
      .send({ manifestId: 'm-1' });

    process.env.GOOGLE_MAPS_API_KEY = original;
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'GCP configuration missing' });
  });

  it('500 when GCP_PROJECT_ID is unset', async () => {
    const original = process.env.GCP_PROJECT_ID;
    delete process.env.GCP_PROJECT_ID;

    const res = await request(app)
      .post('/api/route/optimize')
      .set('Authorization', riderAuthHeader())
      .send({ manifestId: 'm-1' });

    process.env.GCP_PROJECT_ID = original;
    expect(res.status).toBe(500);
  });

  it('404 when the manifest cannot be found', async () => {
    prismaMock.manifest.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/route/optimize')
      .set('Authorization', riderAuthHeader())
      .send({ manifestId: 'm-missing' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Manifest not found' });
  });

  it('200 short-circuits when there are no pending or retry-eligible failed stops', async () => {
    prismaMock.manifest.findFirst.mockResolvedValue(makeManifest({ id: 'm-1' }) as never);
    prismaMock.stop.findMany.mockResolvedValue([] as never); // primary stops
    prismaMock.stop.findMany.mockResolvedValueOnce([] as never).mockResolvedValueOnce([] as never);

    const res = await request(app)
      .post('/api/route/optimize')
      .set('Authorization', riderAuthHeader())
      .send({ manifestId: 'm-1' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ newOrder: [], message: 'No pending stops to optimize' });
    // Fleet Routing should not have been called
  });

  it('200 optimizes by geography (nearest-neighbour) and renumbers the manifest 1..N', async () => {
    prismaMock.manifest.findFirst.mockResolvedValue(makeManifest({ id: 'm-1' }) as never);

    // From origin (0,0): nearest is bbbb (0,1), then cccc (0,2), then aaaa (0,3)
    const stops = [
      makeStopWithOrder({ id: 'db-1', stopId: 'stop-aaaa', addressLat: 0, addressLng: 3 }),
      makeStopWithOrder({ id: 'db-2', stopId: 'stop-bbbb', addressLat: 0, addressLng: 1 }),
      makeStopWithOrder({ id: 'db-3', stopId: 'stop-cccc', addressLat: 0, addressLng: 2 }),
    ];
    prismaMock.stop.findMany
      .mockResolvedValueOnce(stops as never) // primary stops
      .mockResolvedValueOnce([] as never) // failed stops
      .mockResolvedValueOnce(stops as never); // resequence: all stops

    const res = await request(app)
      .post('/api/route/optimize')
      .set('Authorization', riderAuthHeader())
      .send({ manifestId: 'm-1', origin: { lat: 0, lng: 0 } });

    expect(res.status).toBe(200);
    expect(res.body.newOrder).toEqual(['stop-bbbb', 'stop-cccc', 'stop-aaaa']);
    expect(res.body.firstStopId).toBe('stop-bbbb');
    expect(res.body.message).toBe('Route optimized for shortest path');

    // No terminal stops -> contiguous 1,2,3; first stop in_progress, rest pending
    expect(prismaMock.stop.update).toHaveBeenCalledWith({
      where: { id: 'db-2' },
      data: { sequence: 1, status: StopStatus.in_progress },
    });
    expect(prismaMock.stop.update).toHaveBeenCalledWith({
      where: { id: 'db-3' },
      data: { sequence: 2, status: StopStatus.pending },
    });
    expect(prismaMock.stop.update).toHaveBeenCalledWith({
      where: { id: 'db-1' },
      data: { sequence: 3, status: StopStatus.pending },
    });
  });

  it('200 keeps completed stops up front and renumbers active stops after them', async () => {
    prismaMock.manifest.findFirst.mockResolvedValue(makeManifest({ id: 'm-1' }) as never);

    // A completed stop holds an arbitrary high sequence (4) — the previous
    // terminalCount-based numbering would have collided here.
    const done = makeStopWithOrder({
      id: 'db-done',
      stopId: 'stop-done',
      sequence: 4,
      status: StopStatus.completed,
    });
    const active = [
      makeStopWithOrder({ id: 'db-1', stopId: 'stop-aaaa', sequence: 1, addressLat: 0, addressLng: 3 }),
      makeStopWithOrder({ id: 'db-2', stopId: 'stop-bbbb', sequence: 2, addressLat: 0, addressLng: 1 }),
    ];
    prismaMock.stop.findMany
      .mockResolvedValueOnce(active as never) // primary stops
      .mockResolvedValueOnce([] as never) // failed stops
      .mockResolvedValueOnce([done, ...active] as never); // resequence: all stops

    const res = await request(app)
      .post('/api/route/optimize')
      .set('Authorization', riderAuthHeader())
      .send({ manifestId: 'm-1', origin: { lat: 0, lng: 0 } });

    expect(res.status).toBe(200);
    expect(res.body.newOrder).toEqual(['stop-bbbb', 'stop-aaaa']);

    // Completed stop is renumbered to 1 with its status untouched
    expect(prismaMock.stop.update).toHaveBeenCalledWith({
      where: { id: 'db-done' },
      data: { sequence: 1 },
    });
    // Active stops follow: bbbb (closest) becomes in_progress at 2
    expect(prismaMock.stop.update).toHaveBeenCalledWith({
      where: { id: 'db-2' },
      data: { sequence: 2, status: StopStatus.in_progress },
    });
    expect(prismaMock.stop.update).toHaveBeenCalledWith({
      where: { id: 'db-1' },
      data: { sequence: 3, status: StopStatus.pending },
    });
  });

  it('200 places priorityStopId first and promotes it to in_progress', async () => {
    prismaMock.manifest.findFirst.mockResolvedValue(makeManifest({ id: 'm-1' }) as never);

    const stops = [
      makeStopWithOrder({ id: 'db-1', stopId: 'stop-aaaa', addressLat: 0, addressLng: 3 }),
      makeStopWithOrder({ id: 'db-2', stopId: 'stop-bbbb', addressLat: 0, addressLng: 1 }),
      makeStopWithOrder({ id: 'db-3', stopId: 'stop-cccc', addressLat: 0, addressLng: 2 }),
    ];
    prismaMock.stop.findMany
      .mockResolvedValueOnce(stops as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce(stops as never);

    const res = await request(app)
      .post('/api/route/optimize')
      .set('Authorization', riderAuthHeader())
      .send({ manifestId: 'm-1', priorityStopId: 'stop-cccc', origin: { lat: 0, lng: 0 } });

    expect(res.status).toBe(200);
    expect(res.body.newOrder[0]).toBe('stop-cccc');
    expect(res.body.firstStopId).toBe('stop-cccc');
    expect(res.body.newOrder).toHaveLength(3);
    expect(res.body.message).toContain('stop-cccc');

    // Priority stop is promoted to in_progress at sequence 1
    expect(prismaMock.stop.update).toHaveBeenCalledWith({
      where: { id: 'db-3' },
      data: { sequence: 1, status: StopStatus.in_progress },
    });
  });

  it('200 falls back to the in_progress stop as origin when none is supplied', async () => {
    prismaMock.manifest.findFirst.mockResolvedValue(makeManifest({ id: 'm-1' }) as never);
    const stops = [
      makeStopWithOrder({ id: 'db-1', stopId: 'stop-aaaa', addressLat: 0, addressLng: 1, status: StopStatus.in_progress }),
      makeStopWithOrder({ id: 'db-2', stopId: 'stop-bbbb', addressLat: 0, addressLng: 2 }),
    ];
    prismaMock.stop.findMany
      .mockResolvedValueOnce(stops as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce(stops as never);

    const res = await request(app)
      .post('/api/route/optimize')
      .set('Authorization', riderAuthHeader())
      .send({ manifestId: 'm-1' });

    expect(res.status).toBe(200);
    expect(res.body.newOrder).toEqual(['stop-aaaa', 'stop-bbbb']);
  });

  it('200 includes failed stops with retry budget remaining', async () => {
    prismaMock.manifest.findFirst.mockResolvedValue(makeManifest({ id: 'm-1' }) as never);
    const aaaa = makeStopWithOrder({ id: 'db-1', stopId: 'stop-aaaa' });
    const bbbb = makeStopWithOrder({
      id: 'db-2',
      stopId: 'stop-bbbb',
      status: StopStatus.failed,
      attemptCount: 1,
      maxAttempts: 3,
    });
    const cccc = makeStopWithOrder({
      id: 'db-3',
      stopId: 'stop-cccc',
      status: StopStatus.failed,
      attemptCount: 3,
      maxAttempts: 3,
    });
    prismaMock.stop.findMany
      .mockResolvedValueOnce([aaaa] as never) // primary stops
      .mockResolvedValueOnce([bbbb, cccc] as never) // failed stops
      .mockResolvedValueOnce([aaaa, bbbb, cccc] as never); // resequence: all stops

    const res = await request(app)
      .post('/api/route/optimize')
      .set('Authorization', riderAuthHeader())
      .send({ manifestId: 'm-1' });

    expect(res.status).toBe(200);
    expect(res.body.newOrder).toEqual(['stop-aaaa', 'stop-bbbb']);
    expect(res.body.newOrder).not.toContain('stop-cccc');
    // Attempt-exhausted failed stop is renumbered last but keeps failed status
    expect(prismaMock.stop.update).toHaveBeenCalledWith({
      where: { id: 'db-3' },
      data: { sequence: 3 },
    });
  });
});

// ─── POST /compute ────────────────────────────────────────────────────────

describe('POST /api/route/compute', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).post('/api/route/compute').send({});
    expect(res.status).toBe(401);
  });

  it('500 when GOOGLE_MAPS_API_KEY is unset', async () => {
    const original = process.env.GOOGLE_MAPS_API_KEY;
    delete process.env.GOOGLE_MAPS_API_KEY;

    const res = await request(app)
      .post('/api/route/compute')
      .set('Authorization', riderAuthHeader())
      .send({});

    process.env.GOOGLE_MAPS_API_KEY = original;
    expect(res.status).toBe(500);
  });

  it('400 when origin or destination lat/lng is missing', async () => {
    const res = await request(app)
      .post('/api/route/compute')
      .set('Authorization', riderAuthHeader())
      .send({ origin: { lat: 14.5 }, destination: { lat: 14.6, lng: 121 } });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Origin and destination with lat/lng are required',
    });
  });

  it('200 happy path returns parsed eta and km from the Routes API response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({
        routes: [
          {
            duration: '2700s',
            distanceMeters: 12500,
            polyline: { encodedPolyline: 'abc123' },
          },
        ],
      }),
    }) as unknown as typeof global.fetch;

    const res = await request(app)
      .post('/api/route/compute')
      .set('Authorization', riderAuthHeader())
      .send({
        origin: { lat: 14.5547, lng: 121.0244 },
        destination: { lat: 14.676, lng: 121.0437 },
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      encodedPolyline: 'abc123',
      durationSeconds: 2700,
      distanceMeters: 12500,
      distanceKm: '12.5',
      eta: '45 min',
    });
  });

  it('200 formats eta in hours+minutes when duration ≥ 60 min', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({
        routes: [
          {
            duration: '5400s', // 90 minutes
            distanceMeters: 80000,
            polyline: { encodedPolyline: 'p' },
          },
        ],
      }),
    }) as unknown as typeof global.fetch;

    const res = await request(app)
      .post('/api/route/compute')
      .set('Authorization', riderAuthHeader())
      .send({
        origin: { lat: 14.5, lng: 121.0 },
        destination: { lat: 14.6, lng: 121.1 },
      });

    expect(res.status).toBe(200);
    expect(res.body.eta).toBe('1h 30m');
    expect(res.body.distanceKm).toBe('80.0');
  });

  it('404 when the Routes API returns no routes', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({ routes: [] }),
    }) as unknown as typeof global.fetch;

    const res = await request(app)
      .post('/api/route/compute')
      .set('Authorization', riderAuthHeader())
      .send({
        origin: { lat: 14.5, lng: 121 },
        destination: { lat: 14.6, lng: 121.1 },
      });

    expect(res.status).toBe(404);
  });
});

// ─── POST /directions ─────────────────────────────────────────────────────

describe('POST /api/route/directions', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).post('/api/route/directions').send({});
    expect(res.status).toBe(401);
  });

  it('500 when GOOGLE_MAPS_API_KEY is unset', async () => {
    const original = process.env.GOOGLE_MAPS_API_KEY;
    delete process.env.GOOGLE_MAPS_API_KEY;

    const res = await request(app)
      .post('/api/route/directions')
      .set('Authorization', riderAuthHeader())
      .send({ origin: { lat: 14, lng: 121 }, destination: { lat: 15, lng: 122 } });

    process.env.GOOGLE_MAPS_API_KEY = original;
    expect(res.status).toBe(500);
  });

  it('200 forwards the Routes API payload verbatim and includes intermediates when waypoints are supplied', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      json: async () => ({ routes: [{ duration: '900s', distanceMeters: 5000, legs: [] }] }),
    });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const res = await request(app)
      .post('/api/route/directions')
      .set('Authorization', riderAuthHeader())
      .send({
        origin: { lat: 14, lng: 121 },
        destination: { lat: 15, lng: 122 },
        waypoints: [{ lat: 14.5, lng: 121.5 }],
      });

    expect(res.status).toBe(200);
    expect(res.body.routes[0].duration).toBe('900s');

    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sentBody.intermediates).toEqual([
      { location: { latLng: { latitude: 14.5, longitude: 121.5 } } },
    ]);
  });
});

// ─── POST /reorder ────────────────────────────────────────────────────────

describe('POST /api/route/reorder', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).post('/api/route/reorder').send({});
    expect(res.status).toBe(401);
  });

  it('400 when manifestId is missing', async () => {
    const res = await request(app)
      .post('/api/route/reorder')
      .set('Authorization', riderAuthHeader())
      .send({ stopOrder: ['stop-a'] });

    expect(res.status).toBe(400);
  });

  it('400 when stopOrder is not a non-empty array', async () => {
    const res = await request(app)
      .post('/api/route/reorder')
      .set('Authorization', riderAuthHeader())
      .send({ manifestId: 'm-1', stopOrder: [] });

    expect(res.status).toBe(400);
  });

  it('404 when the manifest does not exist', async () => {
    prismaMock.manifest.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/route/reorder')
      .set('Authorization', riderAuthHeader())
      .send({ manifestId: 'm-missing', stopOrder: ['stop-a'] });

    expect(res.status).toBe(404);
  });

  it('200 promotes the first stop in the new order to in_progress and renumbers sequences', async () => {
    prismaMock.manifest.findFirst.mockResolvedValue(makeManifest({ id: 'm-1' }) as never);
    prismaMock.stop.findMany.mockResolvedValue([
      { id: 'db-1', stopId: 'stop-aaaa', status: StopStatus.pending },
      { id: 'db-2', stopId: 'stop-bbbb', status: StopStatus.pending },
      { id: 'db-3', stopId: 'stop-cccc', status: StopStatus.pending },
    ] as never);

    const res = await request(app)
      .post('/api/route/reorder')
      .set('Authorization', riderAuthHeader())
      .send({
        manifestId: 'm-1',
        stopOrder: ['stop-bbbb', 'stop-aaaa', 'stop-cccc'],
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      message: 'Stop order updated successfully',
      stopOrder: ['stop-bbbb', 'stop-aaaa', 'stop-cccc'],
    });

    // First update by user-supplied order: bbbb gets seq=1 + in_progress
    expect(prismaMock.stop.update).toHaveBeenCalledWith({
      where: { id: 'db-2' },
      data: { sequence: 1, status: StopStatus.in_progress },
    });
    // Second: aaaa gets seq=2 + reset to pending
    expect(prismaMock.stop.update).toHaveBeenCalledWith({
      where: { id: 'db-1' },
      data: { sequence: 2, status: StopStatus.pending },
    });
    // Third: cccc gets seq=3 + reset to pending
    expect(prismaMock.stop.update).toHaveBeenCalledWith({
      where: { id: 'db-3' },
      data: { sequence: 3, status: StopStatus.pending },
    });
  });
});
