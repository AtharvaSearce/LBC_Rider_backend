import '../../../src/types/express';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { prismaMock } from '../../helpers/prismaMock';
import { buildApp } from '../../helpers/app';
import { adminAuthHeader } from '../../helpers/auth';
import { adminMiddleware } from '../../../src/middleware/admin-auth';
import adminRiderRouter from '../../../src/routes/admin-rider';
import { makeHub, makeRider, makeRiderWithHub, makeManifest } from '../../helpers/fixtures';

jest.mock('bcryptjs');
const hashMock = bcrypt.hash as unknown as jest.Mock;

const app = buildApp({
  mountPath: '/api/admin/riders',
  router: adminRiderRouter,
  preMiddleware: [adminMiddleware],
});

beforeEach(() => {
  hashMock.mockReset();
  hashMock.mockResolvedValue('hashed-password');
});

// ─── GET /api/admin/riders ────────────────────────────────────────────────

describe('GET /api/admin/riders', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).get('/api/admin/riders');
    expect(res.status).toBe(401);
  });

  it('200 lists riders with no filters and returns total', async () => {
    const riders = [makeRiderWithHub({ id: 'r1' }), makeRiderWithHub({ id: 'r2' })];
    (prismaMock.rider.findMany as jest.Mock).mockResolvedValue(riders);

    const res = await request(app)
      .get('/api/admin/riders')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.riders).toHaveLength(2);

    const args = (prismaMock.rider.findMany as jest.Mock).mock.calls[0][0];
    expect(args.where).toEqual({});
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('200 builds the OR search filter across name/email/employeeId/phone', async () => {
    (prismaMock.rider.findMany as jest.Mock).mockResolvedValue([]);

    await request(app)
      .get('/api/admin/riders?search=juan')
      .set('Authorization', adminAuthHeader());

    const args = (prismaMock.rider.findMany as jest.Mock).mock.calls[0][0];
    expect(args.where.OR).toEqual([
      { name: { contains: 'juan', mode: 'insensitive' } },
      { email: { contains: 'juan', mode: 'insensitive' } },
      { employeeId: { contains: 'juan', mode: 'insensitive' } },
      { phone: { contains: 'juan', mode: 'insensitive' } },
    ]);
  });

  it('200 filters by hubId and status=active', async () => {
    (prismaMock.rider.findMany as jest.Mock).mockResolvedValue([]);

    await request(app)
      .get('/api/admin/riders?hubId=hub-9&status=active')
      .set('Authorization', adminAuthHeader());

    const args = (prismaMock.rider.findMany as jest.Mock).mock.calls[0][0];
    expect(args.where).toMatchObject({ hubId: 'hub-9', isActive: true });
  });

  it('200 maps status=inactive to isActive=false', async () => {
    (prismaMock.rider.findMany as jest.Mock).mockResolvedValue([]);

    await request(app)
      .get('/api/admin/riders?status=inactive')
      .set('Authorization', adminAuthHeader());

    const args = (prismaMock.rider.findMany as jest.Mock).mock.calls[0][0];
    expect(args.where).toMatchObject({ isActive: false });
  });

  it('500 when Prisma blows up', async () => {
    (prismaMock.rider.findMany as jest.Mock).mockRejectedValue(new Error('boom'));

    const res = await request(app)
      .get('/api/admin/riders')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(500);
  });
});

// ─── GET /api/admin/riders/:id ────────────────────────────────────────────

describe('GET /api/admin/riders/:id', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).get('/api/admin/riders/rider-1');
    expect(res.status).toBe(401);
  });

  it('404 when rider does not exist', async () => {
    (prismaMock.rider.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .get('/api/admin/riders/missing')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Rider not found' });
  });

  it('200 returns rider plus the 10 most recent manifests', async () => {
    const rider = makeRiderWithHub();
    const manifests = [makeManifest({ id: 'm1' }), makeManifest({ id: 'm2' })];

    (prismaMock.rider.findUnique as jest.Mock).mockResolvedValue(rider);
    (prismaMock.manifest.findMany as jest.Mock).mockResolvedValue(manifests);

    const res = await request(app)
      .get('/api/admin/riders/rider-1')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(200);
    expect(res.body.rider.id).toBe('rider-1');
    expect(res.body.recentManifests).toHaveLength(2);

    const manifestArgs = (prismaMock.manifest.findMany as jest.Mock).mock.calls[0][0];
    expect(manifestArgs).toMatchObject({
      where: { riderId: 'rider-1' },
      orderBy: { date: 'desc' },
      take: 10,
    });
  });
});

