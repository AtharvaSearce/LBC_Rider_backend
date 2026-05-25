import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { formatManifestResponse } from '../utils/manifestResponse';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    const riderId = req.rider?.riderId;
    if (!riderId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    let manifest = await prisma.manifest.findFirst({
      where: {
        riderId,
        date: { gte: today, lt: tomorrow },
      },
      include: {
        rider: true,
        stops: { orderBy: { sequence: 'asc' } },
      },
    });

    if (!manifest) {
      manifest = await prisma.manifest.findFirst({
        where: { riderId },
        orderBy: { date: 'desc' },
        include: {
          rider: true,
          stops: { orderBy: { sequence: 'asc' } },
        },
      });
    }

    if (!manifest) {
      res.status(404).json({ error: 'No manifest found for today' });
      return;
    }

    res.json(formatManifestResponse(manifest));
  } catch (err) {
    console.error('[Manifest] Get error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
