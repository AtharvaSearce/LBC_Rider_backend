import { Router, Request, Response } from 'express';
import {
  ManifestStatus,
  OrderStatus,
  StopStatus,
} from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../lib/prisma';
import logger from '../utils/logger';

const router = Router();

const FAILED_STOP_STATUSES: StopStatus[] = [
  StopStatus.failed,
  StopStatus.rts,
  StopStatus.reschedule,
];

const manifestWithStopsInclude = {
  stops: {
    orderBy: { sequence: 'asc' as const },
    include: {
      order: {
        include: {
          hub: {
            select: {
              id: true,
              name: true,
              zone: { select: { id: true, name: true } },
            },
          },
        },
      },
      deliveryResult: true,
    },
  },
} as const;

function generateStopId(): string {
  return `stop-${uuidv4().slice(0, 8)}`;
}

function getParamString(value: string | string[]): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

function formatOrderForScan(order: {
  id: string;
  trackingNumber: string;
  recipientName: string;
  recipientPhone: string;
  recipientField: string;
  addressText: string;
  addressLat: number;
  addressLng: number;
  addressGeocoded: boolean;
  serviceType: string;
  codAmount: { toString(): string };
  packageDetails: string;
  specialInstructions: string;
  status: OrderStatus;
  assignedManifestId: string | null;
  hub: { name: string; zone: { name: string } };
}) {
  return {
    _id: order.id,
    id: order.id,
    trackingNumber: order.trackingNumber,
    recipient: {
      name: order.recipientName,
      phone: order.recipientPhone,
      field: order.recipientField,
    },
    address: {
      text: order.addressText,
      lat: order.addressLat,
      lng: order.addressLng,
      geocoded: order.addressGeocoded,
    },
    serviceType: order.serviceType,
    codAmount: Number(order.codAmount),
    packageDetails: order.packageDetails,
    specialInstructions: order.specialInstructions,
    hub: order.hub.name,
    zone: order.hub.zone.name,
    status: order.status,
    assignedManifestId: order.assignedManifestId,
  };
}

