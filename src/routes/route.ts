import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import logger from '../utils/logger';
import {
  optimizeManifestRoute,
  parseGeoPoint,
  resequenceManifest,
} from '../services/route-optimization';

const router = Router();

const ROUTES_API_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

async function findManifestByParam(manifestParam: string) {
  return prisma.manifest.findFirst({
    where: {
      OR: [{ id: manifestParam }, { manifestId: manifestParam }],
    },
  });
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

    const originPoint = parseGeoPoint(origin);
    logger.info('[Route] Optimize start', {
      manifestId: manifestParam,
      receivedOrigin: origin ?? null,
      startSource: originPoint ? 'rider-location' : 'server-default',
      priorityStopId,
    });

    const result = await optimizeManifestRoute(manifest.id, {
      priorityStopId,
      origin,
    });

    logger.info('[Route] Optimized', {
      manifestId: manifestParam,
      stopCount: result.newOrder.length,
      priorityStopId,
      firstStopId: result.firstStopId,
    });

    res.json({
      newOrder: result.newOrder,
      firstStopId: result.firstStopId,
      message: result.message,
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
