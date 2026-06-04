import '../../../src/types/express';
import request from 'supertest';
import {
  DeliveryNextAction,
  DeliveryOutcome,
  ManifestStatus,
  OrderStatus,
  StopStatus,
} from '@prisma/client';
import { prismaMock } from '../../helpers/prismaMock';
import { buildApp } from '../../helpers/app';
import { riderAuthHeader } from '../../helpers/auth';
import { authMiddleware } from '../../../src/middleware/rider-auth';
import deliveryRouter from '../../../src/routes/delivery';
import {
  makeDeliveryResult,
  makeManifest,
  makeOrder,
  makeStop,
} from '../../helpers/fixtures';

const app = buildApp({
  mountPath: '/api/delivery',
  router: deliveryRouter,
  preMiddleware: [authMiddleware],
});

beforeEach(() => {
  (prismaMock.$transaction as unknown as jest.Mock).mockImplementation(
    async (cb: (tx: typeof prismaMock) => unknown) => cb(prismaMock)
  );
});

function makeStopWithRelations(
  overrides: Partial<{
    id: string;
    stopId: string;
    status: StopStatus;
    attemptCount: number;
    maxAttempts: number;
    manifestId: string;
    orderId: string;
  }> = {}
) {
  const stop = makeStop({
    id: overrides.id ?? 'stop-db-1',
    stopId: overrides.stopId ?? 'stop-aaaa',
    status: overrides.status ?? StopStatus.in_progress,
    attemptCount: overrides.attemptCount ?? 0,
    maxAttempts: overrides.maxAttempts ?? 3,
    manifestId: overrides.manifestId ?? 'manifest-1',
    orderId: overrides.orderId ?? 'order-1',
  });
  return {
    ...stop,
    order: makeOrder({ id: stop.orderId }),
    deliveryResult: null,
    manifest: { id: stop.manifestId, manifestId: 'DDR-20260603-aaaa' },
  };
}

// ─── GET /history ─────────────────────────────────────────────────────────

describe('GET /api/delivery/history', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).get('/api/delivery/history');
    expect(res.status).toBe(401);
  });

  it('200 returns deliveries and a summary count by status', async () => {
    prismaMock.manifest.findMany.mockResolvedValue([
      { id: 'manifest-1' },
      { id: 'manifest-2' },
    ] as never);

    const stops = [
      { ...makeStop({ id: 's-1', status: StopStatus.completed }), order: makeOrder() },
      { ...makeStop({ id: 's-2', status: StopStatus.completed }), order: makeOrder() },
      { ...makeStop({ id: 's-3', status: StopStatus.failed }), order: makeOrder() },
      { ...makeStop({ id: 's-4', status: StopStatus.rts }), order: makeOrder() },
    ];
    prismaMock.stop.findMany.mockResolvedValue(stops as never);

    const res = await request(app)
      .get('/api/delivery/history')
      .set('Authorization', riderAuthHeader({ riderId: 'rider-1' }));

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({
      total: 4,
      delivered: 2,
      failed: 1,
      returned: 1,
    });
    // Defaults to "today's terminal stops" when no filters supplied
    expect(prismaMock.stop.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          manifestId: { in: ['manifest-1', 'manifest-2'] },
          status: {
            in: [StopStatus.completed, StopStatus.failed, StopStatus.rts],
          },
        }),
        orderBy: { updatedAt: 'desc' },
      })
    );
  });

  it('200 honours an explicit status filter', async () => {
    prismaMock.manifest.findMany.mockResolvedValue([{ id: 'm-1' }] as never);
    prismaMock.stop.findMany.mockResolvedValue([] as never);

    const res = await request(app)
      .get('/api/delivery/history?status=failed')
      .set('Authorization', riderAuthHeader());

    expect(res.status).toBe(200);
    expect(prismaMock.stop.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: StopStatus.failed }),
      })
    );
  });

  it('200 applies an OR contains filter on trackingNumber/recipient when ?search is set', async () => {
    prismaMock.manifest.findMany.mockResolvedValue([{ id: 'm-1' }] as never);
    prismaMock.stop.findMany.mockResolvedValue([] as never);

    const res = await request(app)
      .get('/api/delivery/history?search=maria')
      .set('Authorization', riderAuthHeader());

    expect(res.status).toBe(200);
    const args = prismaMock.stop.findMany.mock.calls[0][0] as {
      where: { order?: { is?: { OR?: unknown[] } } };
    };
    expect(args.where.order?.is?.OR).toEqual([
      { trackingNumber: { contains: 'maria', mode: 'insensitive' } },
      { recipientName: { contains: 'maria', mode: 'insensitive' } },
    ]);
  });

  it('200 narrows updatedAt to "today" when ?date=today', async () => {
    prismaMock.manifest.findMany.mockResolvedValue([{ id: 'm-1' }] as never);
    prismaMock.stop.findMany.mockResolvedValue([] as never);

    const res = await request(app)
      .get('/api/delivery/history?date=today')
      .set('Authorization', riderAuthHeader());

    expect(res.status).toBe(200);
    const args = prismaMock.stop.findMany.mock.calls[0][0] as {
      where: { updatedAt?: { gte: Date; lt: Date } };
    };
    expect(args.where.updatedAt).toBeDefined();
    expect(args.where.updatedAt!.gte).toBeInstanceOf(Date);
    expect(args.where.updatedAt!.lt.getTime() - args.where.updatedAt!.gte.getTime()).toBe(
      24 * 60 * 60 * 1000
    );
  });
});

