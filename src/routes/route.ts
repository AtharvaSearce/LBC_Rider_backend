import { Router, Request, Response } from 'express';
import { Prisma, StopStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import logger from '../utils/logger';

const router = Router();

const ROUTES_API_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const FLEET_ROUTING_URL = 'https://cloudfleetrouting.googleapis.com/v1';

const TERMINAL_STATUSES: StopStatus[] = [
  StopStatus.completed,
  StopStatus.rts,
  StopStatus.reschedule,
];

const stopWithOrderInclude = {
  order: {
    select: {
      addressLat: true,
      addressLng: true,
    },
  },
} as const;

type StopWithOrder = Prisma.StopGetPayload<{
  include: typeof stopWithOrderInclude;
}>;

async function findManifestByParam(manifestParam: string) {
  return prisma.manifest.findFirst({
    where: {
      OR: [{ id: manifestParam }, { manifestId: manifestParam }],
    },
  });
}

async function countTerminalStops(manifestDbId: string) {
  return prisma.stop.count({
    where: {
      manifestId: manifestDbId,
      status: { in: TERMINAL_STATUSES },
    },
  });
}

router.post('/optimize', async (req: Request, res: Response) => {
  try {
    const { manifestId: manifestParam, priorityStopId } = req.body;
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    const projectId = process.env.GCP_PROJECT_ID;

    if (!apiKey || !projectId) {
      res.status(500).json({ error: 'GCP configuration missing' });
      return;
    }

    const manifest = await findManifestByParam(manifestParam);
    if (!manifest) {
      res.status(404).json({ error: 'Manifest not found' });
      return;
    }

    const primaryStops = await prisma.stop.findMany({
      where: {
        manifestId: manifest.id,
        status: { in: [StopStatus.pending, StopStatus.in_progress] },
      },
      orderBy: { sequence: 'asc' },
      include: stopWithOrderInclude,
    });

    const failedStopsRaw = await prisma.stop.findMany({
      where: {
        manifestId: manifest.id,
        status: StopStatus.failed,
      },
      orderBy: { sequence: 'asc' },
      include: stopWithOrderInclude,
    });

    const failedStops = failedStopsRaw.filter(
      (stop) => stop.attemptCount < stop.maxAttempts
    );

    const pendingStops: StopWithOrder[] = [...primaryStops, ...failedStops];

    if (pendingStops.length === 0) {
      res.json({ newOrder: [], message: 'No pending stops to optimize' });
      return;
    }

    const depotLocation = { latitude: 14.5547, longitude: 121.0244 };

    const shipments = pendingStops.map((stop) => ({
      deliveries: [
        {
          arrivalLocation: {
            latitude: stop.order.addressLat,
            longitude: stop.order.addressLng,
          },
          duration: '300s',
        },
      ],
      label: stop.stopId,
      ...(stop.stopId === priorityStopId ? { penalty_cost: 1000000 } : {}),
    }));

    const fleetBody = {
      model: {
        shipments,
        vehicles: [
          {
            startLocation: depotLocation,
            endLocation: depotLocation,
            costPerKilometer: 1.0,
            costPerHour: 1.0,
          },
        ],
        globalStartTime: new Date().toISOString(),
        globalEndTime: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
      },
      searchMode: 1,
    };

    try {
      const fleetResponse = await fetch(
        `${FLEET_ROUTING_URL}/projects/${projectId}:optimizeTours`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': apiKey,
          },
          body: JSON.stringify(fleetBody),
        }
      );

      const fleetData = (await fleetResponse.json()) as {
        routes?: { visits?: { shipmentIndex: number }[] }[];
      };

      if (fleetData.routes && fleetData.routes[0]?.visits) {
        const visits = fleetData.routes[0].visits;
        let newOrder: string[] = [];

        if (priorityStopId) {
          newOrder.push(priorityStopId);
          const otherVisits = visits
            .map((v) => shipments[v.shipmentIndex]?.label)
            .filter((label): label is string => !!label && label !== priorityStopId);
          newOrder = [...newOrder, ...otherVisits];
        } else {
          newOrder = visits
            .map((v) => shipments[v.shipmentIndex]?.label)
            .filter((label): label is string => Boolean(label));
        }

        const terminalCount = await countTerminalStops(manifest.id);

        for (let i = 0; i < newOrder.length; i++) {
          await prisma.stop.updateMany({
            where: { stopId: newOrder[i] },
            data: { sequence: terminalCount + i + 1 },
          });
        }

        logger.info('[Route] Optimized via Fleet Routing API', {
          manifestId: manifestParam,
          stopCount: newOrder.length,
          priorityStopId,
        });
        res.json({
          newOrder,
          message: priorityStopId
            ? `Route optimized with ${priorityStopId} prioritized first`
            : 'Route optimized for shortest path',
        });
        return;
      }
    } catch (fleetErr) {
      logger.warn('[Route] Fleet Routing API failed, using local optimization', { err: fleetErr });
    }

    let ordered = [...pendingStops];
    if (priorityStopId) {
      const priorityIdx = ordered.findIndex((s) => s.stopId === priorityStopId);
      if (priorityIdx > 0) {
        const [prioritized] = ordered.splice(priorityIdx, 1);
        ordered.unshift(prioritized);
      }
    }

    const terminalCount = await countTerminalStops(manifest.id);

    const newOrder: string[] = [];
    for (let i = 0; i < ordered.length; i++) {
      await prisma.stop.updateMany({
        where: { stopId: ordered[i].stopId },
        data: { sequence: terminalCount + i + 1 },
      });
      newOrder.push(ordered[i].stopId);
    }

    logger.info('[Route] Optimized', { manifestId: manifestParam, stopCount: pendingStops.length, priorityStopId });
    res.json({
      newOrder,
      message: priorityStopId
        ? `Route reordered with ${priorityStopId} prioritized first (local optimization)`
        : 'Route reordered (local optimization)',
    });
  } catch (err) {
    logger.error('[Route] Optimize error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/compute', async (req: Request, res: Response) => {
  try {
    const { origin, destination } = req.body;
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;

    if (!apiKey) {
      res.status(500).json({ error: 'Google Maps API key not configured' });
      return;
    }

    if (!origin?.lat || !origin?.lng || !destination?.lat || !destination?.lng) {
      res.status(400).json({ error: 'Origin and destination with lat/lng are required' });
      return;
    }

    const body = {
      origin: {
        location: {
          latLng: { latitude: origin.lat, longitude: origin.lng },
        },
      },
      destination: {
        location: {
          latLng: { latitude: destination.lat, longitude: destination.lng },
        },
      },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
      computeAlternativeRoutes: false,
      languageCode: 'en-US',
    };

    const response = await fetch(ROUTES_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask':
          'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline',
      },
      body: JSON.stringify(body),
    });

    const data = (await response.json()) as {
      routes?: {
        duration?: string;
        distanceMeters?: number;
        polyline?: { encodedPolyline?: string };
      }[];
    };

    if (data.routes && data.routes.length > 0) {
      const route = data.routes[0];
      const durationSeconds = parseInt(route.duration?.replace('s', '') || '0', 10);
      const distanceMeters = route.distanceMeters || 0;

      const etaMinutes = Math.ceil(durationSeconds / 60);
      const eta =
        etaMinutes < 60
          ? `${etaMinutes} min`
          : `${Math.floor(etaMinutes / 60)}h ${etaMinutes % 60}m`;

      res.json({
        encodedPolyline: route.polyline?.encodedPolyline || '',
        durationSeconds,
        distanceMeters,
        distanceKm: (distanceMeters / 1000).toFixed(1),
        eta,
      });
    } else {
      res.status(404).json({ error: 'No route found', details: data });
    }
  } catch (err) {
    logger.error('[Route] Compute error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/directions', async (req: Request, res: Response) => {
  try {
    const { origin, destination, waypoints } = req.body;
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;

    if (!apiKey) {
      res.status(500).json({ error: 'Google Maps API key not configured' });
      return;
    }

    const intermediates = (waypoints || []).map((wp: { lat: number; lng: number }) => ({
      location: {
        latLng: { latitude: wp.lat, longitude: wp.lng },
      },
    }));

    const body: Record<string, unknown> = {
      origin: {
        location: {
          latLng: { latitude: origin.lat, longitude: origin.lng },
        },
      },
      destination: {
        location: {
          latLng: { latitude: destination.lat, longitude: destination.lng },
        },
      },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
      languageCode: 'en-US',
    };

    if (intermediates.length > 0) {
      body.intermediates = intermediates;
    }

    const response = await fetch(ROUTES_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask':
          'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    logger.error('[Route] Directions error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/reorder', async (req: Request, res: Response) => {
  try {
    const { manifestId: manifestParam, stopOrder } = req.body;

    if (!manifestParam || !Array.isArray(stopOrder) || stopOrder.length === 0) {
      res.status(400).json({ error: 'manifestId and stopOrder (array of stopIds) are required' });
      return;
    }

    const manifest = await findManifestByParam(manifestParam);
    if (!manifest) {
      res.status(404).json({ error: 'Manifest not found' });
      return;
    }

    const terminalCount = await countTerminalStops(manifest.id);

    const reorderableStops = await prisma.stop.findMany({
      where: {
        manifestId: manifest.id,
        status: { notIn: TERMINAL_STATUSES },
      },
      select: { id: true, stopId: true },
    });

    const stopIdToDbId = new Map(reorderableStops.map((s) => [s.stopId, s.id]));

    await prisma.$transaction(async (tx) => {
      for (const stop of reorderableStops) {
        await tx.stop.update({
          where: { id: stop.id },
          data: { sequence: 10000 + Math.random() * 89999, status: StopStatus.pending },
        });
      }

      let firstAssigned = false;
      for (let i = 0; i < stopOrder.length; i++) {
        const dbId = stopIdToDbId.get(stopOrder[i] as string);
        if (!dbId) continue;

        const data: Prisma.StopUpdateInput = {
          sequence: terminalCount + i + 1,
        };
        if (!firstAssigned) {
          data.status = StopStatus.in_progress;
          firstAssigned = true;
        }

        await tx.stop.update({ where: { id: dbId }, data });
      }
    }, { timeout: 15000 });

    logger.info('[Route] Reordered', { manifestId: manifestParam, stopCount: stopOrder.length });
    res.json({
      message: 'Stop order updated successfully',
      stopOrder,
    });
  } catch (err) {
    logger.error('[Route] Reorder error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
