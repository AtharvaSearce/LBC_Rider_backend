import '../../../src/types/express';
import request from 'supertest';
import { ManifestStatus, OrderStatus, StopStatus } from '@prisma/client';
import { prismaMock } from '../../helpers/prismaMock';
import { buildApp } from '../../helpers/app';
import { riderAuthHeader } from '../../helpers/auth';
import { authMiddleware } from '../../../src/middleware/rider-auth';
import manifestRouter from '../../../src/routes/manifest';
import {
  makeManifest,
  makeOrderWithHub,
  makeStop,
} from '../../helpers/fixtures';

const app = buildApp({
  mountPath: '/api/manifest',
  router: manifestRouter,
  preMiddleware: [authMiddleware],
});

// Wire prisma.$transaction(callback) → callback(prismaMock) so all tx.* calls
// land on the same deep mock proxy. Re-applied in beforeEach because resetMock
// clears the implementation.
beforeEach(() => {
  (prismaMock.$transaction as unknown as jest.Mock).mockImplementation(
    async (cb: (tx: typeof prismaMock) => unknown) => cb(prismaMock)
  );
});

const ORIGINAL_FETCH = global.fetch;
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

// ─── POST /cleanup ────────────────────────────────────────────────────────

describe('POST /api/manifest/cleanup', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).post('/api/manifest/cleanup').send({});
    expect(res.status).toBe(401);
  });

  it('200 cleaned=0 when there are no stale manifests', async () => {
    prismaMock.manifest.findMany.mockResolvedValue([] as never);

    const res = await request(app)
      .post('/api/manifest/cleanup')
      .set('Authorization', riderAuthHeader());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cleaned: 0 });
    expect(prismaMock.stop.update).not.toHaveBeenCalled();
    expect(prismaMock.manifest.update).not.toHaveBeenCalled();
  });

  it('200 marks stale manifest completed, releases pending order, leaves completed stop alone', async () => {
    const stale = makeManifest({
      id: 'm-old',
      manifestId: 'DDR-OLD',
      riderId: 'rider-1',
      date: new Date('2025-01-01'),
      status: ManifestStatus.in_progress,
      totalStops: 2,
    });
    const pendingStop = makeStop({
      id: 's-pending',
      manifestId: 'm-old',
      orderId: 'o-pending',
      status: StopStatus.pending,
    });
    const completedStop = makeStop({
      id: 's-done',
      manifestId: 'm-old',
      orderId: 'o-done',
      status: StopStatus.completed,
    });

    prismaMock.manifest.findMany.mockResolvedValue([stale] as never);
    // First call: list of all stops in the stale manifest
    // Second call: post-update list with `select: { status }` for counter sync
    prismaMock.stop.findMany
      .mockResolvedValueOnce([pendingStop, completedStop] as never)
      .mockResolvedValueOnce([
        { status: StopStatus.reschedule },
        { status: StopStatus.completed },
      ] as never);

    const res = await request(app)
      .post('/api/manifest/cleanup')
      .set('Authorization', riderAuthHeader());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cleaned: 1 });

    // Pending stop was flipped to reschedule (completed stop was skipped)
    expect(prismaMock.stop.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.stop.update).toHaveBeenCalledWith({
      where: { id: 's-pending' },
      data: { status: StopStatus.reschedule },
    });

    // Order is only released if still attached to this exact manifest
    expect(prismaMock.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'o-pending', assignedManifestId: 'm-old' },
      data: { status: OrderStatus.available, assignedManifestId: null },
    });

    // Manifest counters synced + status closed
    expect(prismaMock.manifest.update).toHaveBeenCalledWith({
      where: { id: 'm-old' },
      data: {
        status: ManifestStatus.completed,
        failedStops: 1,
      },
    });
  });
});

// ─── GET /history ─────────────────────────────────────────────────────────

describe('GET /api/manifest/history', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).get('/api/manifest/history');
    expect(res.status).toBe(401);
  });

  it('200 returns the rider`s manifests ordered by date desc', async () => {
    const manifests = [
      makeManifest({ id: 'm-1', date: new Date('2026-06-03') }),
      makeManifest({ id: 'm-2', date: new Date('2026-06-02') }),
    ];
    prismaMock.manifest.findMany.mockResolvedValue(manifests as never);

    const res = await request(app)
      .get('/api/manifest/history')
      .set('Authorization', riderAuthHeader({ riderId: 'rider-7' }));

    expect(res.status).toBe(200);
    expect(res.body.manifests).toHaveLength(2);
    expect(prismaMock.manifest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { riderId: 'rider-7' },
        orderBy: { date: 'desc' },
      })
    );
  });
});

