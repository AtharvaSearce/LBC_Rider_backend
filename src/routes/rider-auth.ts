import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { signRiderToken } from '../middleware/rider-auth';
import logger from '../utils/logger';

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
  pinHash: true,
  pinVersion: true,
  hub: {
    select: {
      id: true,
      name: true,
      zone: { select: { id: true, name: true } },
    },
  },
} as const;

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Generates a SHA-256 verifier for the rider's PIN.
 * This verifier is sent to the client for offline PIN validation.
 * The client computes SHA-256(pin + salt) and compares the hex digest.
 */
function generatePinVerifier(pin: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHash('sha256').update(pin + salt).digest('hex');
  return { hash, salt };
}

// ─── POST /login ──────────────────────────────────────────────────────

router.post('/login', async (req: Request, res: Response) => {
  const t0 = Date.now();
  logger.info('[Rider Auth] POST /login', { email: req.body?.email });
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      logger.warn('[Rider Auth] Login rejected: missing email or password');
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    logger.debug('[Rider Auth] Looking up rider', { email: normalizedEmail });

    const rider = await prisma.rider.findUnique({
      where: { email: normalizedEmail },
      select: riderLoginSelect,
    });

    if (!rider) {
      logger.warn('[Rider Auth] No rider found', { email: normalizedEmail });
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    logger.debug('[Rider Auth] Found rider', {
      riderId: rider.id,
      employeeId: rider.employeeId,
      hub: rider.hub?.name,
      isActive: rider.isActive,
    });

    const isMatch = await bcrypt.compare(password, rider.passwordHash);
    if (!isMatch) {
      logger.warn('[Rider Auth] Password mismatch', { riderId: rider.id });
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    if (!rider.isActive) {
      logger.warn('[Rider Auth] Deactivated rider attempted login', { riderId: rider.id });
      res.status(403).json({ error: 'Account is deactivated' });
      return;
    }

    let token: string;
    try {
      token = signRiderToken({
        riderId: rider.id,
        employeeId: rider.employeeId,
        hubId: rider.hubId,
        pinVersion: rider.pinVersion,
      });
    } catch {
      logger.error('[Rider Auth] JWT_SECRET is not configured');
      res.status(500).json({ error: 'Internal server error' });
      return;
    }

    const { passwordHash: _passwordHash, pinHash: _pinHash, ...riderPublic } = rider;

    // Determine if PIN needs to be set up
    const pinRequired = !rider.pinHash;

    // Generate a fresh SHA-256 verifier if rider has a PIN
    // The client stores this for offline PIN validation
    let pinVerifier: { hash: string; salt: string } | null = null;
    if (rider.pinHash) {
      // We can't reverse the bcrypt hash to get the original PIN,
      // so we generate the verifier during PIN setup and store it.
      // For existing PINs, the client must already have a stored verifier.
      // On login, we only send the pinVersion so the client can detect changes.
      pinVerifier = null;
    }

    logger.info('[Rider Auth] Login success', {
      riderId: rider.id,
      employeeId: rider.employeeId,
      pinRequired,
      durationMs: Date.now() - t0,
    });

    res.json({
      token,
      rider: riderPublic,
      pinRequired,
      pinVersion: rider.pinVersion,
      serverTimestamp: new Date().toISOString(),
      // pinVerifier is only sent during /pin/setup — not on login
      // because we can't regenerate it from bcrypt hash
    });
  } catch (err) {
    logger.error('[Rider Auth] Login error', { err, durationMs: Date.now() - t0 });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /pin/setup ──────────────────────────────────────────────────

router.post('/pin/setup', async (req: Request, res: Response) => {
  try {
    const riderId = req.rider?.riderId;
    if (!riderId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { pin } = req.body;

    // Validate: exactly 4 digits
    if (!pin || !/^\d{4}$/.test(String(pin))) {
      res.status(400).json({ error: 'PIN must be exactly 4 digits' });
      return;
    }

    const pinStr = String(pin);

    // Hash with bcrypt for server-side storage
    const pinHash = await bcrypt.hash(pinStr, 12);

    // Generate SHA-256 verifier for client-side offline validation
    const pinVerifier = generatePinVerifier(pinStr);

    // Update rider record — increment pinVersion
    const updatedRider = await prisma.rider.update({
      where: { id: riderId },
      data: {
        pinHash,
        pinVersion: { increment: 1 },
      },
      select: { pinVersion: true },
    });

    logger.info('[Rider Auth] PIN setup success', {
      riderId,
      pinVersion: updatedRider.pinVersion,
    });

    res.json({
      message: 'PIN set successfully',
      pinVerifier,
      pinVersion: updatedRider.pinVersion,
    });
  } catch (err) {
    logger.error('[Rider Auth] PIN setup error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /pin/verify (online verification fallback) ──────────────────

router.post('/pin/verify', async (req: Request, res: Response) => {
  try {
    const riderId = req.rider?.riderId;
    if (!riderId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { pin } = req.body;
    if (!pin) {
      res.status(400).json({ error: 'PIN is required' });
      return;
    }

    const rider = await prisma.rider.findUnique({
      where: { id: riderId },
      select: { pinHash: true },
    });

    if (!rider?.pinHash) {
      res.status(400).json({ error: 'No PIN set. Use /pin/setup first.' });
      return;
    }

    const isMatch = await bcrypt.compare(String(pin), rider.pinHash);
    if (!isMatch) {
      logger.warn('[Rider Auth] PIN verification failed', { riderId });
      res.status(401).json({ error: 'Incorrect PIN' });
      return;
    }

    logger.info('[Rider Auth] PIN verified online', { riderId });
    res.json({ verified: true });
  } catch (err) {
    logger.error('[Rider Auth] PIN verify error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /refresh ────────────────────────────────────────────────────

router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const rider = req.rider;
    if (!rider) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const existing = await prisma.rider.findUnique({
      where: { id: rider.riderId },
      select: { isActive: true, pinVersion: true },
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
        pinVersion: existing.pinVersion,
      });
    } catch {
      logger.error('[Rider Auth] JWT_SECRET is not configured');
      res.status(500).json({ error: 'Internal server error' });
      return;
    }

    logger.info('[Rider Auth] Token refreshed', { riderId: rider.riderId });
    res.json({
      token,
      pinVersion: existing.pinVersion,
      serverTimestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('[Rider Auth] Refresh error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
