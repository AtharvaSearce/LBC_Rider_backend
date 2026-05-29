import { Router, Request, Response } from 'express';
import { signAdminToken } from '../middleware/admin-auth';
import logger from '../utils/logger';

const router = Router();

const ADMIN_CREDENTIALS = {
  email: (process.env.ADMIN_EMAIL ?? 'admin@lbc.ph').toLowerCase(),
  password: process.env.ADMIN_PASSWORD ?? 'admin123',
  adminId: process.env.ADMIN_ID ?? 'ADM-001',
  name: process.env.ADMIN_NAME ?? 'LBC Admin',
};

router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const normalizedEmail = String(email).toLowerCase().trim();

    if (
      normalizedEmail !== ADMIN_CREDENTIALS.email ||
      password !== ADMIN_CREDENTIALS.password
    ) {
      logger.warn('[Admin Auth] Invalid login attempt', { email: normalizedEmail });
      res.status(401).json({ error: 'Invalid admin credentials' });
      return;
    }

    let token: string;
    try {
      token = signAdminToken({
        adminId: ADMIN_CREDENTIALS.adminId,
        email: ADMIN_CREDENTIALS.email,
      });
    } catch {
      logger.error('[Admin Auth] JWT_SECRET is not configured');
      res.status(500).json({ error: 'Internal server error' });
      return;
    }

    logger.info('[Admin Auth] Login success', { adminId: ADMIN_CREDENTIALS.adminId, email: normalizedEmail });

    res.json({
      token,
      admin: {
        id: ADMIN_CREDENTIALS.adminId,
        name: ADMIN_CREDENTIALS.name,
        email: ADMIN_CREDENTIALS.email,
        role: 'admin',
      },
    });
  } catch (err) {
    logger.error('[Admin Auth] Login error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
