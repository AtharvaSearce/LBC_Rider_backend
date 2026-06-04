import '../../../src/types/express';
import request from 'supertest';
import { ManifestStatus } from '@prisma/client';
import { prismaMock } from '../../helpers/prismaMock';
import { buildApp } from '../../helpers/app';
import { adminAuthHeader } from '../../helpers/auth';
import { adminMiddleware } from '../../../src/middleware/admin-auth';
import adminManifestRouter from '../../../src/routes/admin-manifest';
import { makeManifest, makeRider } from '../../helpers/fixtures';

const app = buildApp({
  mountPath: '/api/admin/manifests',
  router: adminManifestRouter,
  preMiddleware: [adminMiddleware],
});

// ─── GET /api/admin/manifests ─────────────────────────────────────────────

describe('GET /api/admin/manifests', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).get('/api/admin/manifests');
    expect(res.status).toBe(401);
  });

  it('200 lists manifests with no filters and returns total', async () => {
    const manifests = [makeManifest({ id: 'm1' }), makeManifest({ id: 'm2' })];
    (prismaMock.manifest.findMany as jest.Mock).mockResolvedValue(manifests);

    const res = await request(app)
      .get('/api/admin/manifests')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);

    const args = (prismaMock.manifest.findMany as jest.Mock).mock.calls[0][0];
    expect(args.where).toEqual({});
    expect(args.orderBy).toEqual({ date: 'desc' });
  });

  it('200 ignores status when status=all', async () => {
    (prismaMock.manifest.findMany as jest.Mock).mockResolvedValue([]);

    await request(app)
      .get('/api/admin/manifests?status=all')
      .set('Authorization', adminAuthHeader());

    const args = (prismaMock.manifest.findMany as jest.Mock).mock.calls[0][0];
    expect(args.where.status).toBeUndefined();
  });

  it('400 on an unknown status filter', async () => {
    const res = await request(app)
      .get('/api/admin/manifests?status=bogus')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid status filter' });
  });

  it('200 applies status, riderId, date and search filters together', async () => {
    (prismaMock.manifest.findMany as jest.Mock).mockResolvedValue([]);

    await request(app)
      .get(
        '/api/admin/manifests?status=in_progress&riderId=rider-1&date=2026-06-04&search=DDR'
      )
      .set('Authorization', adminAuthHeader());

    const args = (prismaMock.manifest.findMany as jest.Mock).mock.calls[0][0];
    expect(args.where.status).toBe(ManifestStatus.in_progress);
    expect(args.where.riderId).toBe('rider-1');
    expect(args.where.manifestId).toEqual({
      contains: 'DDR',
      mode: 'insensitive',
    });

    // Date filter is a 24h window starting at local midnight.
    const { gte, lt } = args.where.date as { gte: Date; lt: Date };
    expect(gte).toBeInstanceOf(Date);
    expect(lt).toBeInstanceOf(Date);
    expect(lt.getTime() - gte.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('500 when Prisma throws', async () => {
    (prismaMock.manifest.findMany as jest.Mock).mockRejectedValue(new Error('boom'));

    const res = await request(app)
      .get('/api/admin/manifests')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(500);
  });
});

// ─── GET /api/admin/manifests/:id ─────────────────────────────────────────

describe('GET /api/admin/manifests/:id', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).get('/api/admin/manifests/m-1');
    expect(res.status).toBe(401);
  });

  it('404 when manifest does not exist', async () => {
    (prismaMock.manifest.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .get('/api/admin/manifests/missing')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(404);
  });

  it('200 returns the manifest with rider, stops, and counts', async () => {
    const manifest = {
      ...makeManifest(),
      rider: { id: 'rider-1', name: 'Juan' },
      stops: [],
      _count: { stops: 0, assignedOrders: 0 },
    };
    (prismaMock.manifest.findUnique as jest.Mock).mockResolvedValue(manifest);

    const res = await request(app)
      .get('/api/admin/manifests/manifest-1')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(200);
    expect(res.body.manifest.id).toBe('manifest-1');

    const args = (prismaMock.manifest.findUnique as jest.Mock).mock.calls[0][0];
    expect(args.where).toEqual({ id: 'manifest-1' });
    // Ensures the detail include shape (stops sorted asc by sequence) is requested.
    expect(args.include.stops.orderBy).toEqual({ sequence: 'asc' });
  });
});

