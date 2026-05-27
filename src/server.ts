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


const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/manifest', manifestRouter);
app.use('/api/zones', zoneRouter);
app.use('/api/hubs', hubRouter);
app.use('/api/admin-auth', adminAuthRouter);
app.use('/api/admin/manifests', adminManifestRouter);

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