// ─── GET /available-orders ────────────────────────────────────────────────

describe('GET /api/manifest/available-orders', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).get('/api/manifest/available-orders');
    expect(res.status).toBe(401);
  });

  it('200 lists hub-scoped available orders with no search filter', async () => {
    const orders = [
      makeOrderWithHub({ id: 'o-1', trackingNumber: 'TRK0001' }),
      makeOrderWithHub({ id: 'o-2', trackingNumber: 'TRK0002' }),
    ];
    prismaMock.$transaction.mockResolvedValue([orders, 2] as never);
    // The route uses Promise.all — but $transaction is also patched globally above.
    // For the array form, just patch findMany + count individually.
    prismaMock.order.findMany.mockResolvedValue(orders as never);
    prismaMock.order.count.mockResolvedValue(2 as never);

    const res = await request(app)
      .get('/api/manifest/available-orders')
      .set('Authorization', riderAuthHeader({ hubId: 'hub-7' }));

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.orders).toHaveLength(2);
    expect(res.body.orders[0]).toMatchObject({
      trackingNumber: 'TRK0001',
      status: OrderStatus.available,
    });
    expect(prismaMock.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { hubId: 'hub-7', status: OrderStatus.available },
        take: 50,
      })
    );
  });

  it('200 applies a case-insensitive contains filter on trackingNumber when search is set', async () => {
    prismaMock.order.findMany.mockResolvedValue([] as never);
    prismaMock.order.count.mockResolvedValue(0 as never);

    const res = await request(app)
      .get('/api/manifest/available-orders?search=trk00')
      .set('Authorization', riderAuthHeader({ hubId: 'hub-7' }));

    expect(res.status).toBe(200);
    expect(prismaMock.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          hubId: 'hub-7',
          status: OrderStatus.available,
          trackingNumber: { contains: 'trk00', mode: 'insensitive' },
        },
      })
    );
  });
});

// ─── GET /scan/:trackingNumber ────────────────────────────────────────────

describe('GET /api/manifest/scan/:trackingNumber', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).get('/api/manifest/scan/TRK0001');
    expect(res.status).toBe(401);
  });

  it('404 when no order matches the tracking number', async () => {
    prismaMock.order.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/manifest/scan/UNKNOWN')
      .set('Authorization', riderAuthHeader());

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('UNKNOWN');
  });

  it('409 when the order is already assigned', async () => {
    prismaMock.order.findUnique.mockResolvedValue(
      makeOrderWithHub({
        trackingNumber: 'TRK0001',
        status: OrderStatus.assigned,
        assignedManifestId: 'm-other',
      }) as never
    );

    const res = await request(app)
      .get('/api/manifest/scan/TRK0001')
      .set('Authorization', riderAuthHeader());

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: expect.stringContaining('TRK0001'),
      status: OrderStatus.assigned,
      assignedManifestId: 'm-other',
    });
  });

  it('403 when the order belongs to a different hub', async () => {
    prismaMock.order.findUnique.mockResolvedValue(
      makeOrderWithHub({
        trackingNumber: 'TRK0001',
        hubId: 'hub-other',
        status: OrderStatus.available,
      }) as never
    );

    const res = await request(app)
      .get('/api/manifest/scan/TRK0001')
      .set('Authorization', riderAuthHeader({ hubId: 'hub-1' }));

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('different hub');
  });

  it('200 returns the formatted order payload on success', async () => {
    prismaMock.order.findUnique.mockResolvedValue(
      makeOrderWithHub({
        id: 'o-1',
        trackingNumber: 'TRK0001',
        recipientName: 'Maria',
        recipientPhone: '+639170000010',
        addressText: 'Ayala',
        addressLat: 14.5,
        addressLng: 121.0,
        serviceType: 'standard',
        codAmount: 250,
        hubId: 'hub-1',
        status: OrderStatus.available,
      }) as never
    );

    const res = await request(app)
      .get('/api/manifest/scan/TRK0001')
      .set('Authorization', riderAuthHeader({ hubId: 'hub-1' }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 'o-1',
      trackingNumber: 'TRK0001',
      recipient: { name: 'Maria', phone: '+639170000010' },
      address: { text: 'Ayala', lat: 14.5, lng: 121.0 },
      serviceType: 'standard',
      codAmount: 250,
      hub: 'Makati Hub',
      zone: 'NCR',
      status: OrderStatus.available,
    });
  });
});

