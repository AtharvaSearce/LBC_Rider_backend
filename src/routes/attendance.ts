import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';

const router = Router();

export function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

router.post('/checkin', async (req: Request, res: Response) => {
  try {
    const riderId = req.rider?.riderId;
    if (!riderId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { lat, lng } = req.body;
    if (lat === undefined || lng === undefined) {
      res.status(400).json({ error: 'lat and lng are required' });
      return;
    }

    const rider = await prisma.rider.findUnique({
      where: { id: riderId },
      include: {
        hub: {
          select: {
            name: true,
            lat: true,
            lng: true,
            radiusMeters: true,
          },
        },
      },
    });

    if (!rider) {
      res.status(404).json({ error: 'Rider not found' });
      return;
    }

    const hub = rider.hub;
    if (!hub) {
      res.status(404).json({ error: 'No hub found for this rider' });
      return;
    }

    const distance = haversineDistance(
      Number(lat),
      Number(lng),
      hub.lat,
      hub.lng
    );

    if (distance > hub.radiusMeters) {
      res.status(403).json({
        error: 'Not within hub geofence',
        hub: { name: hub.name, lat: hub.lat, lng: hub.lng },
        distance: Math.round(distance),
        radiusMeters: hub.radiusMeters,
      });
      return;
    }

    res.json({
      success: true,
      hub: { name: hub.name, lat: hub.lat, lng: hub.lng },
      distance: Math.round(distance),
      checkedInAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Attendance] Check-in error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