router.post('/cleanup', async (req: Request, res: Response) => {
  try {
    const riderId = req.rider?.riderId;
    if (!riderId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);

    const staleManifests = await prisma.manifest.findMany({
      where: {
        riderId,
        status: { in: [ManifestStatus.pending, ManifestStatus.in_progress] },
        createdAt: { lt: todayMidnight },
      },
    });

    let cleaned = 0;
    for (const manifest of staleManifests) {
      const stops = await prisma.stop.findMany({
        where: { manifestId: manifest.id },
      });

      for (const stop of stops) {
        if (stop.status !== StopStatus.completed) {
          await prisma.stop.update({
            where: { id: stop.id },
            data: { status: StopStatus.reschedule },
          });

          await prisma.order.update({
            where: { id: stop.orderId },
            data: {
              status: OrderStatus.available,
              assignedManifestId: null,
            },
          });
        }
      }

      const updatedStops = await prisma.stop.findMany({
        where: { manifestId: manifest.id },
        select: { status: true },
      });

      await prisma.manifest.update({
        where: { id: manifest.id },
        data: {
          status: ManifestStatus.completed,
          failedStops: updatedStops.filter((s) =>
            FAILED_STOP_STATUSES.includes(s.status)
          ).length,
        },
      });

      cleaned++;
    }

    res.json({ cleaned });
  } catch (err) {
    logger.error('[Manifest] Cleanup error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/history', async (req: Request, res: Response) => {
  try {
    const riderId = req.rider?.riderId;
    if (!riderId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const manifests = await prisma.manifest.findMany({
      where: { riderId },
      orderBy: { date: 'desc' },
      select: {
        manifestId: true,
        date: true,
        status: true,
        totalStops: true,
        completedStops: true,
        failedStops: true,
        createdAt: true,
      },
    });

    res.json({ manifests });
  } catch (err) {
    logger.error('[Manifest] History error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/scan/:trackingNumber', async (req: Request, res: Response) => {
  try {
    const riderId = req.rider?.riderId;
    if (!riderId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const trackingNumber = getParamString(req.params.trackingNumber);
    if (!trackingNumber) {
      res.status(400).json({ error: 'Invalid tracking number' });
      return;
    }

    const order = await prisma.order.findUnique({
      where: { trackingNumber },
      include: {
        hub: { select: { name: true, zone: { select: { name: true } } } },
      },
    });

    if (!order) {
      res.status(404).json({
        error: `Order with tracking number ${trackingNumber} not found`,
      });
      return;
    }

    if (order.status !== OrderStatus.available) {
      res.status(409).json({
        error: `Order ${trackingNumber} is already ${order.status}`,
        status: order.status,
        assignedManifestId: order.assignedManifestId,
      });
      return;
    }

    res.json(formatOrderForScan(order));
  } catch (err) {
    logger.error('[Manifest] Scan lookup error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/create', async (req: Request, res: Response) => {
  try {
    const riderId = req.rider?.riderId;
    if (!riderId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { orderIds } = req.body;
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      res.status(400).json({ error: 'orderIds must be a non-empty array' });
      return;
    }

    const orders = await prisma.order.findMany({
      where: { id: { in: orderIds as string[] } },
    });

    if (orders.length !== orderIds.length) {
      res.status(400).json({ error: 'Some order IDs were not found' });
      return;
    }

    const unavailable = orders.filter((o) => o.status !== OrderStatus.available);
    if (unavailable.length > 0) {
      res.status(409).json({
        error: 'Some orders are not available',
        unavailable: unavailable.map((o) => ({
          trackingNumber: o.trackingNumber,
          status: o.status,
        })),
      });
      return;
    }

    const today = new Date();
    today.setHours(8, 0, 0, 0);
    const businessManifestId = `DDR-${today.toISOString().slice(0, 10).replace(/-/g, '')}-${uuidv4().slice(0, 4)}`;

    const populatedManifest = await prisma.$transaction(async (tx) => {
      const manifest = await tx.manifest.create({
        data: {
          manifestId: businessManifestId,
          riderId,
          date: today,
          status: ManifestStatus.in_progress,
          totalStops: orders.length,
          completedStops: 0,
          failedStops: 0,
        },
      });

      for (let i = 0; i < orders.length; i++) {
        const order = orders[i];

        await tx.stop.create({
          data: {
            stopId: generateStopId(),
            manifestId: manifest.id,
            orderId: order.id,
            sequence: i + 1,
            status: i === 0 ? StopStatus.in_progress : StopStatus.pending,
            distance: 0,
            eta: '',
            attemptCount: 0,
            maxAttempts: 3,
          },
        });

        await tx.order.update({
          where: { id: order.id },
          data: {
            status: OrderStatus.assigned,
            assignedManifestId: manifest.id,
          },
        });
      }

      return tx.manifest.findUniqueOrThrow({
        where: { id: manifest.id },
        include: manifestWithStopsInclude,
      });
    });

    logger.info('[Manifest] Created manifest', { manifestId: businessManifestId, riderId, stopCount: orders.length });
    res.status(201).json(populatedManifest);
  } catch (err) {
    logger.error('[Manifest] Create error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/sync', async (req: Request, res: Response) => {
  try {
    const riderId = req.rider?.riderId;
    if (!riderId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: 'Google Maps API key not configured' });
      return;
    }

    const ungeocoded = await prisma.order.findMany({
      where: { addressGeocoded: false },
    });

    let geocodedCount = 0;
    for (const order of ungeocoded) {
      if (!order.addressText) continue;

      try {
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(order.addressText)}&key=${apiKey}`;
        const response = await fetch(url);
        const data = (await response.json()) as {
          status: string;
          results: { geometry: { location: { lat: number; lng: number } } }[];
        };

        if (data.status === 'OK' && data.results.length > 0) {
          const location = data.results[0].geometry.location;
          await prisma.order.update({
            where: { id: order.id },
            data: {
              addressLat: location.lat,
              addressLng: location.lng,
              addressGeocoded: true,
            },
          });
          geocodedCount++;
        }
      } catch (geocodeErr) {
        logger.error('[Manifest] Geocode failed for order', {
          trackingNumber: order.trackingNumber,
          err: geocodeErr,
        });
      }
    }

    res.json({
      message: `Synced ${geocodedCount} of ${ungeocoded.length} addresses`,
      geocodedCount,
      totalUngeocoded: ungeocoded.length,
    });
  } catch (err) {
    logger.error('[Manifest] Sync error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/stop/:stopId', async (req: Request, res: Response) => {
  try {
    const stopId = getParamString(req.params.stopId);
    if (!stopId) {
      res.status(400).json({ error: 'Invalid stop id' });
      return;
    }

    const stop = await prisma.stop.findUnique({
      where: { stopId },
      include: {
        order: {
          include: {
            hub: {
              select: {
                id: true,
                name: true,
                zone: { select: { id: true, name: true } },
              },
            },
          },
        },
        deliveryResult: true,
      },
    });

    if (!stop) {
      res.status(404).json({ error: 'Stop not found' });
      return;
    }

    res.json(stop);
  } catch (err) {
    logger.error('[Manifest] Get stop error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/stop/:stopId', async (req: Request, res: Response) => {
  try {
    const riderId = req.rider?.riderId;
    if (!riderId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const stopId = getParamString(req.params.stopId);
    if (!stopId) {
      res.status(400).json({ error: 'Invalid stop id' });
      return;
    }

    const stop = await prisma.stop.findUnique({
      where: { stopId },
      include: { manifest: true },
    });

    if (!stop) {
      res.status(404).json({ error: 'Stop not found' });
      return;
    }

    if (stop.status === StopStatus.completed) {
      res.status(409).json({ error: 'Cannot remove a completed stop' });
      return;
    }

    const manifest = stop.manifest;
    if (!manifest) {
      res.status(404).json({ error: 'Manifest not found' });
      return;
    }

    if (manifest.riderId !== riderId) {
      res.status(403).json({ error: 'Not your manifest' });
      return;
    }

    const wasInProgress = stop.status === StopStatus.in_progress;

    const populatedManifest = await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: stop.orderId },
        data: {
          status: OrderStatus.available,
          assignedManifestId: null,
        },
      });

      await tx.stop.delete({ where: { id: stop.id } });

      const remainingStops = await tx.stop.findMany({
        where: { manifestId: manifest.id },
        orderBy: { sequence: 'asc' },
      });

      for (let i = 0; i < remainingStops.length; i++) {
        const update: { sequence: number; status?: StopStatus } = {
          sequence: i + 1,
        };
        if (
          wasInProgress &&
          i === 0 &&
          remainingStops[i].status === StopStatus.pending
        ) {
          update.status = StopStatus.in_progress;
        }

        await tx.stop.update({
          where: { id: remainingStops[i].id },
          data: update,
        });
      }

      const refreshedStops = await tx.stop.findMany({
        where: { manifestId: manifest.id },
        select: { status: true },
      });

      await tx.manifest.update({
        where: { id: manifest.id },
        data: {
          totalStops: refreshedStops.length,
          completedStops: refreshedStops.filter(
            (s) => s.status === StopStatus.completed
          ).length,
          failedStops: refreshedStops.filter((s) =>
            FAILED_STOP_STATUSES.includes(s.status)
          ).length,
          ...(refreshedStops.length === 0 && {
            status: ManifestStatus.completed,
          }),
        },
      });

      return tx.manifest.findUniqueOrThrow({
        where: { id: manifest.id },
        include: manifestWithStopsInclude,
      });
    });

    res.json(populatedManifest);
  } catch (err) {
    logger.error('[Manifest] Delete stop error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/', async (req: Request, res: Response) => {
  try {
    const riderId = req.rider?.riderId;
    if (!riderId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);
    const tomorrowMidnight = new Date(todayMidnight);
    tomorrowMidnight.setDate(tomorrowMidnight.getDate() + 1);

    const manifest = await prisma.manifest.findFirst({
      where: {
        riderId,
        createdAt: { gte: todayMidnight, lt: tomorrowMidnight },
        status: { in: [ManifestStatus.pending, ManifestStatus.in_progress] },
      },
      include: manifestWithStopsInclude,
    });

    if (!manifest) {
      res.status(404).json({ error: 'No active manifest found for today' });
      return;
    }

    res.json(manifest);
  } catch (err) {
    logger.error('[Manifest] Get error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
