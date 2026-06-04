import '../../../src/types/express';
import request from 'supertest';
import { ManifestStatus, Prisma, StopStatus } from '@prisma/client';
import { prismaMock } from '../../helpers/prismaMock';
import { buildApp } from '../../helpers/app';
import { adminAuthHeader } from '../../helpers/auth';
import { adminMiddleware } from '../../../src/middleware/admin-auth';
import adminDashboardRouter from '../../../src/routes/admin-dashboard';

const app = buildApp({
  mountPath: '/api/admin/dashboard',
  router: adminDashboardRouter,
  preMiddleware: [adminMiddleware],
});

// Helpers ──────────────────────────────────────────────────────────────────

function setupAllCounts(values: {
  riderTotal?: number;
  riderActive?: number;
  manifestTotal?: number;
  manifestToday?: number;
  manifestActive?: number;
  stopsTotal?: number;
}) {
  // The route fires count() six times, in this order:
  //   rider.count()                         → totalRiders
  //   rider.count({ where: { isActive } })  → activeRiders
  //   manifest.count()                      → totalManifests
  //   manifest.count({ where: { date }})    → todayManifests
  //   manifest.count({ where: { status }})  → activeManifests
  //   stop.count()                          → totalStops
  (prismaMock.rider.count as jest.Mock)
    .mockResolvedValueOnce(values.riderTotal ?? 0)
    .mockResolvedValueOnce(values.riderActive ?? 0);

  (prismaMock.manifest.count as jest.Mock)
    .mockResolvedValueOnce(values.manifestTotal ?? 0)
    .mockResolvedValueOnce(values.manifestToday ?? 0)
    .mockResolvedValueOnce(values.manifestActive ?? 0);

  (prismaMock.stop.count as jest.Mock).mockResolvedValueOnce(values.stopsTotal ?? 0);
}