// ─── POST /api/admin/riders ───────────────────────────────────────────────

describe('POST /api/admin/riders', () => {
  const validBody = {
    employeeId: 'EMP-100',
    name: 'New Rider',
    email: 'New.Rider@LBC.PH',
    phone: '+639170000111',
    password: 'plain-password',
    hubId: 'hub-1',
    vehicleType: 'van',
  };

  it('401 when unauthenticated', async () => {
    const res = await request(app).post('/api/admin/riders').send(validBody);
    expect(res.status).toBe(401);
  });

  it('400 when any required field is missing', async () => {
    const { password, ...withoutPassword } = validBody;

    const res = await request(app)
      .post('/api/admin/riders')
      .set('Authorization', adminAuthHeader())
      .send(withoutPassword);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('404 when the hub does not exist', async () => {
    (prismaMock.hub.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post('/api/admin/riders')
      .set('Authorization', adminAuthHeader())
      .send(validBody);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Hub not found' });
  });

  it('409 when email or employeeId already exists', async () => {
    (prismaMock.hub.findUnique as jest.Mock).mockResolvedValue(makeHub());
    (prismaMock.rider.findFirst as jest.Mock).mockResolvedValue(makeRider());

    const res = await request(app)
      .post('/api/admin/riders')
      .set('Authorization', adminAuthHeader())
      .send(validBody);

    expect(res.status).toBe(409);
  });

  it('201 hashes the password, normalizes email to lowercase, and creates the rider', async () => {
    (prismaMock.hub.findUnique as jest.Mock).mockResolvedValue(makeHub());
    (prismaMock.rider.findFirst as jest.Mock).mockResolvedValue(null);
    (prismaMock.rider.create as jest.Mock).mockResolvedValue(
      makeRiderWithHub({ id: 'rider-new', email: 'new.rider@lbc.ph' })
    );

    const res = await request(app)
      .post('/api/admin/riders')
      .set('Authorization', adminAuthHeader())
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.rider.id).toBe('rider-new');

    expect(hashMock).toHaveBeenCalledWith('plain-password', 12);

    const createArgs = (prismaMock.rider.create as jest.Mock).mock.calls[0][0];
    expect(createArgs.data).toMatchObject({
      employeeId: 'EMP-100',
      email: 'new.rider@lbc.ph',
      passwordHash: 'hashed-password',
      hubId: 'hub-1',
      vehicleType: 'van',
      isActive: true,
    });
    // Plain password is never persisted.
    expect(createArgs.data.password).toBeUndefined();
  });

  it('201 defaults vehicleType to "motorcycle" when omitted', async () => {
    (prismaMock.hub.findUnique as jest.Mock).mockResolvedValue(makeHub());
    (prismaMock.rider.findFirst as jest.Mock).mockResolvedValue(null);
    (prismaMock.rider.create as jest.Mock).mockResolvedValue(makeRiderWithHub());

    const { vehicleType, ...bodyWithoutVehicle } = validBody;

    const res = await request(app)
      .post('/api/admin/riders')
      .set('Authorization', adminAuthHeader())
      .send(bodyWithoutVehicle);

    expect(res.status).toBe(201);
    const createArgs = (prismaMock.rider.create as jest.Mock).mock.calls[0][0];
    expect(createArgs.data.vehicleType).toBe('motorcycle');
  });
});

// ─── PUT /api/admin/riders/:id ────────────────────────────────────────────

describe('PUT /api/admin/riders/:id', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).put('/api/admin/riders/rider-1').send({});
    expect(res.status).toBe(401);
  });

  it('404 when rider does not exist', async () => {
    (prismaMock.rider.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .put('/api/admin/riders/missing')
      .set('Authorization', adminAuthHeader())
      .send({ name: 'New Name' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Rider not found' });
  });

  it('404 when hubId is provided but the hub does not exist', async () => {
    (prismaMock.rider.findUnique as jest.Mock).mockResolvedValue(makeRider());
    (prismaMock.hub.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .put('/api/admin/riders/rider-1')
      .set('Authorization', adminAuthHeader())
      .send({ hubId: 'hub-bogus' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Hub not found' });
  });

  it('409 when changing email to one already used by another rider', async () => {
    (prismaMock.rider.findUnique as jest.Mock).mockResolvedValue(makeRider());
    (prismaMock.rider.findFirst as jest.Mock).mockResolvedValue(
      makeRider({ id: 'rider-2', email: 'taken@lbc.ph' })
    );

    const res = await request(app)
      .put('/api/admin/riders/rider-1')
      .set('Authorization', adminAuthHeader())
      .send({ email: 'Taken@LBC.ph' });

    expect(res.status).toBe(409);

    const lookupArgs = (prismaMock.rider.findFirst as jest.Mock).mock.calls[0][0];
    expect(lookupArgs.where).toMatchObject({
      email: 'taken@lbc.ph',
      NOT: { id: 'rider-1' },
    });
  });

  it('200 updates only provided fields and skips passwordHash when no password sent', async () => {
    (prismaMock.rider.findUnique as jest.Mock).mockResolvedValue(makeRider());
    (prismaMock.rider.update as jest.Mock).mockResolvedValue(
      makeRiderWithHub({ name: 'Updated' })
    );

    const res = await request(app)
      .put('/api/admin/riders/rider-1')
      .set('Authorization', adminAuthHeader())
      .send({ name: 'Updated', isActive: false });

    expect(res.status).toBe(200);
    expect(hashMock).not.toHaveBeenCalled();

    const updateArgs = (prismaMock.rider.update as jest.Mock).mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 'rider-1' });
    expect(updateArgs.data).toEqual({ name: 'Updated', isActive: false });
    expect(updateArgs.data.passwordHash).toBeUndefined();
  });

  it('200 hashes password when provided and normalizes email', async () => {
    (prismaMock.rider.findUnique as jest.Mock).mockResolvedValue(makeRider());
    (prismaMock.rider.findFirst as jest.Mock).mockResolvedValue(null);
    (prismaMock.rider.update as jest.Mock).mockResolvedValue(makeRiderWithHub());

    const res = await request(app)
      .put('/api/admin/riders/rider-1')
      .set('Authorization', adminAuthHeader())
      .send({ email: 'New.Email@LBC.PH', password: 'fresh-pass' });

    expect(res.status).toBe(200);
    expect(hashMock).toHaveBeenCalledWith('fresh-pass', 12);

    const updateArgs = (prismaMock.rider.update as jest.Mock).mock.calls[0][0];
    expect(updateArgs.data).toMatchObject({
      email: 'new.email@lbc.ph',
      passwordHash: 'hashed-password',
    });
  });
});

// ─── DELETE /api/admin/riders/:id ─────────────────────────────────────────

describe('DELETE /api/admin/riders/:id', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).delete('/api/admin/riders/rider-1');
    expect(res.status).toBe(401);
  });

  it('404 when rider does not exist', async () => {
    (prismaMock.rider.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .delete('/api/admin/riders/missing')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(404);
  });

  it('200 soft-deletes by setting isActive=false (no row deletion)', async () => {
    (prismaMock.rider.findUnique as jest.Mock).mockResolvedValue(makeRider());
    (prismaMock.rider.update as jest.Mock).mockResolvedValue(
      makeRiderWithHub({ isActive: false })
    );

    const res = await request(app)
      .delete('/api/admin/riders/rider-1')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Rider deactivated');
    expect(res.body.rider.isActive).toBe(false);

    const updateArgs = (prismaMock.rider.update as jest.Mock).mock.calls[0][0];
    expect(updateArgs).toMatchObject({
      where: { id: 'rider-1' },
      data: { isActive: false },
    });
    expect((prismaMock.rider.delete as jest.Mock)).not.toHaveBeenCalled();
  });
});