// ─── POST /create ─────────────────────────────────────────────────────────

describe('POST /api/manifest/create', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).post('/api/manifest/create').send({ orderIds: ['x'] });
    expect(res.status).toBe(401);
  });

  it('400 when orderIds is not a non-empty array', async () => {
    const res = await request(app)
      .post('/api/manifest/create')
      .set('Authorization', riderAuthHeader())
      .send({ orderIds: [] });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'orderIds must be a non-empty array' });
  });

  it('400 when some order IDs are not found', async () => {
    prismaMock.order.findMany.mockResolvedValue([
      makeOrderWithHub({ id: 'o-1', status: OrderStatus.available }),
    ] as never);

    const res = await request(app)
      .post('/api/manifest/create')
      .set('Authorization', riderAuthHeader())
      .send({ orderIds: ['o-1', 'o-2'] });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Some order IDs were not found' });
  });

  it('409 when some orders are not available', async () => {
    prismaMock.order.findMany.mockResolvedValue([
      makeOrderWithHub({
        id: 'o-1',
        trackingNumber: 'TRK0001',
        status: OrderStatus.available,
      }),
      makeOrderWithHub({
        id: 'o-2',
        trackingNumber: 'TRK0002',
        status: OrderStatus.assigned,
      }),
    ] as never);

    const res = await request(app)
      .post('/api/manifest/create')
      .set('Authorization', riderAuthHeader())
      .send({ orderIds: ['o-1', 'o-2'] });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: 'Some orders are not available',
      unavailable: [{ trackingNumber: 'TRK0002', status: OrderStatus.assigned }],
    });
  });

  it('403 when some orders belong to a different hub', async () => {
    prismaMock.order.findMany.mockResolvedValue([
      makeOrderWithHub({
        id: 'o-1',
        trackingNumber: 'TRK0001',
        hubId: 'hub-1',
        status: OrderStatus.available,
      }),
      makeOrderWithHub({
        id: 'o-2',
        trackingNumber: 'TRK0002',
        hubId: 'hub-other',
        status: OrderStatus.available,
      }),
    ] as never);

    const res = await request(app)
      .post('/api/manifest/create')
      .set('Authorization', riderAuthHeader({ hubId: 'hub-1' }))
      .send({ orderIds: ['o-1', 'o-2'] });

    expect(res.status).toBe(403);
    expect(res.body.wrongHub).toEqual(['TRK0002']);
  });

  it('201 creates manifest with sequenced stops, first stop in_progress, and assigns orders', async () => {
    const orders = [
      makeOrderWithHub({ id: 'o-1', hubId: 'hub-1', status: OrderStatus.available }),
      makeOrderWithHub({ id: 'o-2', hubId: 'hub-1', status: OrderStatus.available }),
    ];
    prismaMock.order.findMany.mockResolvedValue(orders as never);

    const createdManifest = makeManifest({
      id: 'manifest-new',
      manifestId: 'DDR-20260603-aaaa',
      totalStops: 2,
    });
    prismaMock.manifest.create.mockResolvedValue(createdManifest as never);
    prismaMock.stop.createMany.mockResolvedValue({ count: 2 } as never);
    prismaMock.order.updateMany.mockResolvedValue({ count: 2 } as never);
    prismaMock.manifest.findUniqueOrThrow.mockResolvedValue({
      ...createdManifest,
      stops: [],
    } as never);

    const res = await request(app)
      .post('/api/manifest/create')
      .set('Authorization', riderAuthHeader({ hubId: 'hub-1', riderId: 'rider-1' }))
      .send({ orderIds: ['o-1', 'o-2'] });

    expect(res.status).toBe(201);

    // Manifest created with totalStops=2 and in_progress
    expect(prismaMock.manifest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          riderId: 'rider-1',
          status: ManifestStatus.in_progress,
          totalStops: 2,
          completedStops: 0,
          failedStops: 0,
        }),
      })
    );

    // Stops sequenced 1..N, first one in_progress, rest pending
    const stopArgs = prismaMock.stop.createMany.mock.calls[0][0] as {
      data: Array<{ orderId: string; sequence: number; status: StopStatus }>;
    };
    expect(stopArgs.data).toHaveLength(2);
    expect(stopArgs.data[0]).toMatchObject({
      orderId: 'o-1',
      sequence: 1,
      status: StopStatus.in_progress,
    });
    expect(stopArgs.data[1]).toMatchObject({
      orderId: 'o-2',
      sequence: 2,
      status: StopStatus.pending,
    });

    // Orders flipped to assigned with the new manifest id
    expect(prismaMock.order.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['o-1', 'o-2'] } },
      data: {
        status: OrderStatus.assigned,
        assignedManifestId: 'manifest-new',
      },
    });
  });
});

