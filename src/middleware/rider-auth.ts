import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import logger from '../utils/logger';

export interface RiderTokenPayload {
  riderId: string;
  employeeId: string;
  hubId: string;
  pinVersion: number;
  role: 'rider';
  iat?: number;
  exp?: number;
}

interface DecodedRiderToken extends RiderTokenPayload {
  iat: number;
  exp: number;
}

const PUBLIC_PATHS = [
  '/health',
  '/api/auth/login',
  '/api/admin/auth',
  '/api/geocode',
  // Admin routes — skip rider JWT; protected by adminMiddleware instead
  '/api/admin',
  '/api/zones',
  '/api/hubs',
];

function getJwtSecret(): string | null {
  return process.env.JWT_SECRET ?? null;
}

export function signRiderToken(payload: {
  riderId: string;
  employeeId: string;
  hubId: string;
  pinVersion: number;
}): string {
  const secret = getJwtSecret();
  if (!secret) {
    throw new Error('JWT_SECRET is not configured');
  }

  return jwt.sign(
    {
      riderId: payload.riderId,
      employeeId: payload.employeeId,
      hubId: payload.hubId,
      pinVersion: payload.pinVersion,
      role: 'rider',
    },
    secret,
    { expiresIn: '24h' }
  );
}

export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (PUBLIC_PATHS.some((path) => req.path.startsWith(path))) {
    next();
    return;
  }

  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    logger.warn('[RiderAuth] Missing or invalid authorization header', { path: req.path, method: req.method });
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }

  const token = header.slice(7);
  const secret = getJwtSecret();
  if (!secret) {
    logger.error('[RiderAuth] JWT_SECRET not set');
    res.status(500).json({ error: 'Server misconfiguration: JWT_SECRET not set' });
    return;
  }

  try {
    const decoded = jwt.verify(token, secret) as DecodedRiderToken;

    if (decoded.role !== 'rider') {
      logger.warn('[RiderAuth] Token role mismatch', { role: decoded.role, path: req.path });
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    req.rider = {
      riderId: decoded.riderId,
      employeeId: decoded.employeeId,
      hubId: decoded.hubId,
      pinVersion: decoded.pinVersion,
      role: decoded.role,
      iat: decoded.iat,
      exp: decoded.exp,
    };

    next();
  } catch {
    logger.warn('[RiderAuth] Invalid or expired token', { path: req.path });
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
