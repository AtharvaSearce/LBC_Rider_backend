import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

const router = Router();

const riderPublicSelect = {
  id: true,
  employeeId: true,
  name: true,
  email: true,
  phone: true,
  hubId: true,
  vehicleType: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  hub: {
    select: {
      id: true,
      name: true,
      zone: { select: { id: true, name: true } },
    },
  },
} as const;

const recentManifestSelect = {
  id: true,
  manifestId: true,
  date: true,
  status: true,
  totalStops: true,
  completedStops: true,
  failedStops: true,
  createdAt: true,
} satisfies Prisma.ManifestSelect;

function queryString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function getRiderId(req: Request): string | null {
  const { id } = req.params;
  return typeof id === 'string' ? id : null;
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const search = queryString(req.query.search);
    const hubId = queryString(req.query.hubId);
    const status = queryString(req.query.status);

    const where: Prisma.RiderWhereInput = {};

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { employeeId: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (hubId) {
      where.hubId = hubId;
    }

    if (status === 'active') {
      where.isActive = true;
    } else if (status === 'inactive') {
      where.isActive = false;
    }

    const riders = await prisma.rider.findMany({
      where,
      select: riderPublicSelect,
      orderBy: { createdAt: 'desc' },
    });

    res.json({ riders, total: riders.length });
  } catch (err) {
    console.error('[Admin Riders] List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const riderId = getRiderId(req);
    if (!riderId) {
      res.status(400).json({ error: 'Invalid rider id' });
      return;
    }

    const rider = await prisma.rider.findUnique({
      where: { id: riderId },
      select: riderPublicSelect,
    });

    if (!rider) {
      res.status(404).json({ error: 'Rider not found' });
      return;
    }

    const recentManifests = await prisma.manifest.findMany({
      where: { riderId },
      select: recentManifestSelect,
      orderBy: { date: 'desc' },
      take: 10,
    });

    res.json({ rider, recentManifests });
  } catch (err) {
    console.error('[Admin Riders] Get error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const { employeeId, name, email, phone, password, hubId, vehicleType } =
      req.body;

    if (!employeeId || !name || !email || !phone || !password || !hubId) {
      res.status(400).json({
        error: 'employeeId, name, email, phone, password, and hubId are required',
      });
      return;
    }

    const hub = await prisma.hub.findUnique({ where: { id: hubId } });
    if (!hub) {
      res.status(404).json({ error: 'Hub not found' });
      return;
    }

    const normalizedEmail = String(email).toLowerCase().trim();

    const existing = await prisma.rider.findFirst({
      where: {
        OR: [{ email: normalizedEmail }, { employeeId }],
      },
    });

    if (existing) {
      res.status(409).json({
        error: 'Rider with this email or employee ID already exists',
      });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const rider = await prisma.rider.create({
      data: {
        employeeId,
        name,
        email: normalizedEmail,
        phone,
        passwordHash,
        hubId,
        vehicleType: vehicleType ?? 'motorcycle',
        isActive: true,
      },
      select: riderPublicSelect,
    });

    res.status(201).json({ rider });
  } catch (err) {
    console.error('[Admin Riders] Create error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const riderId = getRiderId(req);
    if (!riderId) {
      res.status(400).json({ error: 'Invalid rider id' });
      return;
    }

    const { name, email, phone, hubId, vehicleType, isActive, password } =
      req.body;

    const existing = await prisma.rider.findUnique({ where: { id: riderId } });
    if (!existing) {
      res.status(404).json({ error: 'Rider not found' });
      return;
    }

    if (hubId !== undefined) {
      const hub = await prisma.hub.findUnique({ where: { id: hubId } });
      if (!hub) {
        res.status(404).json({ error: 'Hub not found' });
        return;
      }
    }

    if (email !== undefined) {
      const normalizedEmail = String(email).toLowerCase().trim();
      const duplicate = await prisma.rider.findFirst({
        where: {
          email: normalizedEmail,
          NOT: { id: riderId },
        },
      });

      if (duplicate) {
        res.status(409).json({ error: 'Rider with this email already exists' });
        return;
      }
    }

    const passwordHash = password
      ? await bcrypt.hash(password, 12)
      : undefined;

    const rider = await prisma.rider.update({
      where: { id: riderId },
      data: {
        ...(name !== undefined && { name }),
        ...(email !== undefined && {
          email: String(email).toLowerCase().trim(),
        }),
        ...(phone !== undefined && { phone }),
        ...(hubId !== undefined && { hubId }),
        ...(vehicleType !== undefined && { vehicleType }),
        ...(isActive !== undefined && { isActive }),
        ...(passwordHash && { passwordHash }),
      },
      select: riderPublicSelect,
    });

    res.json({ rider });
  } catch (err) {
    console.error('[Admin Riders] Update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const riderId = getRiderId(req);
    if (!riderId) {
      res.status(400).json({ error: 'Invalid rider id' });
      return;
    }

    const existing = await prisma.rider.findUnique({ where: { id: riderId } });
    if (!existing) {
      res.status(404).json({ error: 'Rider not found' });
      return;
    }

    const rider = await prisma.rider.update({
      where: { id: riderId },
      data: { isActive: false },
      select: riderPublicSelect,
    });

    res.json({ message: 'Rider deactivated', rider });
  } catch (err) {
    console.error('[Admin Riders] Delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
