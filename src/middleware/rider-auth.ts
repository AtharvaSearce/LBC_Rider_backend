import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface RiderTokenPayload {
  riderId: string;
  employeeId: string;
  hubId: string;
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
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }

  const token = header.slice(7);
  const secret = getJwtSecret();
  if (!secret) {
    res.status(500).json({ error: 'Server misconfiguration: JWT_SECRET not set' });
    return;
  }

  try {
    const decoded = jwt.verify(token, secret) as DecodedRiderToken;

    if (decoded.role !== 'rider') {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    req.rider = {
      riderId: decoded.riderId,
      employeeId: decoded.employeeId,
      hubId: decoded.hubId,
      role: decoded.role,
      iat: decoded.iat,
      exp: decoded.exp,
    };

    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