// ─── POST /sync ───────────────────────────────────────────────────────────

describe('POST /api/manifest/sync', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).post('/api/manifest/sync');
    expect(res.status).toBe(401);
  });

  it('500 when GOOGLE_MAPS_API_KEY is unset', async () => {
    const original = process.env.GOOGLE_MAPS_API_KEY;
    delete process.env.GOOGLE_MAPS_API_KEY;

    const res = await request(app)
      .post('/api/manifest/sync')
      .set('Authorization', riderAuthHeader())
      .send({});

    process.env.GOOGLE_MAPS_API_KEY = original;
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Google Maps API key not configured' });
  });

  it('200 geocodes ungeocoded orders and updates them', async () => {
    prismaMock.order.findMany.mockResolvedValue([
      { id: 'o-1', addressText: '123 Ayala', addressGeocoded: false, trackingNumber: 'T1' },
      { id: 'o-2', addressText: '', addressGeocoded: false, trackingNumber: 'T2' },
    ] as never);

    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({
        status: 'OK',
        results: [{ geometry: { location: { lat: 14.5, lng: 121.0 } } }],
      }),
    }) as unknown as typeof global.fetch;

    const res = await request(app)
      .post('/api/manifest/sync')
      .set('Authorization', riderAuthHeader())
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      geocodedCount: 1,
      totalUngeocoded: 2,
    });
    // Orders with empty addressText are skipped — fetch called once
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(prismaMock.order.update).toHaveBeenCalledWith({
      where: { id: 'o-1' },
      data: { addressLat: 14.5, addressLng: 121.0, addressGeocoded: true },
    });
  });
});

// ─── GET /stop/:stopId ────────────────────────────────────────────────────

describe('GET /api/manifest/stop/:stopId', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).get('/api/manifest/stop/stop-aaaa');
    expect(res.status).toBe(401);
  });

  it('404 when no stop matches the business stopId', async () => {
    prismaMock.stop.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/manifest/stop/stop-missing')
      .set('Authorization', riderAuthHeader());

    expect(res.status).toBe(404);
  });

  it('200 returns the stop with order and deliveryResult', async () => {
    prismaMock.stop.findUnique.mockResolvedValue({
      ...makeStop({ stopId: 'stop-aaaa' }),
      order: makeOrderWithHub(),
      deliveryResult: null,
    } as never);

    const res = await request(app)
      .get('/api/manifest/stop/stop-aaaa')
      .set('Authorization', riderAuthHeader());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stopId: 'stop-aaaa' });
    expect(prismaMock.stop.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { stopId: 'stop-aaaa' } })
    );
  });
});

// ─── DELETE /stop/:stopId ─────────────────────────────────────────────────

