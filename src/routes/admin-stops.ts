import { Router, Request, Response } from 'express';
import {
  ManifestStatus,
  OrderStatus,
  Prisma,
  StopStatus,
} from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../lib/prisma';

const router = Router();

const ACTIVE_STOP_STATUSES: StopStatus[] = [
  StopStatus.pending,
  StopStatus.in_progress,
];

const DONE_STOP_STATUSES = new Set<StopStatus>([
  StopStatus.completed,
  StopStatus.rts,
  StopStatus.reschedule,
]);

const FAILED_STOP_STATUSES = new Set<StopStatus>([
  StopStatus.failed,
  StopStatus.rts,
  StopStatus.reschedule,
]);

const stopInclude = {
  manifest: {
    select: {
      id: true,
      manifestId: true,
      riderId: true,
    },
  },
  order: true,
  deliveryResult: true,
} as const;

function generateStopId(): string {
  return `stop-${uuidv4().slice(0, 8)}`;
}

function queryString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function isStopStatus(value: string): value is StopStatus {
  return Object.values(StopStatus).includes(value as StopStatus);
}

async function findManifestByParam(manifestParam: string) {
  return prisma.manifest.findFirst({
    where: {
      OR: [{ id: manifestParam }, { manifestId: manifestParam }],
    },
  });
}

async function findStopByParam(stopParam: string) {
  return prisma.stop.findFirst({
    where: {
      OR: [{ id: stopParam }, { stopId: stopParam }],
    },
  });
}

async function syncManifestCounters(manifestId: string) {
  const stops = await prisma.stop.findMany({
    where: { manifestId },
    select: { status: true },
  });

  const completedStops = stops.filter((s) => s.status === StopStatus.completed)
    .length;
  const failedStops = stops.filter((s) =>
    FAILED_STOP_STATUSES.has(s.status)
  ).length;

  let status: ManifestStatus | undefined;

  if (stops.length > 0) {
    const allDone = stops.every((s) => DONE_STOP_STATUSES.has(s.status));
    if (allDone) {
      status = ManifestStatus.completed;
    } else if (stops.some((s) => s.status === StopStatus.in_progress)) {
      status = ManifestStatus.in_progress;
    }
  }

  await prisma.manifest.update({
    where: { id: manifestId },
    data: {
      totalStops: stops.length,
      completedStops,
      failedStops,
      ...(status !== undefined && { status }),
    },
  });
}

