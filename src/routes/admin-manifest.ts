import { Router, Request, Response } from 'express';
import { ManifestStatus, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

const router = Router();

const riderSummaryInclude = {
  select: {
    id: true,
    name: true,
    employeeId: true,
    phone: true,
    hub: {
      select: {
        id: true,
        name: true,
        zone: { select: { id: true, name: true } },
      },
    },
  },
} as const;

const riderDetailInclude = {
  select: {
    id: true,
    name: true,
    employeeId: true,
    email: true,
    phone: true,
    isActive: true,
    hub: {
      select: {
        id: true,
        name: true,
        zone: { select: { id: true, name: true } },
      },
    },
  },
} as const;

const manifestListInclude = {
  rider: riderSummaryInclude,
  _count: { select: { stops: true, assignedOrders: true } },
} as const;

const manifestDetailInclude = {
  rider: riderDetailInclude,
  stops: {
    orderBy: { sequence: 'asc' as const },
    include: {
      order: {
        select: {
          id: true,
          trackingNumber: true,
          stopId: true,
          recipientName: true,
          recipientPhone: true,
          addressText: true,
          addressLat: true,
          addressLng: true,
          serviceType: true,
          codAmount: true,
          status: true,
        },
      },
      deliveryResult: true,
    },
  },
  _count: { select: { stops: true, assignedOrders: true } },
} as const;

function queryString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function getManifestId(req: Request): string | null {
  const { id } = req.params;
  return typeof id === 'string' ? id : null;
}

function isManifestStatus(value: string): value is ManifestStatus {
  return Object.values(ManifestStatus).includes(value as ManifestStatus);
}

function parseDateRange(date: string) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  return { gte: start, lt: end };
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const status = queryString(req.query.status);
    const riderId = queryString(req.query.riderId);
    const date = queryString(req.query.date);
    const search = queryString(req.query.search);

    const where: Prisma.ManifestWhereInput = {};

    if (status && status !== 'all') {
      if (!isManifestStatus(status)) {
        res.status(400).json({ error: 'Invalid status filter' });
        return;
      }
      where.status = status;
    }

    if (riderId) {
      where.riderId = riderId;
    }

    if (date) {
      where.date = parseDateRange(date);
    }

    if (search) {
      where.manifestId = {
        contains: search,
        mode: 'insensitive',
      };
    }

    const manifests = await prisma.manifest.findMany({
      where,
      include: manifestListInclude,
      orderBy: { date: 'desc' },
    });

    res.json({ manifests, total: manifests.length });
  } catch (err) {
    console.error('[Admin Manifests] List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const manifestId = getManifestId(req);
    if (!manifestId) {
      res.status(400).json({ error: 'Invalid manifest id' });
      return;
    }

    const manifest = await prisma.manifest.findUnique({
      where: { id: manifestId },
      include: manifestDetailInclude,
    });

    if (!manifest) {
      res.status(404).json({ error: 'Manifest not found' });
      return;
    }

    res.json({ manifest });
  } catch (err) {
    console.error('[Admin Manifests] Get error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const { manifestId, riderId, date, totalStops } = req.body;

    if (!manifestId || !riderId || !date) {
      res.status(400).json({
        error: 'manifestId, riderId, and date are required',
      });
      return;
    }

    const rider = await prisma.rider.findUnique({ where: { id: riderId } });
    if (!rider) {
      res.status(404).json({ error: 'Rider not found' });
      return;
    }

    const existing = await prisma.manifest.findUnique({ where: { manifestId } });
    if (existing) {
      res.status(409).json({ error: 'Manifest with this ID already exists' });
      return;
    }

    const manifest = await prisma.manifest.create({
      data: {
        manifestId,
        riderId,
        date: new Date(date),
        status: ManifestStatus.pending,
        totalStops: totalStops ?? 0,
        completedStops: 0,
        failedStops: 0,
      },
      include: manifestListInclude,
    });

    res.status(201).json({ manifest });
  } catch (err) {
    console.error('[Admin Manifests] Create error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const manifestId = getManifestId(req);
    if (!manifestId) {
      res.status(400).json({ error: 'Invalid manifest id' });
      return;
    }

    const {
      riderId,
      status,
      date,
      totalStops,
      completedStops,
      failedStops,
    } = req.body;

    const existing = await prisma.manifest.findUnique({
      where: { id: manifestId },
    });

    if (!existing) {
      res.status(404).json({ error: 'Manifest not found' });
      return;
    }

    if (riderId !== undefined) {
      const rider = await prisma.rider.findUnique({ where: { id: riderId } });
      if (!rider) {
        res.status(404).json({ error: 'Rider not found' });
        return;
      }
    }

    if (status !== undefined && !isManifestStatus(status)) {
      res.status(400).json({ error: 'Invalid status' });
      return;
    }

    const manifest = await prisma.manifest.update({
      where: { id: manifestId },
      data: {
        ...(riderId !== undefined && { riderId }),
        ...(status !== undefined && { status }),
        ...(date !== undefined && { date: new Date(date) }),
        ...(totalStops !== undefined && { totalStops: Number(totalStops) }),
        ...(completedStops !== undefined && {
          completedStops: Number(completedStops),
        }),
        ...(failedStops !== undefined && { failedStops: Number(failedStops) }),
      },
      include: manifestListInclude,
    });

    res.json({ manifest });
  } catch (err) {
    console.error('[Admin Manifests] Update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const manifestId = getManifestId(req);
    if (!manifestId) {
      res.status(400).json({ error: 'Invalid manifest id' });
      return;
    }

    const existing = await prisma.manifest.findUnique({
      where: { id: manifestId },
    });

    if (!existing) {
      res.status(404).json({ error: 'Manifest not found' });
      return;
    }

    await prisma.manifest.delete({ where: { id: manifestId } });

    res.json({ message: 'Manifest deleted successfully' });
  } catch (err) {
    console.error('[Admin Manifests] Delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
