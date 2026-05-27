import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';

const router = Router();

const hubSelect = {
  select: { id: true, name: true },
  orderBy: { name: 'asc' as const },
};

function getZoneId(req: Request): string | null {
  const { id } = req.params;
  return typeof id === 'string' ? id : null;
}

router.get('/', async (_req: Request, res: Response) => {
  try {
    const zones = await prisma.zone.findMany({
      include: { hubs: hubSelect },
      orderBy: { name: 'asc' },
    });

    res.json({ zones, total: zones.length });
  } catch (err) {
    console.error('[Admin Zones] List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const { name } = req.body;

    if (!name) {
      res.status(400).json({ error: 'Missing required field: name' });
      return;
    }

    const existing = await prisma.zone.findUnique({ where: { name } });
    if (existing) {
      res.status(409).json({ error: `Zone "${name}" already exists` });
      return;
    }

    const zone = await prisma.zone.create({
      data: { name },
      include: {
        hubs: {
          select: { id: true, name: true },
        },
      },
    });

    res.status(201).json({ zone });
  } catch (err) {
    console.error('[Admin Zones] Create error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const zoneId = getZoneId(req);
    if (!zoneId) {
      res.status(400).json({ error: 'Invalid zone id' });
      return;
    }

    const { name } = req.body;

    const existing = await prisma.zone.findUnique({ where: { id: zoneId } });
    if (!existing) {
      res.status(404).json({ error: 'Zone not found' });
      return;
    }

    if (name && name !== existing.name) {
      const duplicate = await prisma.zone.findUnique({ where: { name } });
      if (duplicate) {
        res.status(409).json({ error: `Zone "${name}" already exists` });
        return;
      }
    }

    const zone = await prisma.zone.update({
      where: { id: zoneId },
      data: { ...(name !== undefined && { name }) },
      include: { hubs: hubSelect },
    });

    res.json({ zone });
  } catch (err) {
    console.error('[Admin Zones] Update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const zoneId = getZoneId(req);
    if (!zoneId) {
      res.status(400).json({ error: 'Invalid zone id' });
      return;
    }

    const existing = await prisma.zone.findUnique({
      where: { id: zoneId },
      include: { _count: { select: { hubs: true } } },
    });
    if (!existing) {
      res.status(404).json({ error: 'Zone not found' });
      return;
    }

    if (existing._count.hubs > 0) {
      res.status(409).json({
        error: 'Cannot delete zone while hubs are assigned to it',
      });
      return;
    }

    await prisma.zone.delete({ where: { id: zoneId } });

    res.json({ message: 'Zone deleted successfully' });
  } catch (err) {
    console.error('[Admin Zones] Delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