// ─── POST /api/admin/manifests ────────────────────────────────────────────

describe('POST /api/admin/manifests', () => {
  const validBody = {
    manifestId: 'DDR-20260604-zzzz',
    riderId: 'rider-1',
    date: '2026-06-04',
    totalStops: 5,
  };

  it('401 when unauthenticated', async () => {
    const res = await request(app).post('/api/admin/manifests').send(validBody);
    expect(res.status).toBe(401);
  });

  it('400 when required fields are missing', async () => {
    const res = await request(app)
      .post('/api/admin/manifests')
      .set('Authorization', adminAuthHeader())
      .send({ manifestId: 'X' });

    expect(res.status).toBe(400);
  });

  it('404 when rider does not exist', async () => {
    (prismaMock.rider.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post('/api/admin/manifests')
      .set('Authorization', adminAuthHeader())
      .send(validBody);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Rider not found' });
  });

  it('409 when a manifest with the same manifestId already exists', async () => {
    (prismaMock.rider.findUnique as jest.Mock).mockResolvedValue(makeRider());
    (prismaMock.manifest.findUnique as jest.Mock).mockResolvedValue(makeManifest());

    const res = await request(app)
      .post('/api/admin/manifests')
      .set('Authorization', adminAuthHeader())
      .send(validBody);

    expect(res.status).toBe(409);
  });

  it('201 creates the manifest with status=pending and default counters', async () => {
    (prismaMock.rider.findUnique as jest.Mock).mockResolvedValue(makeRider());
    (prismaMock.manifest.findUnique as jest.Mock).mockResolvedValue(null);
    (prismaMock.manifest.create as jest.Mock).mockResolvedValue({
      ...makeManifest({ id: 'm-new', status: ManifestStatus.pending, totalStops: 5 }),
      rider: { id: 'rider-1', name: 'Juan' },
      _count: { stops: 0, assignedOrders: 0 },
    });

    const res = await request(app)
      .post('/api/admin/manifests')
      .set('Authorization', adminAuthHeader())
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.manifest.id).toBe('m-new');

    const args = (prismaMock.manifest.create as jest.Mock).mock.calls[0][0];
    expect(args.data).toMatchObject({
      manifestId: 'DDR-20260604-zzzz',
      riderId: 'rider-1',
      status: ManifestStatus.pending,
      totalStops: 5,
      completedStops: 0,
      failedStops: 0,
    });
    expect(args.data.date).toBeInstanceOf(Date);
  });

  it('201 defaults totalStops to 0 when omitted', async () => {
    (prismaMock.rider.findUnique as jest.Mock).mockResolvedValue(makeRider());
    (prismaMock.manifest.findUnique as jest.Mock).mockResolvedValue(null);
    (prismaMock.manifest.create as jest.Mock).mockResolvedValue(makeManifest());

    const { totalStops, ...body } = validBody;
    await request(app)
      .post('/api/admin/manifests')
      .set('Authorization', adminAuthHeader())
      .send(body);

    const args = (prismaMock.manifest.create as jest.Mock).mock.calls[0][0];
    expect(args.data.totalStops).toBe(0);
  });
});

// ─── PUT /api/admin/manifests/:id ─────────────────────────────────────────