// ─── POST /:stopId/complete ───────────────────────────────────────────────

describe('POST /api/delivery/:stopId/complete', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).post('/api/delivery/stop-x/complete').send({});
    expect(res.status).toBe(401);
  });

  it('404 when no stop matches the business stopId', async () => {
    prismaMock.stop.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/delivery/missing/complete')
      .set('Authorization', riderAuthHeader())
      .send({});

    expect(res.status).toBe(404);
  });

  it('200 idempotent replay when the stop is already completed', async () => {
    const stop = makeStopWithRelations({ status: StopStatus.completed });
    prismaMock.stop.findUnique.mockResolvedValue(stop as never);

    const res = await request(app)
      .post('/api/delivery/stop-aaaa/complete')
      .set('Authorization', riderAuthHeader())
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      message: 'Delivery already processed',
      _replayed: true,
    });
    // No mutations should have been issued on a replay
    expect(prismaMock.stop.update).not.toHaveBeenCalled();
    expect(prismaMock.deliveryResult.upsert).not.toHaveBeenCalled();
  });

  it('200 happy path completes the stop, upserts result, updates manifest+order, promotes next stop', async () => {
    const stop = makeStopWithRelations({
      id: 'stop-db-1',
      stopId: 'stop-aaaa',
      status: StopStatus.in_progress,
      manifestId: 'manifest-1',
      orderId: 'order-1',
    });
    prismaMock.stop.findUnique.mockResolvedValue(stop as never);

    // After the update inside the tx, the route fetches all stops to test for full completion.
    // Returning a list where not all stops are done keeps the manifest in_progress.
    prismaMock.stop.findMany.mockResolvedValue([
      { status: StopStatus.completed, orderId: 'order-1' },
      { status: StopStatus.pending, orderId: 'order-2' },
    ] as never);

    prismaMock.stop.findUniqueOrThrow.mockResolvedValue({
      ...stop,
      status: StopStatus.completed,
      deliveryResult: makeDeliveryResult({ codCollected: 250 }),
    } as never);

    // promoteNextPendingStop → findFirst returns a pending stop, then update promotes it
    const promoted = makeStopWithRelations({
      id: 'stop-db-2',
      stopId: 'stop-bbbb',
      status: StopStatus.pending,
      orderId: 'order-2',
    });
    prismaMock.stop.findFirst.mockResolvedValue(promoted as never);
    // stop.update is called twice in this flow — mock by id so the promotion
    // call returns a valid populated stop object that the route forwards back.
    (prismaMock.stop.update as unknown as jest.Mock).mockImplementation(
      async (args: { where: { id: string } }) => {
        if (args.where.id === 'stop-db-2') {
          return { ...promoted, status: StopStatus.in_progress };
        }
        return promoted;
      }
    );

    const res = await request(app)
      .post('/api/delivery/stop-aaaa/complete')
      .set('Authorization', riderAuthHeader({ riderId: 'rider-1' }))
      .send({ codCollected: 250, signatureBase64: 'sig', photoBase64: 'pic' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Delivery completed successfully');
    expect(res.body.completedStop.status).toBe(StopStatus.completed);
    expect(res.body.nextStop).toMatchObject({
      stopId: 'stop-bbbb',
      status: StopStatus.in_progress,
    });

    // Stop flipped to completed + attempt incremented
    expect(prismaMock.stop.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'stop-db-1' },
        data: expect.objectContaining({
          status: StopStatus.completed,
          attemptCount: { increment: 1 },
        }),
      })
    );
    // Delivery result upserted with the COD payload
    expect(prismaMock.deliveryResult.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stopId: 'stop-db-1' },
        create: expect.objectContaining({
          outcome: DeliveryOutcome.delivered,
          codCollected: 250,
          signatureUri: 'sig',
          photoUri: 'pic',
        }),
      })
    );
    // Manifest counter incremented
    expect(prismaMock.manifest.update).toHaveBeenCalledWith({
      where: { id: 'manifest-1' },
      data: { completedStops: { increment: 1 } },
    });
    // Order flagged delivered + detached
    expect(prismaMock.order.update).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      data: { status: OrderStatus.delivered, assignedManifestId: null },
    });
    // Next pending stop promoted to in_progress
    expect(prismaMock.stop.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'stop-db-2' },
        data: { status: StopStatus.in_progress },
      })
    );
  });

  it('200 marks the manifest completed and releases rts/reschedule orders when this is the last open stop', async () => {
    const stop = makeStopWithRelations({
      id: 'stop-db-1',
      stopId: 'stop-aaaa',
      manifestId: 'manifest-1',
      orderId: 'order-1',
    });
    prismaMock.stop.findUnique.mockResolvedValue(stop as never);

    // All stops are now in terminal states → manifest should close
    // and the rescheduled order should be released.
    prismaMock.stop.findMany.mockResolvedValue([
      { status: StopStatus.completed, orderId: 'order-1' },
      { status: StopStatus.reschedule, orderId: 'order-3' },
    ] as never);

    prismaMock.stop.findUniqueOrThrow.mockResolvedValue({
      ...stop,
      status: StopStatus.completed,
      deliveryResult: makeDeliveryResult(),
    } as never);
    prismaMock.stop.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/delivery/stop-aaaa/complete')
      .set('Authorization', riderAuthHeader())
      .send({});

    expect(res.status).toBe(200);

    // Manifest closed
    expect(prismaMock.manifest.update).toHaveBeenCalledWith({
      where: { id: 'manifest-1' },
      data: { status: ManifestStatus.completed },
    });
    // Rescheduled order released back to available
    expect(prismaMock.order.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['order-3'] } },
      data: { status: OrderStatus.available, assignedManifestId: null },
    });
  });
});

