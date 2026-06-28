import { Router, Request, Response } from 'express';
import { Prisma, StopStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import logger from '../utils/logger';
import { optimizeStopOrder, GeoPoint } from '../utils/geo';

const router = Router();

const ROUTES_API_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

const TERMINAL_STATUSES: StopStatus[] = [
  StopStatus.completed,
  StopStatus.rts,
  StopStatus.reschedule,
];

function parseGeoPoint(input: unknown): GeoPoint | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  const lat = obj.lat ?? obj.latitude;
  const lng = obj.lng ?? obj.longitude;
  if (typeof lat === 'number' && typeof lng === 'number') {
    return { latitude: lat, longitude: lng };
  }
  return null;
}

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

// Sequences are temporarily parked at this offset before final values are
// assigned, so we never transiently violate the unique (manifestId, sequence)
// index while shuffling stops around inside a transaction.
const SEQUENCE_PARK_OFFSET = 100000;

function isTerminalStatus(status: StopStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Renumber every stop in a manifest into a single contiguous 1..N sequence:
 *   - terminal stops (completed/rts/reschedule) keep their relative order up
 *     front and retain their status,
 *   - the active stops named by [orderedActiveStopIds] follow in that order,
 *     with the first one promoted to in_progress and the rest set to pending,
 *   - any remaining non-terminal stops (e.g. attempt-exhausted failed stops)
 *     trail behind in their existing order and keep their status.
 *
 * Because terminal stops may hold arbitrary sequence values (completion never
 * renumbers them), renumbering the whole manifest is the only collision-free
 * way to reorder. Runs inside the caller's transaction.
 */
async function resequenceManifest(
  tx: Prisma.TransactionClient,
  manifestDbId: string,
  orderedActiveStopIds: string[]
): Promise<string[]> {
  const allStops = await tx.stop.findMany({
    where: { manifestId: manifestDbId },
    orderBy: { sequence: 'asc' },
    select: { id: true, stopId: true, status: true },
  });

  const byStopId = new Map(allStops.map((s) => [s.stopId, s]));
  const activeSet = new Set(orderedActiveStopIds);

  const terminalStops = allStops.filter((s) => isTerminalStatus(s.status));

  const orderedActive = orderedActiveStopIds
    .map((sid) => byStopId.get(sid))
    .filter(
      (s): s is (typeof allStops)[number] =>
        !!s && !isTerminalStatus(s.status)
    );

  const leftover = allStops.filter(
    (s) => !isTerminalStatus(s.status) && !activeSet.has(s.stopId)
  );

  const finalOrder = [...terminalStops, ...orderedActive, ...leftover];

  // Phase 1: park everything we are about to renumber.
  for (let i = 0; i < finalOrder.length; i++) {
    await tx.stop.update({
      where: { id: finalOrder[i].id },
      data: { sequence: SEQUENCE_PARK_OFFSET + i },
    });
  }

  // Phase 2: assign contiguous sequences and reconcile active-stop statuses.
  const firstActiveId = orderedActive[0]?.id;
  for (let i = 0; i < finalOrder.length; i++) {
    const stop = finalOrder[i];
    const data: Prisma.StopUpdateInput = { sequence: i + 1 };
    if (!isTerminalStatus(stop.status) && activeSet.has(stop.stopId)) {
      data.status =
        stop.id === firstActiveId
          ? StopStatus.in_progress
          : StopStatus.pending;
    }
    await tx.stop.update({ where: { id: stop.id }, data });
  }

  return orderedActive.map((s) => s.stopId);
}

router.post('/optimize', async (req: Request, res: Response) => {
  try {
    const { manifestId: manifestParam, priorityStopId, origin } = req.body;
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

    // Determine the starting point for the optimisation:
    // 1. the rider's live location sent by the app, else
    // 2. the stop that is currently in progress, else
    // 3. the first stop in the existing sequence.
    const stopPoint = (stop: StopWithOrder): GeoPoint => ({
      latitude: stop.order.addressLat,
      longitude: stop.order.addressLng,
    });

    const inProgressStop = pendingStops.find(
      (s) => s.status === StopStatus.in_progress
    );
    const originPoint = parseGeoPoint(origin);
    const startPoint: GeoPoint =
      originPoint ??
      (inProgressStop ? stopPoint(inProgressStop) : stopPoint(pendingStops[0]));

    logger.info('[Route] Optimize start', {
      manifestId: manifestParam,
      receivedOrigin: origin ?? null,
      startSource: originPoint
        ? 'rider-location'
        : inProgressStop
          ? 'in-progress-stop'
          : 'first-stop',
      startPoint,
    });

    // Build the optimised order. A priority stop (if provided) is pinned to the
    // front and the remaining stops are optimised starting from that stop.
    let ordered: StopWithOrder[];
    const priorityStop = priorityStopId
      ? pendingStops.find((s) => s.stopId === priorityStopId)
      : undefined;

    if (priorityStop) {
      const rest = pendingStops.filter((s) => s.stopId !== priorityStop.stopId);
      const restOrder = optimizeStopOrder(
        stopPoint(priorityStop),
        rest.map(stopPoint)
      );
      ordered = [priorityStop, ...restOrder.map((idx) => rest[idx])];
    } else {
      const order = optimizeStopOrder(startPoint, pendingStops.map(stopPoint));
      ordered = order.map((idx) => pendingStops[idx]);
    }

    // Persist the new order: renumber the whole manifest contiguously and
    // promote the closest/first active stop to in_progress. Renumbering every
    // stop (not just the active ones) is required because completed stops keep
    // arbitrary sequence values, which would otherwise collide.
    await prisma.$transaction(
      async (tx) => {
        await resequenceManifest(
          tx,
          manifest.id,
          ordered.map((s) => s.stopId)
        );
      },
      { timeout: 15000 }
    );

    const newOrder = ordered.map((s) => s.stopId);

    logger.info('[Route] Optimized', {
      manifestId: manifestParam,
      stopCount: newOrder.length,
      priorityStopId,
      firstStopId: newOrder[0],
    });
    res.json({
      newOrder,
      firstStopId: newOrder[0],
      message: priorityStopId
        ? `Route optimized with ${priorityStopId} prioritized first`
        : 'Route optimized for shortest path',
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
      const durationSeconds = Number.parseInt(route.duration?.replace('s', '') || '0', 10);
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

    await prisma.$transaction(
      async (tx) => {
        await resequenceManifest(tx, manifest.id, stopOrder as string[]);
      },
      { timeout: 15000 }
    );

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
