import '../../../src/types/express';
import request from 'supertest';
import { ManifestStatus, OrderStatus, StopStatus } from '@prisma/client';
import { prismaMock } from '../../helpers/prismaMock';
import { buildApp } from '../../helpers/app';
import { adminAuthHeader } from '../../helpers/auth';
import { adminMiddleware } from '../../../src/middleware/admin-auth';
import adminStopsRouter from '../../../src/routes/admin-stops';
import { makeManifest, makeOrder, makeStop } from '../../helpers/fixtures';

const app = buildApp({
  mountPath: '/api/admin/stops',
  router: adminStopsRouter,
  preMiddleware: [adminMiddleware],
});

beforeEach(() => {
  // The router uses prisma.$transaction(callback) for atomic stop creation /
  // deletion. Pipe the callback at the same deep-mock proxy so all tx.* calls
  // resolve through the same handlers we set per-test.
  (prismaMock.$transaction as unknown as jest.Mock).mockImplementation(
    async (cb: (tx: typeof prismaMock) => unknown) => cb(prismaMock)
  );
});

// ─── GET /api/admin/stops ─────────────────────────────────────────────────

describe('GET /api/admin/stops', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).get('/api/admin/stops');
    expect(res.status).toBe(401);
  });

  it('200 lists stops with no filters', async () => {
    (prismaMock.stop.findMany as jest.Mock).mockResolvedValue([
      makeStop({ id: 's1' }),
      makeStop({ id: 's2' }),
    ]);

    const res = await request(app)
      .get('/api/admin/stops')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    const args = (prismaMock.stop.findMany as jest.Mock).mock.calls[0][0];
    expect(args.where).toEqual({});
    expect(args.orderBy).toEqual({ sequence: 'asc' });
  });

  it('404 when manifestId filter does not resolve', async () => {
    (prismaMock.manifest.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .get('/api/admin/stops?manifestId=missing')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Manifest not found' });
  });

  it('200 looks up the manifest by id OR manifestId and applies status + search filters', async () => {
    (prismaMock.manifest.findFirst as jest.Mock).mockResolvedValue(makeManifest());
    (prismaMock.stop.findMany as jest.Mock).mockResolvedValue([]);

    await request(app)
      .get(
        `/api/admin/stops?manifestId=DDR-001&status=${StopStatus.in_progress}&search=TRK`
      )
      .set('Authorization', adminAuthHeader());

    const findManifestArgs = (prismaMock.manifest.findFirst as jest.Mock).mock
      .calls[0][0];
    expect(findManifestArgs.where.OR).toEqual([
      { id: 'DDR-001' },
      { manifestId: 'DDR-001' },
    ]);

    const args = (prismaMock.stop.findMany as jest.Mock).mock.calls[0][0];
    expect(args.where.manifestId).toBe('manifest-1');
    expect(args.where.status).toBe(StopStatus.in_progress);
    expect(args.where.OR).toEqual([
      { stopId: { contains: 'TRK', mode: 'insensitive' } },
      {
        order: {
          is: {
            OR: [
              { trackingNumber: { contains: 'TRK', mode: 'insensitive' } },
              { recipientName: { contains: 'TRK', mode: 'insensitive' } },
              { addressText: { contains: 'TRK', mode: 'insensitive' } },
            ],
          },
        },
      },
    ]);
  });

  it('200 ignores status when status=all', async () => {
    (prismaMock.stop.findMany as jest.Mock).mockResolvedValue([]);

    await request(app)
      .get('/api/admin/stops?status=all')
      .set('Authorization', adminAuthHeader());

    const args = (prismaMock.stop.findMany as jest.Mock).mock.calls[0][0];
    expect(args.where.status).toBeUndefined();
  });

  it('400 on an unknown stop status filter', async () => {
    const res = await request(app)
      .get('/api/admin/stops?status=bogus')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(400);
  });
});

// ─── GET /api/admin/stops/:id ─────────────────────────────────────────────