// ─── POST /:stopId/fail ───────────────────────────────────────────────────

describe('POST /api/delivery/:stopId/fail', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).post('/api/delivery/stop-x/fail').send({});
    expect(res.status).toBe(401);
  });

  it('400 when reason is missing', async () => {
    const res = await request(app)
      .post('/api/delivery/stop-x/fail')
      .set('Authorization', riderAuthHeader())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Failure reason is required' });
  });

  it('404 when no stop matches', async () => {
    prismaMock.stop.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/delivery/missing/fail')
      .set('Authorization', riderAuthHeader())
      .send({ reason: 'recipient unavailable' });

    expect(res.status).toBe(404);
  });

  it('200 idempotent replay when the stop is already terminal', async () => {
    prismaMock.stop.findUnique.mockResolvedValue(
      makeStopWithRelations({ status: StopStatus.rts }) as never
    );

    const res = await request(app)
      .post('/api/delivery/stop-aaaa/fail')
      .set('Authorization', riderAuthHeader())
      .send({ reason: 'replay' });

    expect(res.status).toBe(200);
    expect(res.body._replayed).toBe(true);
    expect(prismaMock.stop.update).not.toHaveBeenCalled();
  });

  function setupFailFlow(
    stop: ReturnType<typeof makeStopWithRelations>,
    survivorStatus: StopStatus = StopStatus.pending
  ) {
    prismaMock.stop.findUnique.mockResolvedValue(stop as never);
    prismaMock.stop.findMany.mockResolvedValue([
      { status: StopStatus.completed, orderId: 'other' },
      { status: survivorStatus, orderId: stop.orderId },
    ] as never);
    prismaMock.stop.findUniqueOrThrow.mockResolvedValue({
      ...stop,
      deliveryResult: makeDeliveryResult({ outcome: DeliveryOutcome.failed }),
    } as never);
    prismaMock.stop.findFirst.mockResolvedValue(null);
  }

  it('200 nextAction=reschedule → status reschedule, order returned (kept attached)', async () => {
    const stop = makeStopWithRelations({
      attemptCount: 0,
      maxAttempts: 3,
      orderId: 'order-1',
    });
    setupFailFlow(stop, StopStatus.reschedule);

    const res = await request(app)
      .post('/api/delivery/stop-aaaa/fail')
      .set('Authorization', riderAuthHeader())
      .send({ reason: 'rain delay', nextAction: 'reschedule' });

    expect(res.status).toBe(200);
    expect(res.body.failedStop).toBeTruthy();

    expect(prismaMock.stop.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: StopStatus.reschedule,
          attemptCount: 1,
        }),
      })
    );
    // For reschedule, the order is set returned but assignedManifestId stays
    expect(prismaMock.order.update).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      data: { status: OrderStatus.returned },
    });
  });

  it('200 attempts under the limit → status failed, order released to available', async () => {
    const stop = makeStopWithRelations({
      attemptCount: 0,
      maxAttempts: 3,
      orderId: 'order-1',
    });
    setupFailFlow(stop, StopStatus.failed);

    const res = await request(app)
      .post('/api/delivery/stop-aaaa/fail')
      .set('Authorization', riderAuthHeader())
      .send({ reason: 'no answer at door' });

    expect(res.status).toBe(200);
    expect(prismaMock.stop.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: StopStatus.failed,
          attemptCount: 1,
        }),
      })
    );
    expect(prismaMock.order.update).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      data: { status: OrderStatus.available, assignedManifestId: null },
    });
  });

  it('200 last attempt exhausted → status rts, order returned + detached', async () => {
    const stop = makeStopWithRelations({
      attemptCount: 2,
      maxAttempts: 3,
      orderId: 'order-1',
    });
    setupFailFlow(stop, StopStatus.rts);

    const res = await request(app)
      .post('/api/delivery/stop-aaaa/fail')
      .set('Authorization', riderAuthHeader())
      .send({ reason: 'undeliverable' });

    expect(res.status).toBe(200);
    expect(prismaMock.stop.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: StopStatus.rts,
          attemptCount: 3,
        }),
      })
    );
    expect(prismaMock.order.update).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      data: { status: OrderStatus.returned, assignedManifestId: null },
    });
  });

  it('200 nextAction=rts forces rts even when attempts remain', async () => {
    const stop = makeStopWithRelations({
      attemptCount: 0,
      maxAttempts: 3,
      orderId: 'order-1',
    });
    setupFailFlow(stop, StopStatus.rts);

    const res = await request(app)
      .post('/api/delivery/stop-aaaa/fail')
      .set('Authorization', riderAuthHeader())
      .send({ reason: 'recipient refused', nextAction: 'rts' });

    expect(res.status).toBe(200);
    expect(prismaMock.stop.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: StopStatus.rts }),
      })
    );
  });
});

