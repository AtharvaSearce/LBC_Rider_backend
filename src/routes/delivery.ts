import { Router, Request, Response } from 'express';
import {
  DeliveryNextAction,
  DeliveryOutcome,
  ManifestStatus,
  OrderStatus,
  Prisma,
  StopStatus,
} from '@prisma/client';
import { prisma } from '../lib/prisma';

const router = Router();

const DONE_STOP_STATUSES: StopStatus[] = [
  StopStatus.completed,
  StopStatus.rts,
  StopStatus.reschedule,
];

const stopDetailInclude = {
  order: true,
  deliveryResult: true,
  manifest: { select: { id: true, manifestId: true } },
} as const;

function queryString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function getParamString(value: string | string[]): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

function parseNextAction(value: string | undefined): DeliveryNextAction {
  if (value === 'reschedule') return DeliveryNextAction.reschedule;
  if (value === 'rts') return DeliveryNextAction.rts;
  return DeliveryNextAction.retry;
}

function optionalString(value: string | undefined | null): string | undefined {
  return value || undefined;
}

async function findStopByBusinessId(businessStopId: string) {
  return prisma.stop.findUnique({
    where: { stopId: businessStopId },
    include: stopDetailInclude,
  });
}

async function promoteNextPendingStop(manifestId: string, excludeStopId?: string) {
  const nextStop = await prisma.stop.findFirst({
    where: {
      manifestId,
      status: { in: [StopStatus.pending, StopStatus.in_progress] },
      ...(excludeStopId && { stopId: { not: excludeStopId } }),
    },
    orderBy: { sequence: 'asc' },
    include: stopDetailInclude,
  });

  if (nextStop && nextStop.status === StopStatus.pending) {
    return prisma.stop.update({
      where: { id: nextStop.id },
      data: { status: StopStatus.in_progress },
      include: stopDetailInclude,
    });
  }

  return nextStop;
}

