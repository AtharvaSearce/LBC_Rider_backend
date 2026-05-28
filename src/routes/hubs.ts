import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';

const router = Router();

const zoneSelect = {
  select: { id: true, name: true },
};

function getHubId(req: Request): string | null {
  const { id } = req.params;
  return typeof id === 'string' ? id : null;
}

router.get('/', async (_req: Request, res: Response) => {
  try {
    const hubs = await prisma.hub.findMany({
      include: { zone: zoneSelect },
      orderBy: { name: 'asc' },
    });

    res.json({ hubs, total: hubs.length });
  } catch (err) {
    console.error('[Admin Hubs] List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, lat, lng, zoneId, radiusMeters } = req.body;

    if (!name || lat === undefined || lng === undefined || !zoneId) {
      res.status(400).json({
        error: 'Missing required fields: name, lat, lng, zoneId',
      });
      return;
    }

    const zone = await prisma.zone.findUnique({ where: { id: zoneId } });
    if (!zone) {
      res.status(404).json({ error: 'Zone not found' });
      return;
    }

    const existing = await prisma.hub.findUnique({ where: { name } });
    if (existing) {
      res.status(409).json({ error: `Hub "${name}" already exists` });
      return;
    }

    const hub = await prisma.hub.create({
      data: {
        name,
        lat: Number(lat),
        lng: Number(lng),
        zoneId,
        ...(radiusMeters !== undefined && { radiusMeters: Number(radiusMeters) }),
      },
      include: { zone: zoneSelect },
    });

    res.status(201).json({ hub });
  } catch (err) {
    console.error('[Admin Hubs] Create error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const hubId = getHubId(req);
    if (!hubId) {
      res.status(400).json({ error: 'Invalid hub id' });
      return;
    }

    const { name, lat, lng, zoneId, radiusMeters } = req.body;

    const existing = await prisma.hub.findUnique({ where: { id: hubId } });
    if (!existing) {
      res.status(404).json({ error: 'Hub not found' });
      return;
    }

    if (name && name !== existing.name) {
      const duplicate = await prisma.hub.findUnique({ where: { name } });
      if (duplicate) {
        res.status(409).json({ error: `Hub "${name}" already exists` });
        return;
      }
    }

    if (zoneId !== undefined) {
      const zone = await prisma.zone.findUnique({ where: { id: zoneId } });
      if (!zone) {
        res.status(404).json({ error: 'Zone not found' });
        return;
      }
    }

    const hub = await prisma.hub.update({
      where: { id: hubId },
      data: {
        ...(name !== undefined && { name }),
        ...(lat !== undefined && { lat: Number(lat) }),
        ...(lng !== undefined && { lng: Number(lng) }),
        ...(zoneId !== undefined && { zoneId }),
        ...(radiusMeters !== undefined && { radiusMeters: Number(radiusMeters) }),
      },
      include: { zone: zoneSelect },
    });

    res.json({ hub });
  } catch (err) {
    console.error('[Admin Hubs] Update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const hubId = getHubId(req);
    if (!hubId) {
      res.status(400).json({ error: 'Invalid hub id' });
      return;
    }

    const existing = await prisma.hub.findUnique({
      where: { id: hubId },
      include: {
        _count: { select: { riders: true, orders: true } },
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Hub not found' });
      return;
    }

    if (existing._count.riders > 0 || existing._count.orders > 0) {
      res.status(409).json({
        error: 'Cannot delete hub while riders or orders are assigned to it',
      });
      return;
    }

    await prisma.hub.delete({ where: { id: hubId } });

    res.json({ message: 'Hub deleted successfully' });
  } catch (err) {
    console.error('[Admin Hubs] Delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
