import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import logger from '../utils/logger';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    const riderId = req.rider?.riderId;
    if (!riderId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const unreadOnly = req.query.unreadOnly === 'true';

    const notifications = await prisma.notification.findMany({
      where: {
        riderId,
        ...(unreadOnly && { read: false }),
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    res.json({ notifications });
  } catch (err) {
    logger.error('[Notifications] List error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/unread-count', async (req: Request, res: Response) => {
  try {
    const riderId = req.rider?.riderId;
    if (!riderId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const count = await prisma.notification.count({
      where: { riderId, read: false },
    });

    res.json({ count });
  } catch (err) {
    logger.error('[Notifications] Unread count error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:id/read', async (req: Request, res: Response) => {
  try {
    const riderId = req.rider?.riderId;
    if (!riderId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const id = typeof req.params.id === 'string' ? req.params.id : req.params.id?.[0];
    if (!id) {
      res.status(400).json({ error: 'Invalid notification id' });
      return;
    }

    const notification = await prisma.notification.findFirst({
      where: { id, riderId },
    });

    if (!notification) {
      res.status(404).json({ error: 'Notification not found' });
      return;
    }

    await prisma.notification.update({
      where: { id },
      data: { read: true },
    });

    res.json({ message: 'Notification marked as read' });
  } catch (err) {
    logger.error('[Notifications] Mark read error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/read-all', async (req: Request, res: Response) => {
  try {
    const riderId = req.rider?.riderId;
    if (!riderId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const result = await prisma.notification.updateMany({
      where: { riderId, read: false },
      data: { read: true },
    });

    res.json({ message: 'All notifications marked as read', count: result.count });
  } catch (err) {
    logger.error('[Notifications] Mark all read error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