router.get('/history', async (req: Request, res: Response) => {
  try {
    const riderId = req.rider?.riderId;
    if (!riderId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const date = queryString(req.query.date);
    const status = queryString(req.query.status);
    const search = queryString(req.query.search);

    const manifests = await prisma.manifest.findMany({
      where: { riderId },
      select: { id: true },
    });
    const manifestIds = manifests.map((m) => m.id);

    const where: Prisma.StopWhereInput = {
      manifestId: { in: manifestIds },
    };

    if (status && status !== 'all') {
      where.status = status as StopStatus;
    } else {
      where.status = {
        in: [StopStatus.completed, StopStatus.failed, StopStatus.rts],
      };
    }

    if (search) {
      where.order = {
        is: {
          OR: [
            { trackingNumber: { contains: search, mode: 'insensitive' } },
            { recipientName: { contains: search, mode: 'insensitive' } },
          ],
        },
      };
    }

    if (date === 'today') {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      where.updatedAt = { gte: today, lt: tomorrow };
    } else if (date === 'yesterday') {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(0, 0, 0, 0);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      where.updatedAt = { gte: yesterday, lt: today };
    }

    const stops = await prisma.stop.findMany({
      where,
      include: stopDetailInclude,
      orderBy: { updatedAt: 'desc' },
    });

    const totalDelivered = stops.filter((s) => s.status === StopStatus.completed)
      .length;
    const totalFailed = stops.filter((s) => s.status === StopStatus.failed).length;
    const totalRts = stops.filter((s) => s.status === StopStatus.rts).length;

    res.json({
      deliveries: stops,
      summary: {
        total: stops.length,
        delivered: totalDelivered,
        failed: totalFailed,
        returned: totalRts,
      },
    });
  } catch (err) {
    console.error('[Delivery] History error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:stopId/complete', async (req: Request, res: Response) => {
  try {
    const stopId = getParamString(req.params.stopId);
    if (!stopId) {
      res.status(400).json({ error: 'Invalid stop id' });
      return;
    }

    const { signatureBase64, photoBase64, codCollected, timestamp } = req.body;

    const stop = await findStopByBusinessId(stopId);
    if (!stop) {
      res.status(404).json({ error: 'Stop not found' });
      return;
    }

    if (!stop.orderId) {
      res.status(500).json({ error: 'Stop has no linked order' });
      return;
    }

    const orderId = stop.orderId;

    if (stop.status === StopStatus.completed) {
      res.status(400).json({ error: 'Stop already completed' });
      return;
    }

    const deliveryTimestamp = timestamp ? new Date(timestamp) : new Date();

    const completedStop = await prisma.$transaction(async (tx) => {
      await tx.stop.update({
        where: { id: stop.id },
        data: {
          status: StopStatus.completed,
          attemptCount: { increment: 1 },
        },
      });

      await tx.deliveryResult.upsert({
        where: { stopId: stop.id },
        create: {
          stopId: stop.id,
          outcome: DeliveryOutcome.delivered,
          timestamp: deliveryTimestamp,
          signatureUri: optionalString(signatureBase64),
          photoUri: optionalString(photoBase64),
          codCollected: codCollected ?? 0,
        },
        update: {
          outcome: DeliveryOutcome.delivered,
          timestamp: deliveryTimestamp,
          signatureUri: optionalString(signatureBase64),
          photoUri: optionalString(photoBase64),
          codCollected: codCollected ?? 0,
          failureReason: null,
          failureNotes: null,
          nextAction: null,
        },
      });

      await tx.manifest.update({
        where: { id: stop.manifestId },
        data: { completedStops: { increment: 1 } },
      });

      const allStops = await tx.stop.findMany({
        where: { manifestId: stop.manifestId },
        select: { status: true },
      });
      const allDone = allStops.every((s) =>
        DONE_STOP_STATUSES.includes(s.status)
      );
      if (allDone) {
        await tx.manifest.update({
          where: { id: stop.manifestId },
          data: { status: ManifestStatus.completed },
        });
      }

      await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.delivered, assignedManifestId: null },
      });

      return tx.stop.findUniqueOrThrow({
        where: { id: stop.id },
        include: stopDetailInclude,
      });
    });

    const nextStop = await promoteNextPendingStop(stop.manifestId);

    res.json({
      message: 'Delivery completed successfully',
      completedStop,
      nextStop: nextStop || null,
    });
  } catch (err) {
    console.error('[Delivery] Complete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:stopId/fail', async (req: Request, res: Response) => {
  try {
    const stopId = getParamString(req.params.stopId);
    if (!stopId) {
      res.status(400).json({ error: 'Invalid stop id' });
      return;
    }

    const { reason, notes, photoBase64, nextAction, timestamp } = req.body;

    if (!reason) {
      res.status(400).json({ error: 'Failure reason is required' });
      return;
    }

    const stop = await findStopByBusinessId(stopId);
    if (!stop) {
      res.status(404).json({ error: 'Stop not found' });
      return;
    }

    if (!stop.orderId) {
      res.status(500).json({ error: 'Stop has no linked order' });
      return;
    }

    const orderId = stop.orderId;

    const newAttemptCount = stop.attemptCount + 1;
    let newStatus: StopStatus;

    if (nextAction === 'reschedule') {
      newStatus = StopStatus.reschedule;
    } else if (newAttemptCount >= stop.maxAttempts || nextAction === 'rts') {
      newStatus = StopStatus.rts;
    } else {
      newStatus = StopStatus.failed;
    }

    const deliveryTimestamp = timestamp ? new Date(timestamp) : new Date();

    const failedStop = await prisma.$transaction(async (tx) => {
      await tx.stop.update({
        where: { id: stop.id },
        data: {
          status: newStatus,
          attemptCount: newAttemptCount,
        },
      });

      await tx.deliveryResult.upsert({
        where: { stopId: stop.id },
        create: {
          stopId: stop.id,
          outcome: DeliveryOutcome.failed,
          timestamp: deliveryTimestamp,
          photoUri: optionalString(photoBase64),
          failureReason: reason,
          failureNotes: notes || '',
          nextAction: parseNextAction(nextAction),
        },
        update: {
          outcome: DeliveryOutcome.failed,
          timestamp: deliveryTimestamp,
          photoUri: optionalString(photoBase64),
          failureReason: reason,
          failureNotes: notes || '',
          nextAction: parseNextAction(nextAction),
          signatureUri: null,
          codCollected: null,
        },
      });

      await tx.manifest.update({
        where: { id: stop.manifestId },
        data: { failedStops: { increment: 1 } },
      });

      if (newStatus === StopStatus.rts) {
        await tx.order.update({
          where: { id: orderId },
          data: { status: OrderStatus.returned, assignedManifestId: null },
        });
      } else if (
        newStatus === StopStatus.failed ||
        newStatus === StopStatus.reschedule
      ) {
        await tx.order.update({
          where: { id: orderId },
          data: { status: OrderStatus.available, assignedManifestId: null },
        });
      }

      return tx.stop.findUniqueOrThrow({
        where: { id: stop.id },
        include: stopDetailInclude,
      });
    });

    const nextStop = await promoteNextPendingStop(stop.manifestId, stopId);

    const statusMessages: Record<string, string> = {
      rts: `Delivery failed (attempt ${newAttemptCount}/${stop.maxAttempts}). Item marked for return to hub.`,
      reschedule: `Delivery failed (attempt ${newAttemptCount}/${stop.maxAttempts}). Marked for reschedule.`,
      failed: `Delivery failed (attempt ${newAttemptCount}/${stop.maxAttempts}). Will retry later in route.`,
    };

    res.json({
      message: statusMessages[newStatus] || statusMessages.failed,
      failedStop,
      nextStop: nextStop || null,
    });
  } catch (err) {
    console.error('[Delivery] Fail error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:stopId/rts', async (req: Request, res: Response) => {
  try {
    const stopId = getParamString(req.params.stopId);
    if (!stopId) {
      res.status(400).json({ error: 'Invalid stop id' });
      return;
    }

    const { reason, notes } = req.body;

    const stop = await findStopByBusinessId(stopId);
    if (!stop) {
      res.status(404).json({ error: 'Stop not found' });
      return;
    }

    if (!stop.orderId) {
      res.status(500).json({ error: 'Stop has no linked order' });
      return;
    }

    const orderId = stop.orderId;

    const updatedStop = await prisma.$transaction(async (tx) => {
      await tx.stop.update({
        where: { id: stop.id },
        data: { status: StopStatus.rts },
      });

      await tx.deliveryResult.upsert({
        where: { stopId: stop.id },
        create: {
          stopId: stop.id,
          outcome: DeliveryOutcome.failed,
          timestamp: new Date(),
          failureReason: reason || 'Returned to sender',
          failureNotes: notes || '',
          nextAction: DeliveryNextAction.rts,
        },
        update: {
          outcome: DeliveryOutcome.failed,
          timestamp: new Date(),
          failureReason: reason || 'Returned to sender',
          failureNotes: notes || '',
          nextAction: DeliveryNextAction.rts,
        },
      });

      await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.returned, assignedManifestId: null },
      });

      return tx.stop.findUniqueOrThrow({
        where: { id: stop.id },
        include: stopDetailInclude,
      });
    });

    res.json({ message: 'Stop marked as Return to Sender', stop: updatedStop });
  } catch (err) {
    console.error('[Delivery] RTS error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