// ─── POST /:stopId/rts ────────────────────────────────────────────────────

describe('POST /api/delivery/:stopId/rts', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).post('/api/delivery/stop-x/rts').send({});
    expect(res.status).toBe(401);
  });

  it('404 when no stop matches', async () => {
    prismaMock.stop.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/delivery/missing/rts')
      .set('Authorization', riderAuthHeader())
      .send({});

    expect(res.status).toBe(404);
  });

  it('200 idempotent replay when the stop is already terminal', async () => {
    prismaMock.stop.findUnique.mockResolvedValue(
      makeStopWithRelations({ status: StopStatus.rts }) as never
    );

    const res = await request(app)
      .post('/api/delivery/stop-aaaa/rts')
      .set('Authorization', riderAuthHeader())
      .send({});

    expect(res.status).toBe(200);
    expect(res.body._replayed).toBe(true);
  });

  it('200 marks the stop rts, upserts a failed result, and returns the order', async () => {
    const stop = makeStopWithRelations({
      id: 'stop-db-1',
      stopId: 'stop-aaaa',
      orderId: 'order-1',
    });
    prismaMock.stop.findUnique.mockResolvedValue(stop as never);
    prismaMock.stop.findUniqueOrThrow.mockResolvedValue({
      ...stop,
      status: StopStatus.rts,
      deliveryResult: makeDeliveryResult({
        outcome: DeliveryOutcome.failed,
        nextAction: DeliveryNextAction.rts,
      }),
    } as never);

    const res = await request(app)
      .post('/api/delivery/stop-aaaa/rts')
      .set('Authorization', riderAuthHeader())
      .send({ reason: 'address invalid', notes: 'drove past 2x' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Stop marked as Return to Sender');

    expect(prismaMock.stop.update).toHaveBeenCalledWith({
      where: { id: 'stop-db-1' },
      data: { status: StopStatus.rts },
    });
    expect(prismaMock.deliveryResult.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stopId: 'stop-db-1' },
        create: expect.objectContaining({
          outcome: DeliveryOutcome.failed,
          failureReason: 'address invalid',
          failureNotes: 'drove past 2x',
          nextAction: DeliveryNextAction.rts,
        }),
      })
    );
    expect(prismaMock.order.update).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      data: { status: OrderStatus.returned, assignedManifestId: null },
    });
  });
});

