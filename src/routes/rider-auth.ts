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
  const t0 = Date.now();
  console.log('[Rider Auth] POST /login — email=%s', req.body?.email);
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      console.warn('[Rider Auth] Login rejected: missing email or password');
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    console.log('[Rider Auth] Looking up rider email=%s', normalizedEmail);

    const rider = await prisma.rider.findUnique({
      where: { email: normalizedEmail },
      select: riderLoginSelect,
    });

    if (!rider) {
      console.warn('[Rider Auth] No rider found for email=%s', normalizedEmail);
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    console.log('[Rider Auth] Found rider id=%s empId=%s hub=%s active=%s',
      rider.id, rider.employeeId, rider.hub?.name, rider.isActive);

    const isMatch = await bcrypt.compare(password, rider.passwordHash);
    if (!isMatch) {
      console.warn('[Rider Auth] Password mismatch for rider id=%s', rider.id);
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    if (!rider.isActive) {
      console.warn('[Rider Auth] Deactivated rider attempted login id=%s', rider.id);
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

    console.log('[Rider Auth] Login success id=%s empId=%s (%dms)',
      rider.id, rider.employeeId, Date.now() - t0);

    res.json({
      token,
      rider: riderPublic,
    });
  } catch (err) {
    console.error('[Rider Auth] Login error (%dms):', Date.now() - t0, err);
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