describe('GET /api/admin/stops/:id', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).get('/api/admin/stops/stop-1');
    expect(res.status).toBe(401);
  });

  it('404 when stop does not exist (lookup by id or stopId)', async () => {
    (prismaMock.stop.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .get('/api/admin/stops/missing')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(404);
  });

  it('200 returns the stop with manifest/order/deliveryResult includes', async () => {
    const stop = makeStop();
    (prismaMock.stop.findFirst as jest.Mock).mockResolvedValue(stop);
    (prismaMock.stop.findUnique as jest.Mock).mockResolvedValue({
      ...stop,
      manifest: { id: 'manifest-1', manifestId: 'DDR-001', riderId: 'rider-1' },
      order: makeOrder(),
      deliveryResult: null,
    });

    const res = await request(app)
      .get('/api/admin/stops/stop-1')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(200);
    expect(res.body.stop.id).toBe('stop-1');

    const lookupArgs = (prismaMock.stop.findFirst as jest.Mock).mock.calls[0][0];
    expect(lookupArgs.where.OR).toEqual([
      { id: 'stop-1' },
      { stopId: 'stop-1' },
    ]);
  });
});

// ─── POST /api/admin/stops ────────────────────────────────────────────────

describe('POST /api/admin/stops', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).post('/api/admin/stops').send({});
    expect(res.status).toBe(401);
  });

  it('400 when manifestId is missing or both orderId and trackingNumber are missing', async () => {
    const res = await request(app)
      .post('/api/admin/stops')
      .set('Authorization', adminAuthHeader())
      .send({ manifestId: 'm-1' });

    expect(res.status).toBe(400);
  });

  it('404 when manifest cannot be resolved', async () => {
    (prismaMock.manifest.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post('/api/admin/stops')
      .set('Authorization', adminAuthHeader())
      .send({ manifestId: 'missing', trackingNumber: 'TRK0001' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Manifest not found' });
  });

  it('409 when the requested stopId already exists', async () => {
    (prismaMock.manifest.findFirst as jest.Mock).mockResolvedValue(makeManifest());
    (prismaMock.stop.findUnique as jest.Mock).mockResolvedValue(makeStop());

    const res = await request(app)
      .post('/api/admin/stops')
      .set('Authorization', adminAuthHeader())
      .send({
        manifestId: 'manifest-1',
        trackingNumber: 'TRK0001',
        stopId: 'stop-aaaa1111',
      });

    expect(res.status).toBe(409);
  });

  it('404 when neither orderId nor trackingNumber resolves an order', async () => {
    (prismaMock.manifest.findFirst as jest.Mock).mockResolvedValue(makeManifest());
    (prismaMock.stop.findUnique as jest.Mock).mockResolvedValue(null); // visitStopId free
    (prismaMock.order.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post('/api/admin/stops')
      .set('Authorization', adminAuthHeader())
      .send({ manifestId: 'manifest-1', trackingNumber: 'TRK-NOPE' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Order not found' });
  });

  it('409 when the order is already delivered', async () => {
    (prismaMock.manifest.findFirst as jest.Mock).mockResolvedValue(makeManifest());
    (prismaMock.stop.findUnique as jest.Mock).mockResolvedValue(null);
    (prismaMock.order.findUnique as jest.Mock).mockResolvedValue(
      makeOrder({ status: OrderStatus.delivered })
    );

    const res = await request(app)
      .post('/api/admin/stops')
      .set('Authorization', adminAuthHeader())
      .send({ manifestId: 'manifest-1', trackingNumber: 'TRK0001' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already been delivered/i);
  });

  it('409 when the order is already on an active stop somewhere', async () => {
    (prismaMock.manifest.findFirst as jest.Mock).mockResolvedValue(makeManifest());
    (prismaMock.stop.findUnique as jest.Mock).mockResolvedValue(null);
    (prismaMock.order.findUnique as jest.Mock).mockResolvedValue(
      makeOrder({ status: OrderStatus.assigned })
    );
    // First stop.findFirst is the active-stop check, second is same-manifest check.
    (prismaMock.stop.findFirst as jest.Mock).mockResolvedValueOnce(makeStop());

    const res = await request(app)
      .post('/api/admin/stops')
      .set('Authorization', adminAuthHeader())
      .send({ manifestId: 'manifest-1', trackingNumber: 'TRK0001' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already on an active manifest stop/i);
  });

  it('201 creates stop, assigns order, computes next sequence, and re-syncs manifest counters', async () => {
    (prismaMock.manifest.findFirst as jest.Mock).mockResolvedValue(makeManifest());
    (prismaMock.stop.findUnique as jest.Mock).mockResolvedValue(null);
    (prismaMock.order.findUnique as jest.Mock).mockResolvedValue(
      makeOrder({ id: 'order-9', trackingNumber: 'TRK-NEW', status: OrderStatus.available })
    );
    // Both active-stop and same-manifest checks return null.
    (prismaMock.stop.findFirst as jest.Mock).mockResolvedValue(null);
    (prismaMock.order.update as jest.Mock).mockResolvedValue(makeOrder());
    (prismaMock.stop.count as jest.Mock).mockResolvedValue(2);
    (prismaMock.stop.create as jest.Mock).mockResolvedValue({
      ...makeStop({ id: 'stop-new', sequence: 3 }),
      manifest: { id: 'manifest-1', manifestId: 'DDR-001', riderId: 'rider-1' },
      order: makeOrder({ id: 'order-9' }),
      deliveryResult: null,
    });

    // syncManifestCounters runs after the transaction.
    (prismaMock.stop.findMany as jest.Mock).mockResolvedValue([
      { status: StopStatus.pending },
      { status: StopStatus.pending },
      { status: StopStatus.pending },
    ]);
    (prismaMock.manifest.update as jest.Mock).mockResolvedValue(makeManifest());

    const res = await request(app)
      .post('/api/admin/stops')
      .set('Authorization', adminAuthHeader())
      .send({ manifestId: 'manifest-1', trackingNumber: 'TRK-NEW' });

    expect(res.status).toBe(201);
    expect(res.body.stop.sequence).toBe(3);

    const orderUpdateArgs = (prismaMock.order.update as jest.Mock).mock.calls[0][0];
    expect(orderUpdateArgs).toMatchObject({
      where: { id: 'order-9' },
      data: { assignedManifestId: 'manifest-1', status: OrderStatus.assigned },
    });

    const stopCreateArgs = (prismaMock.stop.create as jest.Mock).mock.calls[0][0];
    expect(stopCreateArgs.data).toMatchObject({
      manifestId: 'manifest-1',
      orderId: 'order-9',
      sequence: 3,
      status: StopStatus.pending,
      attemptCount: 0,
      maxAttempts: 3,
    });

    const counterArgs = (prismaMock.manifest.update as jest.Mock).mock.calls[0][0];
    expect(counterArgs).toMatchObject({
      where: { id: 'manifest-1' },
      data: { totalStops: 3, completedStops: 0, failedStops: 0 },
    });
  });
});

// ─── PUT /api/admin/stops/:id ─────────────────────────────────────────────

describe('PUT /api/admin/stops/:id', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).put('/api/admin/stops/stop-1').send({});
    expect(res.status).toBe(401);
  });

  it('404 when stop cannot be found', async () => {
    (prismaMock.stop.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .put('/api/admin/stops/missing')
      .set('Authorization', adminAuthHeader())
      .send({ sequence: 5 });

    expect(res.status).toBe(404);
  });

  it('400 on an invalid status', async () => {
    (prismaMock.stop.findFirst as jest.Mock).mockResolvedValue(makeStop());

    const res = await request(app)
      .put('/api/admin/stops/stop-1')
      .set('Authorization', adminAuthHeader())
      .send({ status: 'banana' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid status' });
  });

  it('200 updates only sent fields and skips order/manifest sync when status did not change', async () => {
    const existing = makeStop({ status: StopStatus.pending });
    (prismaMock.stop.findFirst as jest.Mock).mockResolvedValue(existing);
    (prismaMock.stop.findUniqueOrThrow as jest.Mock).mockResolvedValue({
      id: existing.id,
      orderId: existing.orderId,
      manifestId: existing.manifestId,
      status: existing.status,
    });
    (prismaMock.stop.update as jest.Mock).mockResolvedValue(existing);

    const res = await request(app)
      .put('/api/admin/stops/stop-1')
      .set('Authorization', adminAuthHeader())
      .send({ sequence: 9, distance: 1234, eta: '15 mins' });

    expect(res.status).toBe(200);
    const args = (prismaMock.stop.update as jest.Mock).mock.calls[0][0];
    expect(args.where).toEqual({ id: existing.id });
    expect(args.data).toEqual({ sequence: 9, distance: 1234, eta: '15 mins' });

    // No status change → no counter sync, no order sync.
    expect((prismaMock.manifest.update as jest.Mock)).not.toHaveBeenCalled();
    expect((prismaMock.order.update as jest.Mock)).not.toHaveBeenCalled();
  });

  it('200 on status=completed → marks order delivered, releases assignment, re-syncs manifest', async () => {
    const existing = makeStop({ status: StopStatus.in_progress });
    (prismaMock.stop.findFirst as jest.Mock).mockResolvedValue(existing);
    (prismaMock.stop.findUniqueOrThrow as jest.Mock).mockResolvedValue({
      id: existing.id,
      orderId: existing.orderId,
      manifestId: existing.manifestId,
      status: existing.status,
    });
    (prismaMock.stop.update as jest.Mock).mockResolvedValue(
      makeStop({ status: StopStatus.completed })
    );
    (prismaMock.stop.findMany as jest.Mock).mockResolvedValue([
      { status: StopStatus.completed },
    ]);
    (prismaMock.manifest.update as jest.Mock).mockResolvedValue(makeManifest());
    (prismaMock.order.update as jest.Mock).mockResolvedValue(makeOrder());

    const res = await request(app)
      .put('/api/admin/stops/stop-1')
      .set('Authorization', adminAuthHeader())
      .send({ status: StopStatus.completed });

    expect(res.status).toBe(200);

    expect((prismaMock.order.update as jest.Mock)).toHaveBeenCalledWith({
      where: { id: existing.orderId },
      data: { status: OrderStatus.delivered, assignedManifestId: null },
    });

    // All stops complete → manifest flips to completed.
    const counterArgs = (prismaMock.manifest.update as jest.Mock).mock.calls[0][0];
    expect(counterArgs.data).toMatchObject({
      totalStops: 1,
      completedStops: 1,
      status: ManifestStatus.completed,
    });
  });

  it('200 on status=rts → marks order returned & releases', async () => {
    const existing = makeStop({ status: StopStatus.in_progress });
    (prismaMock.stop.findFirst as jest.Mock).mockResolvedValue(existing);
    (prismaMock.stop.findUniqueOrThrow as jest.Mock).mockResolvedValue({
      id: existing.id,
      orderId: existing.orderId,
      manifestId: existing.manifestId,
      status: existing.status,
    });
    (prismaMock.stop.update as jest.Mock).mockResolvedValue(
      makeStop({ status: StopStatus.rts })
    );
    (prismaMock.stop.findMany as jest.Mock).mockResolvedValue([
      { status: StopStatus.rts },
    ]);
    (prismaMock.manifest.update as jest.Mock).mockResolvedValue(makeManifest());
    (prismaMock.order.update as jest.Mock).mockResolvedValue(makeOrder());

    const res = await request(app)
      .put('/api/admin/stops/stop-1')
      .set('Authorization', adminAuthHeader())
      .send({ status: StopStatus.rts });

    expect(res.status).toBe(200);
    expect((prismaMock.order.update as jest.Mock)).toHaveBeenCalledWith({
      where: { id: existing.orderId },
      data: { status: OrderStatus.returned, assignedManifestId: null },
    });
  });

  it('200 on status=failed → flips order back to available so it can be reassigned', async () => {
    const existing = makeStop({ status: StopStatus.in_progress });
    (prismaMock.stop.findFirst as jest.Mock).mockResolvedValue(existing);
    (prismaMock.stop.findUniqueOrThrow as jest.Mock).mockResolvedValue({
      id: existing.id,
      orderId: existing.orderId,
      manifestId: existing.manifestId,
      status: existing.status,
    });
    (prismaMock.stop.update as jest.Mock).mockResolvedValue(
      makeStop({ status: StopStatus.failed })
    );
    (prismaMock.stop.findMany as jest.Mock).mockResolvedValue([
      { status: StopStatus.failed },
    ]);
    (prismaMock.manifest.update as jest.Mock).mockResolvedValue(makeManifest());
    (prismaMock.order.update as jest.Mock).mockResolvedValue(makeOrder());

    await request(app)
      .put('/api/admin/stops/stop-1')
      .set('Authorization', adminAuthHeader())
      .send({ status: StopStatus.failed });

    expect((prismaMock.order.update as jest.Mock)).toHaveBeenCalledWith({
      where: { id: existing.orderId },
      data: { status: OrderStatus.available, assignedManifestId: null },
    });
  });

  it('200 on status=reschedule → marks order returned but keeps assignment for cleanup job', async () => {
    const existing = makeStop({ status: StopStatus.in_progress });
    (prismaMock.stop.findFirst as jest.Mock).mockResolvedValue(existing);
    (prismaMock.stop.findUniqueOrThrow as jest.Mock).mockResolvedValue({
      id: existing.id,
      orderId: existing.orderId,
      manifestId: existing.manifestId,
      status: existing.status,
    });
    (prismaMock.stop.update as jest.Mock).mockResolvedValue(
      makeStop({ status: StopStatus.reschedule })
    );
    (prismaMock.stop.findMany as jest.Mock).mockResolvedValue([
      { status: StopStatus.reschedule },
    ]);
    (prismaMock.manifest.update as jest.Mock).mockResolvedValue(makeManifest());
    (prismaMock.order.update as jest.Mock).mockResolvedValue(makeOrder());

    await request(app)
      .put('/api/admin/stops/stop-1')
      .set('Authorization', adminAuthHeader())
      .send({ status: StopStatus.reschedule });

    expect((prismaMock.order.update as jest.Mock)).toHaveBeenCalledWith({
      where: { id: existing.orderId },
      // No assignedManifestId reset — handled by /manifest/cleanup.
      data: { status: OrderStatus.returned },
    });
  });
});

// ─── DELETE /api/admin/stops/:id ──────────────────────────────────────────

describe('DELETE /api/admin/stops/:id', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).delete('/api/admin/stops/stop-1');
    expect(res.status).toBe(401);
  });

  it('404 when stop cannot be found', async () => {
    (prismaMock.stop.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .delete('/api/admin/stops/missing')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(404);
  });

  it('200 deletes an active stop and releases the assigned order back to available', async () => {
    const existing = makeStop({ status: StopStatus.pending });
    (prismaMock.stop.findFirst as jest.Mock).mockResolvedValue(existing);
    (prismaMock.stop.findUniqueOrThrow as jest.Mock).mockResolvedValue({
      id: existing.id,
      orderId: existing.orderId,
      manifestId: existing.manifestId,
      status: existing.status,
    });
    (prismaMock.stop.delete as jest.Mock).mockResolvedValue(existing);
    (prismaMock.order.findUnique as jest.Mock).mockResolvedValue(
      makeOrder({ assignedManifestId: existing.manifestId, status: OrderStatus.assigned })
    );
    (prismaMock.order.update as jest.Mock).mockResolvedValue(makeOrder());
    (prismaMock.stop.findMany as jest.Mock).mockResolvedValue([]);
    (prismaMock.manifest.update as jest.Mock).mockResolvedValue(makeManifest());

    const res = await request(app)
      .delete('/api/admin/stops/stop-1')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Stop deleted' });

    expect((prismaMock.stop.delete as jest.Mock)).toHaveBeenCalledWith({
      where: { id: existing.id },
    });
    expect((prismaMock.order.update as jest.Mock)).toHaveBeenCalledWith({
      where: { id: existing.orderId },
      data: { assignedManifestId: null, status: OrderStatus.available },
    });
  });

  it('200 deletes a completed stop without touching the order', async () => {
    const existing = makeStop({ status: StopStatus.completed });
    (prismaMock.stop.findFirst as jest.Mock).mockResolvedValue(existing);
    (prismaMock.stop.findUniqueOrThrow as jest.Mock).mockResolvedValue({
      id: existing.id,
      orderId: existing.orderId,
      manifestId: existing.manifestId,
      status: existing.status,
    });
    (prismaMock.stop.delete as jest.Mock).mockResolvedValue(existing);
    (prismaMock.stop.findMany as jest.Mock).mockResolvedValue([]);
    (prismaMock.manifest.update as jest.Mock).mockResolvedValue(makeManifest());

    const res = await request(app)
      .delete('/api/admin/stops/stop-1')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(200);
    expect((prismaMock.order.update as jest.Mock)).not.toHaveBeenCalled();
  });
});
