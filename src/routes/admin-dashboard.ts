import { Router, Request, Response } from 'express';
import { ManifestStatus, StopStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';

const router = Router();

function parseTodayRange() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return { gte: today, lt: tomorrow };
}

router.get('/', async (_req: Request, res: Response) => {
  try {
    const totalRiders = await prisma.rider.count();
    const activeRiders = await prisma.rider.count({ where: { isActive: true } });

    const todayRange = parseTodayRange();

    const totalManifests = await prisma.manifest.count();
    const todayManifests = await prisma.manifest.count({
      where: { date: todayRange },
    });
    const activeManifests = await prisma.manifest.count({
      where: { status: ManifestStatus.in_progress },
    });

    const totalStops = await prisma.stop.count();

    const stopsByStatus = await prisma.stop.groupBy({
      by: ['status'],
      _count: { status: true },
    });

    const statusMap: Record<string, number> = {};
    stopsByStatus.forEach((s) => {
      statusMap[s.status] = s._count.status;
    });

    const completedStopsWithCod = await prisma.stop.findMany({
      where: {
        status: StopStatus.completed,
        order: { codAmount: { gt: 0 } },
      },
      select: {
        order: { select: { codAmount: true } },
        deliveryResult: { select: { codCollected: true } },
      },
    });

    let totalCod = 0;
    let totalCollected = 0;
    for (const stop of completedStopsWithCod) {
      if (!stop.order) continue;
      totalCod += Number(stop.order.codAmount);
      totalCollected += Number(stop.deliveryResult?.codCollected ?? 0);
    }

    const codStats = { totalCod, totalCollected };

    const completedStops = statusMap[StopStatus.completed] || 0;
    const failedStops =
      (statusMap[StopStatus.failed] || 0) +
      (statusMap[StopStatus.rts] || 0) +
      (statusMap[StopStatus.reschedule] || 0);
    const attemptedStops = completedStops + failedStops;
    const deliveryRate =
      attemptedStops > 0
        ? Math.round((completedStops / attemptedStops) * 100)
        : 0;

    const recentActivity = await prisma.stop.findMany({
      where: {
        status: {
          in: [
            StopStatus.completed,
            StopStatus.failed,
            StopStatus.rts,
            StopStatus.reschedule,
          ],
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 10,
      include: {
        manifest: { select: { id: true, manifestId: true } },
        order: {
          select: {
            trackingNumber: true,
            recipientName: true,
            serviceType: true,
            codAmount: true,
          },
        },
        deliveryResult: true,
      },
    });

    const serviceGroups = await prisma.$queryRaw<
      { serviceType: string; count: bigint }[]
    >`
      SELECT o."serviceType", COUNT(*)::bigint AS count
      FROM "Stop" s
      INNER JOIN "Order" o ON s."orderId" = o.id
      GROUP BY o."serviceType"
      ORDER BY count DESC
    `;

    const serviceBreakdown = serviceGroups.map((row) => ({
      _id: row.serviceType,
      count: Number(row.count),
    }));

    res.json({
      riders: { total: totalRiders, active: activeRiders },
      manifests: {
        total: totalManifests,
        today: todayManifests,
        active: activeManifests,
      },
      stops: {
        total: totalStops,
        pending: statusMap[StopStatus.pending] || 0,
        inProgress: statusMap[StopStatus.in_progress] || 0,
        completed: completedStops,
        failed: statusMap[StopStatus.failed] || 0,
        rts: statusMap[StopStatus.rts] || 0,
        reschedule: statusMap[StopStatus.reschedule] || 0,
      },
      deliveryRate,
      cod: {
        totalExpected: codStats.totalCod,
        totalCollected: codStats.totalCollected,
      },
      recentActivity,
      serviceBreakdown,
    });
  } catch (err) {
    console.error('[Admin Dashboard] Stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