describe('DELETE /api/manifest/stop/:stopId', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).delete('/api/manifest/stop/stop-x');
    expect(res.status).toBe(401);
  });

  it('404 when no stop matches', async () => {
    prismaMock.stop.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .delete('/api/manifest/stop/stop-missing')
      .set('Authorization', riderAuthHeader());

    expect(res.status).toBe(404);
  });

  it('409 when the stop is already completed', async () => {
    prismaMock.stop.findUnique.mockResolvedValue({
      ...makeStop({ stopId: 'stop-1', status: StopStatus.completed }),
      manifest: makeManifest({ riderId: 'rider-1' }),
    } as never);

    const res = await request(app)
      .delete('/api/manifest/stop/stop-1')
      .set('Authorization', riderAuthHeader({ riderId: 'rider-1' }));

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Cannot remove a completed stop' });
  });

  it('403 when the stop`s manifest belongs to a different rider', async () => {
    prismaMock.stop.findUnique.mockResolvedValue({
      ...makeStop({ stopId: 'stop-1', status: StopStatus.pending }),
      manifest: makeManifest({ riderId: 'someone-else' }),
    } as never);

    const res = await request(app)
      .delete('/api/manifest/stop/stop-1')
      .set('Authorization', riderAuthHeader({ riderId: 'rider-1' }));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Not your manifest' });
  });

  it('200 deletes a pending stop, releases its order, and resequences remaining stops', async () => {
    const targetStop = {
      ...makeStop({
        id: 'stop-db-2',
        stopId: 'stop-2',
        status: StopStatus.in_progress,
        sequence: 2,
        orderId: 'order-2',
      }),
      manifest: makeManifest({ id: 'manifest-1', riderId: 'rider-1' }),
    };
    prismaMock.stop.findUnique.mockResolvedValue(targetStop as never);

    // Inside the transaction, the route does:
    //   1. order.update (release)  → mock allows any return
    //   2. stop.delete             → ditto
    //   3. stop.findMany (remaining) → return a 1-element list to trigger renumbering
    //   4. stop.update (sequence + maybe in_progress promotion)
    //   5. stop.findMany (counter sync select status)
    //   6. manifest.update         → counters
    //   7. manifest.findUniqueOrThrow
    prismaMock.stop.findMany
      .mockResolvedValueOnce([
        makeStop({ id: 'stop-db-3', sequence: 3, status: StopStatus.pending }),
      ] as never)
      .mockResolvedValueOnce([{ status: StopStatus.in_progress }] as never);

    prismaMock.manifest.findUniqueOrThrow.mockResolvedValue({
      ...makeManifest({ id: 'manifest-1' }),
      stops: [],
    } as never);

    const res = await request(app)
      .delete('/api/manifest/stop/stop-2')
      .set('Authorization', riderAuthHeader({ riderId: 'rider-1' }));

    expect(res.status).toBe(200);

    // Order released
    expect(prismaMock.order.update).toHaveBeenCalledWith({
      where: { id: 'order-2' },
      data: { status: OrderStatus.available, assignedManifestId: null },
    });
    // Stop removed
    expect(prismaMock.stop.delete).toHaveBeenCalledWith({
      where: { id: 'stop-db-2' },
    });
    // Survivor renumbered to sequence=1; since the deleted stop was in_progress and
    // the survivor was pending, it should also be promoted to in_progress.
    expect(prismaMock.stop.update).toHaveBeenCalledWith({
      where: { id: 'stop-db-3' },
      data: { sequence: 1, status: StopStatus.in_progress },
    });
    // Manifest counters synced
    expect(prismaMock.manifest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'manifest-1' },
        data: expect.objectContaining({
          totalStops: 1,
          completedStops: 0,
          failedStops: 0,
        }),
      })
    );
  });
});

// ─── GET / (today's active manifest) ──────────────────────────────────────

describe('GET /api/manifest', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).get('/api/manifest');
    expect(res.status).toBe(401);
  });

  it('404 when there is no active manifest for today', async () => {
    prismaMock.manifest.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/manifest')
      .set('Authorization', riderAuthHeader());

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'No active manifest found for today' });
  });

  it('200 returns the rider`s active manifest', async () => {
    prismaMock.manifest.findFirst.mockResolvedValue({
      ...makeManifest({ id: 'manifest-1', status: ManifestStatus.in_progress }),
      stops: [],
    } as never);

    const res = await request(app)
      .get('/api/manifest')
      .set('Authorization', riderAuthHeader({ riderId: 'rider-1' }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'manifest-1', status: ManifestStatus.in_progress });
    // Verifies the where clause restricts to today + active statuses
    expect(prismaMock.manifest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          riderId: 'rider-1',
          status: { in: [ManifestStatus.pending, ManifestStatus.in_progress] },
        }),
      })
    );
  });
});
