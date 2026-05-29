import './types/express';
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import { connectDatabase } from './config/database';
import manifestRouter from './routes/manifest';
import zoneRouter from './routes/zones';
import hubRouter from './routes/hubs';
import adminAuthRouter from './routes/admin-auth';
import adminManifestRouter from './routes/admin-manifest';
import adminRiderRouter from './routes/admin-rider';
import adminOrderRouter from './routes/admin-order';
import adminStopsRouter from './routes/admin-stops';
import attendanceRouter from './routes/attendance';
import riderAuthRouter from './routes/rider-auth';
import geocodeRouter from './routes/geocode';
import adminDashboardRouter from './routes/admin-dashboard';
import deliveryRouter from './routes/delivery';
import routeRouter from './routes/route';
import aiRouter from './routes/ai';
import { authMiddleware } from './middleware/rider-auth';
import { adminMiddleware } from './middleware/admin-auth';


const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(authMiddleware);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/manifest', manifestRouter);
app.use('/api/admin/zones', adminMiddleware, zoneRouter);
app.use('/api/admin/hubs', adminMiddleware, hubRouter);
app.use('/api/admin/auth', adminAuthRouter);
app.use('/api/admin/manifests', adminMiddleware, adminManifestRouter);
app.use('/api/admin/riders', adminMiddleware, adminRiderRouter);
app.use('/api/admin/orders', adminMiddleware, adminOrderRouter);
app.use('/api/admin/stops', adminMiddleware, adminStopsRouter);
app.use('/api/auth', riderAuthRouter);
app.use('/api/geocode', geocodeRouter);
app.use('/api/attendance', attendanceRouter);
app.use('/api/delivery', deliveryRouter);
app.use('/api/route', routeRouter);
app.use('/api/ai', aiRouter);
app.use('/api/admin/dashboard', adminMiddleware, adminDashboardRouter);

async function start() {
  try {
    await connectDatabase();
    app.listen(PORT, () => {
      console.log(`[Server] LBC Rider Backend running on port ${PORT}`);
    });
  } catch (err) {
    console.error('[Server] Failed to start:', err);
    process.exit(1);
  }
}

start();