// ───────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/dashboard', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).get('/api/admin/dashboard');
    expect(res.status).toBe(401);
  });

  it('200 returns a fully zeroed payload when there is no data at all', async () => {
    setupAllCounts({});
    (prismaMock.stop.groupBy as jest.Mock).mockResolvedValue([]);
    // First findMany = completed-with-COD, second = recentActivity.
    (prismaMock.stop.findMany as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    (prismaMock.$queryRaw as unknown as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .get('/api/admin/dashboard')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      riders: { total: 0, active: 0 },
      manifests: { total: 0, today: 0, active: 0 },
      stops: {
        total: 0,
        pending: 0,
        inProgress: 0,
        completed: 0,
        failed: 0,
        rts: 0,
        reschedule: 0,
      },
      deliveryRate: 0,
      cod: { totalExpected: 0, totalCollected: 0 },
      recentActivity: [],
      serviceBreakdown: [],
    });
  });

  it('200 aggregates counts, computes deliveryRate, sums COD, and shapes service breakdown', async () => {
    setupAllCounts({
      riderTotal: 25,
      riderActive: 18,
      manifestTotal: 200,
      manifestToday: 12,
      manifestActive: 5,
      stopsTotal: 1000,
    });

    (prismaMock.stop.groupBy as jest.Mock).mockResolvedValue([
      { status: StopStatus.pending, _count: { status: 100 } },
      { status: StopStatus.in_progress, _count: { status: 50 } },
      { status: StopStatus.completed, _count: { status: 700 } },
      { status: StopStatus.failed, _count: { status: 80 } },
      { status: StopStatus.rts, _count: { status: 50 } },
      { status: StopStatus.reschedule, _count: { status: 20 } },
    ]);

    // Completed-with-COD: two stops, mixing collected/uncollected.
    (prismaMock.stop.findMany as jest.Mock)
      .mockResolvedValueOnce([
        {
          order: { codAmount: new Prisma.Decimal(500) },
          deliveryResult: { codCollected: new Prisma.Decimal(500) },
        },
        {
          order: { codAmount: new Prisma.Decimal(250) },
          // Stop completed but COD not collected → counts toward expected only.
          deliveryResult: null,
        },
        {
          // Stop without an order should be skipped entirely.
          order: null,
          deliveryResult: { codCollected: new Prisma.Decimal(999) },
        },
      ])
      .mockResolvedValueOnce([
        { id: 'stop-recent', stopId: 'stop-zzz', status: StopStatus.completed },
      ]);

    (prismaMock.$queryRaw as unknown as jest.Mock).mockResolvedValue([
      { serviceType: 'Express', count: BigInt(750) },
      { serviceType: 'Standard', count: BigInt(250) },
    ]);

    const res = await request(app)
      .get('/api/admin/dashboard')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(200);
    expect(res.body.riders).toEqual({ total: 25, active: 18 });
    expect(res.body.manifests).toEqual({ total: 200, today: 12, active: 5 });
    expect(res.body.stops).toEqual({
      total: 1000,
      pending: 100,
      inProgress: 50,
      completed: 700,
      failed: 80,
      rts: 50,
      reschedule: 20,
    });

    // attemptedStops = 700 + (80 + 50 + 20) = 850
    // deliveryRate   = round(700 / 850 * 100) = 82
    expect(res.body.deliveryRate).toBe(82);

    expect(res.body.cod).toEqual({
      totalExpected: 750,
      totalCollected: 500,
    });

    expect(res.body.recentActivity).toHaveLength(1);
    expect(res.body.serviceBreakdown).toEqual([
      { _id: 'Express', count: 750 },
      { _id: 'Standard', count: 250 },
    ]);
  });

  it('uses today-midnight..tomorrow-midnight as the today filter for manifest.count', async () => {
    setupAllCounts({});
    (prismaMock.stop.groupBy as jest.Mock).mockResolvedValue([]);
    (prismaMock.stop.findMany as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    (prismaMock.$queryRaw as unknown as jest.Mock).mockResolvedValue([]);

    await request(app)
      .get('/api/admin/dashboard')
      .set('Authorization', adminAuthHeader());

    // Second call is the today-bounded one: manifest.count({ where: { date: { gte, lt } } })
    const todayCall = (prismaMock.manifest.count as jest.Mock).mock.calls[1][0];
    const range = todayCall.where.date as { gte: Date; lt: Date };

    expect(range.gte).toBeInstanceOf(Date);
    expect(range.lt).toBeInstanceOf(Date);
    expect(range.gte.getHours()).toBe(0);
    expect(range.gte.getMinutes()).toBe(0);
    expect(range.lt.getTime() - range.gte.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('queries activeManifests with status=in_progress and recentActivity with the four terminal stop statuses', async () => {
    setupAllCounts({});
    (prismaMock.stop.groupBy as jest.Mock).mockResolvedValue([]);
    (prismaMock.stop.findMany as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    (prismaMock.$queryRaw as unknown as jest.Mock).mockResolvedValue([]);

    await request(app)
      .get('/api/admin/dashboard')
      .set('Authorization', adminAuthHeader());

    // Third manifest.count() filters by status=in_progress.
    const activeCall = (prismaMock.manifest.count as jest.Mock).mock.calls[2][0];
    expect(activeCall).toEqual({ where: { status: ManifestStatus.in_progress } });

    // Second stop.findMany call fetches recent activity, ordered by updatedAt desc, taking 10.
    const recentArgs = (prismaMock.stop.findMany as jest.Mock).mock.calls[1][0];
    expect(recentArgs.where.status.in).toEqual([
      StopStatus.completed,
      StopStatus.failed,
      StopStatus.rts,
      StopStatus.reschedule,
    ]);
    expect(recentArgs.orderBy).toEqual({ updatedAt: 'desc' });
    expect(recentArgs.take).toBe(10);
  });

  it('500 when any aggregate query throws', async () => {
    (prismaMock.rider.count as jest.Mock).mockRejectedValueOnce(new Error('db down'));

    const res = await request(app)
      .get('/api/admin/dashboard')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});
