import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { signRiderToken } from '../middleware/rider-auth';

const router = Router();

const riderLoginSelect = {
  id: true,
  employeeId: true,
  name: true,
  email: true,
  phone: true,
  hubId: true,
  vehicleType: true,
  isActive: true,
  passwordHash: true,
  hub: {
    select: {
      id: true,
      name: true,
      zone: { select: { id: true, name: true } },
    },
  },
} as const;

router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const normalizedEmail = String(email).toLowerCase().trim();

    const rider = await prisma.rider.findUnique({
      where: { email: normalizedEmail },
      select: riderLoginSelect,
    });

    if (!rider) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const isMatch = await bcrypt.compare(password, rider.passwordHash);
    if (!isMatch) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    if (!rider.isActive) {
      res.status(403).json({ error: 'Account is deactivated' });
      return;
    }

    let token: string;
    try {
      token = signRiderToken({
        riderId: rider.id,
        employeeId: rider.employeeId,
        hubId: rider.hubId,
      });
    } catch {
      console.error('[Rider Auth] JWT_SECRET is not configured');
      res.status(500).json({ error: 'Internal server error' });
      return;
    }

    const { passwordHash: _passwordHash, ...riderPublic } = rider;

    res.json({
      token,
      rider: riderPublic,
    });
  } catch (err) {
    console.error('[Rider Auth] Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const rider = req.rider;
    if (!rider) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const existing = await prisma.rider.findUnique({
      where: { id: rider.riderId },
      select: { isActive: true },
    });

    if (!existing) {
      res.status(404).json({ error: 'Rider not found' });
      return;
    }

    if (!existing.isActive) {
      res.status(403).json({ error: 'Account is deactivated' });
      return;
    }

    let token: string;
    try {
      token = signRiderToken({
        riderId: rider.riderId,
        employeeId: rider.employeeId,
        hubId: rider.hubId,
      });
    } catch {
      console.error('[Rider Auth] JWT_SECRET is not configured');
      res.status(500).json({ error: 'Internal server error' });
      return;
    }

    res.json({ token });
  } catch (err) {
    console.error('[Rider Auth] Refresh error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
