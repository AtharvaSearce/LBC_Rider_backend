import { Router, Request, Response } from 'express';
import {
  DeliveryNextAction,
  DeliveryOutcome,
  ManifestStatus,
  OrderStatus,
  Prisma,
  PrismaClient,
  StopStatus,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import logger from '../utils/logger';

type TxClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

const router = Router();

const DONE_STOP_STATUSES = new Set<StopStatus>([
  StopStatus.completed,
  StopStatus.rts,
  StopStatus.reschedule,
]);

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

async function promoteNextPendingStop(db: TxClient, manifestId: string, excludeStopId?: string) {
  const nextStop = await db.stop.findFirst({
    where: {
      manifestId,
      status: { in: [StopStatus.pending, StopStatus.in_progress] },
      ...(excludeStopId && { stopId: { not: excludeStopId } }),
    },
    orderBy: { sequence: 'asc' },
    include: stopDetailInclude,
  });

  if (nextStop?.status === StopStatus.pending) {
    return db.stop.update({
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
    logger.error('[Delivery] History error', { err });
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

    // Idempotency guard — if stop already terminal, return existing result
    if (DONE_STOP_STATUSES.has(stop.status)) {
      logger.info('[Delivery] Idempotent replay — stop already done', { stopId, status: stop.status });
      res.json({
        message: 'Delivery already processed',
        completedStop: stop,
        nextStop: null,
        _replayed: true,
      });
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
        select: { status: true, orderId: true },
      });
      const allDone = allStops.every((s) =>
        DONE_STOP_STATUSES.has(s.status)
      );
      if (allDone) {
        await tx.manifest.update({
          where: { id: stop.manifestId },
          data: { status: ManifestStatus.completed },
        });

        // Release rts/reschedule orders back to available (same as cleanup)
        const releaseOrderIds = allStops
          .filter((s) =>
            s.status === StopStatus.rts || s.status === StopStatus.reschedule
          )
          .map((s) => s.orderId);

        if (releaseOrderIds.length > 0) {
          await tx.order.updateMany({
            where: {
              id: { in: releaseOrderIds },
            },
            data: {
              status: OrderStatus.available,
              assignedManifestId: null,
            },
          });
        }
      }

      await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.delivered, assignedManifestId: null },
      });

      const result = await tx.stop.findUniqueOrThrow({
        where: { id: stop.id },
        include: stopDetailInclude,
      });

      const nextStop = await promoteNextPendingStop(tx, stop.manifestId);

      return { completedStop: result, nextStop };
    }, { timeout: 15000 });

    logger.info('[Delivery] Stop completed', { stopId, riderId: req.rider?.riderId });
    res.json({
      message: 'Delivery completed successfully',
      completedStop: completedStop.completedStop,
      nextStop: completedStop.nextStop ?? null,
    });
  } catch (err) {
    logger.error('[Delivery] Complete error', { err, stopId: req.params.stopId });
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

    // Idempotency guard — if stop already terminal, return existing result
    if (DONE_STOP_STATUSES.has(stop.status)) {
      logger.info('[Delivery] Idempotent replay — stop already done', { stopId, status: stop.status });
      res.json({
        message: 'Delivery already processed',
        failedStop: stop,
        nextStop: null,
        _replayed: true,
      });
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
      } else if (newStatus === StopStatus.failed) {
        await tx.order.update({
          where: { id: orderId },
          data: { status: OrderStatus.available, assignedManifestId: null },
        });
      } else if (newStatus === StopStatus.reschedule) {
        await tx.order.update({
          where: { id: orderId },
          data: { status: OrderStatus.returned },
        });
      }

      // Check if all stops are now in a terminal state → mark manifest completed
      const allStops = await tx.stop.findMany({
        where: { manifestId: stop.manifestId },
        select: { status: true, orderId: true },
      });
      const allDone = allStops.every((s) =>
        DONE_STOP_STATUSES.has(s.status)
      );
      if (allDone) {
        await tx.manifest.update({
          where: { id: stop.manifestId },
          data: { status: ManifestStatus.completed },
        });

        // Release rts/reschedule orders back to available (same as cleanup)
        const releaseOrderIds = allStops
          .filter((s) =>
            s.status === StopStatus.rts || s.status === StopStatus.reschedule
          )
          .map((s) => s.orderId);

        if (releaseOrderIds.length > 0) {
          await tx.order.updateMany({
            where: {
              id: { in: releaseOrderIds },
            },
            data: {
              status: OrderStatus.available,
              assignedManifestId: null,
            },
          });
        }
      }

      const result = await tx.stop.findUniqueOrThrow({
        where: { id: stop.id },
        include: stopDetailInclude,
      });

      const nextStop = await promoteNextPendingStop(tx, stop.manifestId, stopId);

      return { failedStop: result, nextStop };
    }, { timeout: 15000 });

    const statusMessages: Record<string, string> = {
      rts: `Delivery failed (attempt ${newAttemptCount}/${stop.maxAttempts}). Item marked for return to hub.`,
      reschedule: `Delivery failed (attempt ${newAttemptCount}/${stop.maxAttempts}). Marked for reschedule.`,
      failed: `Delivery failed (attempt ${newAttemptCount}/${stop.maxAttempts}). Will retry later in route.`,
    };

    logger.info('[Delivery] Stop failed', {
      stopId,
      newStatus,
      attemptCount: newAttemptCount,
      riderId: req.rider?.riderId,
    });

    res.json({
      message: statusMessages[newStatus] || statusMessages.failed,
      failedStop: failedStop.failedStop,
      nextStop: failedStop.nextStop ?? null,
    });
  } catch (err) {
    logger.error('[Delivery] Fail error', { err, stopId: req.params.stopId });
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

    // Idempotency guard — if stop already terminal, return existing result
    if (DONE_STOP_STATUSES.has(stop.status)) {
      logger.info('[Delivery] Idempotent replay — stop already done', { stopId, status: stop.status });
      res.json({
        message: 'RTS already processed',
        stop,
        _replayed: true,
      });
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
    }, { timeout: 15000 });

    logger.info('[Delivery] Stop marked RTS', { stopId, riderId: req.rider?.riderId });
    res.json({ message: 'Stop marked as Return to Sender', stop: updatedStop });
  } catch (err) {
    logger.error('[Delivery] RTS error', { err, stopId: req.params.stopId });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Batch Sync (offline queue replay) ──────────────────────────────

router.post('/batch-sync', async (req: Request, res: Response) => {
  try {
    const riderId = req.rider?.riderId;
    if (!riderId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { actions } = req.body;
    if (!Array.isArray(actions) || actions.length === 0) {
      res.status(400).json({ error: 'actions array is required' });
      return;
    }

    logger.info('[Delivery] Batch sync started', { riderId, count: actions.length });

    const results: { clientId: string; status: string; stopId: string; reason?: string; error?: string }[] = [];

    for (const action of actions) {
      const { clientId, stopId, type, data } = action;
      try {
        const stop = await findStopByBusinessId(stopId);
        if (!stop) {
          results.push({ clientId, status: 'error', stopId, error: 'Stop not found' });
          continue;
        }

        // If stop is already in a terminal state, skip (idempotent)
        if (DONE_STOP_STATUSES.has(stop.status)) {
          results.push({ clientId, status: 'skipped', stopId, reason: 'already_processed' });
          continue;
        }

        if (!stop.orderId) {
          results.push({ clientId, status: 'error', stopId, error: 'No linked order' });
          continue;
        }

        const orderId = stop.orderId;
        const deliveryTimestamp = data?.timestamp ? new Date(data.timestamp) : new Date();

        if (type === 'complete') {
          await prisma.$transaction(async (tx) => {
            await tx.stop.update({
              where: { id: stop.id },
              data: { status: StopStatus.completed, attemptCount: { increment: 1 } },
            });
            await tx.deliveryResult.upsert({
              where: { stopId: stop.id },
              create: {
                stopId: stop.id,
                outcome: DeliveryOutcome.delivered,
                timestamp: deliveryTimestamp,
                signatureUri: optionalString(data?.signatureBase64),
                photoUri: optionalString(data?.photoBase64),
                codCollected: data?.codCollected ?? 0,
              },
              update: {
                outcome: DeliveryOutcome.delivered,
                timestamp: deliveryTimestamp,
                signatureUri: optionalString(data?.signatureBase64),
                photoUri: optionalString(data?.photoBase64),
                codCollected: data?.codCollected ?? 0,
              },
            });
            await tx.order.update({
              where: { id: orderId },
              data: { status: OrderStatus.delivered, assignedManifestId: null },
            });
            await promoteNextPendingStop(tx, stop.manifestId);
          }, { timeout: 15000 });

        } else if (type === 'fail') {
          const newAttemptCount = stop.attemptCount + 1;
          let newStatus: StopStatus;
          const nextAction = data?.nextAction;
          if (nextAction === 'reschedule') {
            newStatus = StopStatus.reschedule;
          } else if (newAttemptCount >= stop.maxAttempts || nextAction === 'rts') {
            newStatus = StopStatus.rts;
          } else {
            newStatus = StopStatus.failed;
          }

          await prisma.$transaction(async (tx) => {
            await tx.stop.update({
              where: { id: stop.id },
              data: { status: newStatus, attemptCount: { increment: 1 } },
            });
            await tx.deliveryResult.upsert({
              where: { stopId: stop.id },
              create: {
                stopId: stop.id,
                outcome: DeliveryOutcome.failed,
                timestamp: deliveryTimestamp,
                failureReason: data?.reason || 'Unknown',
                failureNotes: data?.notes || '',
                photoUri: optionalString(data?.photoBase64),
                nextAction: parseNextAction(nextAction),
              },
              update: {
                outcome: DeliveryOutcome.failed,
                timestamp: deliveryTimestamp,
                failureReason: data?.reason || 'Unknown',
                failureNotes: data?.notes || '',
                photoUri: optionalString(data?.photoBase64),
                nextAction: parseNextAction(nextAction),
              },
            });

            if (newStatus === StopStatus.rts) {
              await tx.order.update({
                where: { id: orderId },
                data: { status: OrderStatus.returned, assignedManifestId: null },
              });
            } else if (newStatus === StopStatus.reschedule) {
              await tx.order.update({
                where: { id: orderId },
                data: { status: OrderStatus.available, assignedManifestId: null },
              });
            }

            if (DONE_STOP_STATUSES.has(newStatus)) {
              await promoteNextPendingStop(tx, stop.manifestId);
            }
          }, { timeout: 15000 });

        } else if (type === 'rts') {
          await prisma.$transaction(async (tx) => {
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
                failureReason: data?.reason || 'Returned to sender',
                failureNotes: data?.notes || '',
                nextAction: DeliveryNextAction.rts,
              },
              update: {
                outcome: DeliveryOutcome.failed,
                timestamp: new Date(),
                failureReason: data?.reason || 'Returned to sender',
                failureNotes: data?.notes || '',
                nextAction: DeliveryNextAction.rts,
              },
            });
            await tx.order.update({
              where: { id: orderId },
              data: { status: OrderStatus.returned, assignedManifestId: null },
            });
          }, { timeout: 15000 });

        } else {
          results.push({ clientId, status: 'error', stopId, error: `Unknown type: ${type}` });
          continue;
        }

        results.push({ clientId, status: 'ok', stopId });
      } catch (actionErr: any) {
        logger.error('[Delivery] Batch sync action failed', { clientId, stopId, err: actionErr });
        results.push({ clientId, status: 'error', stopId, error: actionErr.message || 'Unknown error' });
      }
    }

    logger.info('[Delivery] Batch sync completed', {
      riderId,
      total: actions.length,
      ok: results.filter(r => r.status === 'ok').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      errors: results.filter(r => r.status === 'error').length,
    });

    res.json({ results });
  } catch (err) {
    logger.error('[Delivery] Batch sync error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