describe('PUT /api/admin/manifests/:id', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).put('/api/admin/manifests/m-1').send({});
    expect(res.status).toBe(401);
  });

  it('404 when manifest does not exist', async () => {
    (prismaMock.manifest.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .put('/api/admin/manifests/missing')
      .set('Authorization', adminAuthHeader())
      .send({ status: ManifestStatus.completed });

    expect(res.status).toBe(404);
  });

  it('404 when reassigning to a non-existent rider', async () => {
    (prismaMock.manifest.findUnique as jest.Mock).mockResolvedValue(makeManifest());
    (prismaMock.rider.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .put('/api/admin/manifests/manifest-1')
      .set('Authorization', adminAuthHeader())
      .send({ riderId: 'ghost' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Rider not found' });
  });

  it('400 on an unknown status', async () => {
    (prismaMock.manifest.findUnique as jest.Mock).mockResolvedValue(makeManifest());

    const res = await request(app)
      .put('/api/admin/manifests/manifest-1')
      .set('Authorization', adminAuthHeader())
      .send({ status: 'lol' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid status' });
  });

  it('200 only writes the fields present in the body and coerces counts to numbers', async () => {
    (prismaMock.manifest.findUnique as jest.Mock).mockResolvedValue(makeManifest());
    (prismaMock.manifest.update as jest.Mock).mockResolvedValue({
      ...makeManifest({ status: ManifestStatus.completed }),
      rider: { id: 'rider-1', name: 'Juan' },
      _count: { stops: 0, assignedOrders: 0 },
    });

    const res = await request(app)
      .put('/api/admin/manifests/manifest-1')
      .set('Authorization', adminAuthHeader())
      .send({
        status: ManifestStatus.completed,
        totalStops: '7',
        completedStops: '5',
        failedStops: '2',
      });

    expect(res.status).toBe(200);

    const args = (prismaMock.manifest.update as jest.Mock).mock.calls[0][0];
    expect(args.where).toEqual({ id: 'manifest-1' });
    expect(args.data).toEqual({
      status: ManifestStatus.completed,
      totalStops: 7,
      completedStops: 5,
      failedStops: 2,
    });
    expect(args.data.riderId).toBeUndefined();
    expect(args.data.date).toBeUndefined();
  });

  it('200 reassigns rider and parses date when provided', async () => {
    (prismaMock.manifest.findUnique as jest.Mock).mockResolvedValue(makeManifest());
    (prismaMock.rider.findUnique as jest.Mock).mockResolvedValue(makeRider({ id: 'rider-9' }));
    (prismaMock.manifest.update as jest.Mock).mockResolvedValue({
      ...makeManifest({ riderId: 'rider-9' }),
      rider: { id: 'rider-9', name: 'Ana' },
      _count: { stops: 0, assignedOrders: 0 },
    });

    const res = await request(app)
      .put('/api/admin/manifests/manifest-1')
      .set('Authorization', adminAuthHeader())
      .send({ riderId: 'rider-9', date: '2026-07-01' });

    expect(res.status).toBe(200);
    const args = (prismaMock.manifest.update as jest.Mock).mock.calls[0][0];
    expect(args.data.riderId).toBe('rider-9');
    expect(args.data.date).toBeInstanceOf(Date);
  });
});

// ─── DELETE /api/admin/manifests/:id ──────────────────────────────────────

describe('DELETE /api/admin/manifests/:id', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).delete('/api/admin/manifests/m-1');
    expect(res.status).toBe(401);
  });

  it('404 when manifest does not exist', async () => {
    (prismaMock.manifest.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .delete('/api/admin/manifests/missing')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(404);
  });

  it('200 hard-deletes the manifest', async () => {
    (prismaMock.manifest.findUnique as jest.Mock).mockResolvedValue(makeManifest());
    (prismaMock.manifest.delete as jest.Mock).mockResolvedValue(makeManifest());

    const res = await request(app)
      .delete('/api/admin/manifests/manifest-1')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Manifest deleted successfully' });
    expect((prismaMock.manifest.delete as jest.Mock)).toHaveBeenCalledWith({
      where: { id: 'manifest-1' },
    });
  });
});
