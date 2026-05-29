import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import logger from '../utils/logger';

export interface AdminTokenPayload {
  adminId: string;
  email: string;
  role: 'admin';
  iat?: number;
  exp?: number;
}

interface DecodedAdminToken extends AdminTokenPayload {
  iat: number;
  exp: number;
}

function getJwtSecret(): string | null {
  return process.env.JWT_SECRET ?? null;
}

export function signAdminToken(payload: {
  adminId: string;
  email: string;
}): string {
  const secret = getJwtSecret();
  if (!secret) {
    throw new Error('JWT_SECRET is not configured');
  }

  return jwt.sign(
    {
      adminId: payload.adminId,
      email: payload.email,
      role: 'admin',
    },
    secret,
    { expiresIn: '12h' }
  );
}

export function adminMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    logger.warn('[AdminAuth] Missing or invalid authorization header', { path: req.path, method: req.method });
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }

  const token = header.slice(7);
  const secret = getJwtSecret();
  if (!secret) {
    logger.error('[AdminAuth] JWT_SECRET not set');
    res.status(500).json({ error: 'Server misconfiguration: JWT_SECRET not set' });
    return;
  }

  try {
    const decoded = jwt.verify(token, secret) as DecodedAdminToken;

    if (decoded.role !== 'admin') {
      logger.warn('[AdminAuth] Token role mismatch', { role: decoded.role, path: req.path });
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    req.admin = {
      adminId: decoded.adminId,
      email: decoded.email,
      role: decoded.role,
      iat: decoded.iat,
      exp: decoded.exp,
    };

    next();
  } catch {
    logger.warn('[AdminAuth] Invalid or expired token', { path: req.path });
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