async function syncOrderFromStopStatus(orderId: string, stopStatus: StopStatus) {
  if (stopStatus === StopStatus.completed) {
    await prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.delivered, assignedManifestId: null },
    });
    return;
  }

  if (stopStatus === StopStatus.rts) {
    await prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.returned, assignedManifestId: null },
    });
    return;
  }

  if (stopStatus === StopStatus.failed) {
    await prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.available, assignedManifestId: null },
    });
    return;
  }

  if (stopStatus === StopStatus.reschedule) {
    // The parcel is coming back to the hub. Mark the order as returned
    // but leave it attached to its manifest — the daily /manifest/cleanup
    // job is responsible for releasing it back to the available pool for
    // re-dispatch.
    await prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.returned },
    });
  }
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const manifestParam = queryString(req.query.manifestId);
    const status = queryString(req.query.status);
    const search = queryString(req.query.search);

    const where: Prisma.StopWhereInput = {};

    if (manifestParam) {
      const manifest = await findManifestByParam(manifestParam);
      if (!manifest) {
        res.status(404).json({ error: 'Manifest not found' });
        return;
      }
      where.manifestId = manifest.id;
    }

    if (status && status !== 'all') {
      if (!isStopStatus(status)) {
        res.status(400).json({ error: 'Invalid status filter' });
        return;
      }
      where.status = status;
    }

    if (search) {
      where.OR = [
        { stopId: { contains: search, mode: 'insensitive' } },
        {
          order: {
            is: {
              OR: [
                { trackingNumber: { contains: search, mode: 'insensitive' } },
                { recipientName: { contains: search, mode: 'insensitive' } },
                { addressText: { contains: search, mode: 'insensitive' } },
              ],
            },
          },
        },
      ];
    }

    const stops = await prisma.stop.findMany({
      where,
      include: stopInclude,
      orderBy: { sequence: 'asc' },
    });

    res.json({ stops, total: stops.length });
  } catch (err) {
    console.error('[Admin Stops] List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const stopParam = req.params.id;
    if (typeof stopParam !== 'string') {
      res.status(400).json({ error: 'Invalid stop id' });
      return;
    }

    const found = await findStopByParam(stopParam);
    if (!found) {
      res.status(404).json({ error: 'Stop not found' });
      return;
    }

    const stop = await prisma.stop.findUnique({
      where: { id: found.id },
      include: stopInclude,
    });

    res.json({ stop });
  } catch (err) {
    console.error('[Admin Stops] Get error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      stopId: requestedStopId,
      manifestId: manifestParam,
      sequence,
      trackingNumber,
      orderId: requestedOrderId,
    } = req.body;

    if (!manifestParam || (!trackingNumber && !requestedOrderId)) {
      res.status(400).json({
        error: 'manifestId and either orderId or trackingNumber are required',
      });
      return;
    }

    const manifest = await findManifestByParam(manifestParam);
    if (!manifest) {
      res.status(404).json({ error: 'Manifest not found' });
      return;
    }

    const visitStopId = requestedStopId ?? generateStopId();

    const existingStop = await prisma.stop.findUnique({
      where: { stopId: visitStopId },
    });
    if (existingStop) {
      res.status(409).json({ error: 'Stop with this ID already exists' });
      return;
    }

    const stop = await prisma.$transaction(async (tx) => {
      const order = requestedOrderId
        ? await tx.order.findUnique({ where: { id: requestedOrderId } })
        : await tx.order.findUnique({ where: { trackingNumber } });

      if (!order) {
        throw new Error('ORDER_NOT_FOUND');
      }

      if (trackingNumber && order.trackingNumber !== trackingNumber) {
        throw new Error('orderId does not match trackingNumber');
      }

      if (order.status === OrderStatus.delivered) {
        throw new Error('Order has already been delivered');
      }
      if (order.status === OrderStatus.returned) {
        throw new Error('Order has been returned');
      }

      const activeStop = await tx.stop.findFirst({
        where: {
          orderId: order.id,
          status: { in: ACTIVE_STOP_STATUSES },
        },
      });
      if (activeStop) {
        throw new Error(
          'Order is already on an active manifest stop. Complete or fail it before reassigning.'
        );
      }

      const onSameManifest = await tx.stop.findFirst({
        where: {
          manifestId: manifest.id,
          orderId: order.id,
        },
      });
      if (onSameManifest) {
        throw new Error('Order is already on this manifest');
      }

      await tx.order.update({
        where: { id: order.id },
        data: {
          assignedManifestId: manifest.id,
          status: OrderStatus.assigned,
        },
      });

      const stopCount = await tx.stop.count({
        where: { manifestId: manifest.id },
      });
      const seq = sequence ?? stopCount + 1;

      return tx.stop.create({
        data: {
          stopId: visitStopId,
          manifestId: manifest.id,
          orderId: order.id,
          sequence: seq,
          status: StopStatus.pending,
          distance: 0,
          eta: '',
          attemptCount: 0,
          maxAttempts: 3,
        },
        include: stopInclude,
      });
    });

    await syncManifestCounters(manifest.id);

    res.status(201).json({ stop });
  } catch (err) {
    if (err instanceof Error) {
      if (err.message === 'ORDER_NOT_FOUND') {
        res.status(404).json({ error: 'Order not found' });
        return;
      }
      if (
        err.message.includes('already on') ||
        err.message.includes('already been delivered') ||
        err.message.includes('has been returned') ||
        err.message.includes('does not match')
      ) {
        res.status(409).json({ error: err.message });
        return;
      }
    }

    console.error('[Admin Stops] Create error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const stopParam = req.params.id;
    if (typeof stopParam !== 'string') {
      res.status(400).json({ error: 'Invalid stop id' });
      return;
    }

    const { sequence, status, distance, eta, attemptCount } = req.body;

    const found = await findStopByParam(stopParam);
    if (!found) {
      res.status(404).json({ error: 'Stop not found' });
      return;
    }

    if (status !== undefined && !isStopStatus(status)) {
      res.status(400).json({ error: 'Invalid status' });
      return;
    }

    const existing = await prisma.stop.findUniqueOrThrow({
      where: { id: found.id },
      select: {
        id: true,
        orderId: true,
        manifestId: true,
        status: true,
      },
    });

    const stop = await prisma.stop.update({
      where: { id: found.id },
      data: {
        ...(sequence !== undefined && { sequence }),
        ...(status !== undefined && { status }),
        ...(distance !== undefined && { distance }),
        ...(eta !== undefined && { eta }),
        ...(attemptCount !== undefined && { attemptCount }),
      },
      include: stopInclude,
    });

    if (status !== undefined && status !== existing.status) {
      if (!existing.orderId) {
        res.status(500).json({ error: 'Stop has no linked order' });
        return;
      }
      await syncManifestCounters(existing.manifestId);
      await syncOrderFromStopStatus(existing.orderId, status);
    }

    res.json({ stop });
  } catch (err) {
    console.error('[Admin Stops] Update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const stopParam = req.params.id;
    if (typeof stopParam !== 'string') {
      res.status(400).json({ error: 'Invalid stop id' });
      return;
    }

    const found = await findStopByParam(stopParam);
    if (!found) {
      res.status(404).json({ error: 'Stop not found' });
      return;
    }

    const stop = await prisma.stop.findUniqueOrThrow({
      where: { id: found.id },
      select: {
        id: true,
        orderId: true,
        manifestId: true,
        status: true,
      },
    });

    const { orderId, manifestId, status: stopStatus } = stop;
    if (!orderId) {
      res.status(500).json({ error: 'Stop has no linked order' });
      return;
    }

    const wasActive =
      stopStatus === StopStatus.pending ||
      stopStatus === StopStatus.in_progress;

    await prisma.$transaction(async (tx) => {
      await tx.stop.delete({ where: { id: found.id } });

      if (wasActive) {
        const order = await tx.order.findUnique({ where: { id: orderId } });
        if (order?.assignedManifestId === manifestId) {
          await tx.order.update({
            where: { id: orderId },
            data: {
              assignedManifestId: null,
              status: OrderStatus.available,
            },
          });
        }
      }
    });

    await syncManifestCounters(manifestId);

    res.json({ message: 'Stop deleted' });
  } catch (err) {
    console.error('[Admin Stops] Delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