// ─── POST /batch-sync ─────────────────────────────────────────────────────

describe('POST /api/delivery/batch-sync', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app)
      .post('/api/delivery/batch-sync')
      .send({ actions: [] });
    expect(res.status).toBe(401);
  });

  it('400 when actions is not a non-empty array', async () => {
    const res = await request(app)
      .post('/api/delivery/batch-sync')
      .set('Authorization', riderAuthHeader())
      .send({ actions: [] });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'actions array is required' });
  });

  it('200 processes a mix of ok / skipped / error actions', async () => {
    const okStop = makeStopWithRelations({
      id: 'stop-db-1',
      stopId: 'stop-aaaa',
      status: StopStatus.in_progress,
      orderId: 'order-1',
    });
    const skippedStop = makeStopWithRelations({
      id: 'stop-db-2',
      stopId: 'stop-bbbb',
      status: StopStatus.completed,
      orderId: 'order-2',
    });

    prismaMock.stop.findUnique
      .mockResolvedValueOnce(okStop as never) // action 1: complete
      .mockResolvedValueOnce(skippedStop as never) // action 2: replay
      .mockResolvedValueOnce(null); // action 3: missing

    // promoteNextPendingStop inside the complete tx
    prismaMock.stop.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/delivery/batch-sync')
      .set('Authorization', riderAuthHeader({ riderId: 'rider-1' }))
      .send({
        actions: [
          {
            clientId: 'c-1',
            stopId: 'stop-aaaa',
            type: 'complete',
            data: { codCollected: 100 },
          },
          { clientId: 'c-2', stopId: 'stop-bbbb', type: 'complete', data: {} },
          { clientId: 'c-3', stopId: 'stop-missing', type: 'complete', data: {} },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { clientId: 'c-1', status: 'ok', stopId: 'stop-aaaa' },
      {
        clientId: 'c-2',
        status: 'skipped',
        stopId: 'stop-bbbb',
        reason: 'already_processed',
      },
      {
        clientId: 'c-3',
        status: 'error',
        stopId: 'stop-missing',
        error: 'Stop not found',
      },
    ]);
    // Only the first action should have run a delivered upsert
    expect(prismaMock.deliveryResult.upsert).toHaveBeenCalledTimes(1);
    expect(prismaMock.deliveryResult.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ codCollected: 100 }),
      })
    );
  });

  it('200 reports unknown action types as errors', async () => {
    const stop = makeStopWithRelations({ status: StopStatus.in_progress });
    prismaMock.stop.findUnique.mockResolvedValue(stop as never);

    const res = await request(app)
      .post('/api/delivery/batch-sync')
      .set('Authorization', riderAuthHeader())
      .send({
        actions: [
          {
            clientId: 'c-bad',
            stopId: 'stop-aaaa',
            type: 'teleport',
            data: {},
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({
      clientId: 'c-bad',
      status: 'error',
      error: expect.stringContaining('Unknown type'),
    });
  });
});
