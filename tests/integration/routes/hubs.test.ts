import '../../../src/types/express';
import request from 'supertest';
import { prismaMock } from '../../helpers/prismaMock';
import { buildApp } from '../../helpers/app';
import { adminAuthHeader } from '../../helpers/auth';
import { adminMiddleware } from '../../../src/middleware/admin-auth';
import hubRouter from '../../../src/routes/hubs';

const app = buildApp({
  mountPath: '/api/admin/hubs',
  router: hubRouter,
  preMiddleware: [adminMiddleware],
});

function makeHub(
  overrides: Partial<{
    id: string;
    name: string;
    lat: number;
    lng: number;
    radiusMeters: number;
    zoneId: string;
  }> = {}
) {
  return {
    id: overrides.id ?? 'hub-1',
    name: overrides.name ?? 'Makati Hub',
    lat: overrides.lat ?? 14.5547,
    lng: overrides.lng ?? 121.0244,
    radiusMeters: overrides.radiusMeters ?? 200,
    zoneId: overrides.zoneId ?? 'zone-1',
    createdAt: new Date('2026-06-03T10:00:00.000Z'),
    updatedAt: new Date('2026-06-03T10:00:00.000Z'),
  };
}

function makeHubWithZone(overrides: Parameters<typeof makeHub>[0] = {}) {
  return {
    ...makeHub(overrides),
    zone: { id: overrides?.zoneId ?? 'zone-1', name: 'NCR' },
  };
}

function makeZone(id = 'zone-1', name = 'NCR') {
  return {
    id,
    name,
    createdAt: new Date('2026-06-03T10:00:00.000Z'),
    updatedAt: new Date('2026-06-03T10:00:00.000Z'),
  };
}

describe('GET /api/admin/hubs', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).get('/api/admin/hubs');
    expect(res.status).toBe(401);
  });

  it('200 returns hubs and total count, ordered by name', async () => {
    const hubs = [
      makeHubWithZone({ id: 'h-1', name: 'Cebu Hub', zoneId: 'z-2' }),
      makeHubWithZone({ id: 'h-2', name: 'Makati Hub', zoneId: 'z-1' }),
    ];
    prismaMock.hub.findMany.mockResolvedValue(hubs as never);

    const res = await request(app)
      .get('/api/admin/hubs')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.hubs).toHaveLength(2);
    expect(res.body.hubs[0]).toMatchObject({
      id: 'h-1',
      name: 'Cebu Hub',
      zone: { id: 'z-2', name: 'NCR' },
    });
    expect(prismaMock.hub.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { name: 'asc' } })
    );
  });
});

describe('POST /api/admin/hubs', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app)
      .post('/api/admin/hubs')
      .send({ name: 'Hub', lat: 1, lng: 2, zoneId: 'z' });
    expect(res.status).toBe(401);
  });

  it('400 when name is missing', async () => {
    const res = await request(app)
      .post('/api/admin/hubs')
      .set('Authorization', adminAuthHeader())
      .send({ lat: 14.5, lng: 121, zoneId: 'z-1' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Missing required fields: name, lat, lng, zoneId',
    });
  });

  it('400 when lat is missing', async () => {
    const res = await request(app)
      .post('/api/admin/hubs')
      .set('Authorization', adminAuthHeader())
      .send({ name: 'Hub', lng: 121, zoneId: 'z-1' });

    expect(res.status).toBe(400);
  });

  it('400 when lng is missing', async () => {
    const res = await request(app)
      .post('/api/admin/hubs')
      .set('Authorization', adminAuthHeader())
      .send({ name: 'Hub', lat: 14.5, zoneId: 'z-1' });

    expect(res.status).toBe(400);
  });

  it('400 when zoneId is missing', async () => {
    const res = await request(app)
      .post('/api/admin/hubs')
      .set('Authorization', adminAuthHeader())
      .send({ name: 'Hub', lat: 14.5, lng: 121 });

    expect(res.status).toBe(400);
  });

  it('404 when the parent zone does not exist', async () => {
    prismaMock.zone.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/admin/hubs')
      .set('Authorization', adminAuthHeader())
      .send({ name: 'Hub', lat: 14.5, lng: 121, zoneId: 'missing-zone' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Zone not found' });
    expect(prismaMock.hub.create).not.toHaveBeenCalled();
  });

  it('409 when a hub with the same name already exists', async () => {
    prismaMock.zone.findUnique.mockResolvedValue(makeZone() as never);
    prismaMock.hub.findUnique.mockResolvedValue(makeHub({ name: 'Makati Hub' }) as never);

    const res = await request(app)
      .post('/api/admin/hubs')
      .set('Authorization', adminAuthHeader())
      .send({ name: 'Makati Hub', lat: 14.5, lng: 121, zoneId: 'zone-1' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Hub "Makati Hub" already exists' });
    expect(prismaMock.hub.create).not.toHaveBeenCalled();
  });

  it('201 creates the hub with zone preloaded; coerces lat/lng/radius', async () => {
    prismaMock.zone.findUnique.mockResolvedValue(makeZone() as never);
    prismaMock.hub.findUnique.mockResolvedValue(null);
    prismaMock.hub.create.mockResolvedValue(
      makeHubWithZone({ id: 'h-99', name: 'New Hub', zoneId: 'zone-1' }) as never
    );

    const res = await request(app)
      .post('/api/admin/hubs')
      .set('Authorization', adminAuthHeader())
      .send({
        name: 'New Hub',
        lat: '14.5547',
        lng: '121.0244',
        zoneId: 'zone-1',
        radiusMeters: '300',
      });

    expect(res.status).toBe(201);
    expect(res.body.hub).toMatchObject({
      id: 'h-99',
      name: 'New Hub',
      zone: { id: 'zone-1', name: 'NCR' },
    });
    expect(prismaMock.hub.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          name: 'New Hub',
          lat: 14.5547,
          lng: 121.0244,
          zoneId: 'zone-1',
          radiusMeters: 300,
        },
      })
    );
  });

  it('201 omits radiusMeters when not provided (uses schema default)', async () => {
    prismaMock.zone.findUnique.mockResolvedValue(makeZone() as never);
    prismaMock.hub.findUnique.mockResolvedValue(null);
    prismaMock.hub.create.mockResolvedValue(makeHubWithZone() as never);

    const res = await request(app)
      .post('/api/admin/hubs')
      .set('Authorization', adminAuthHeader())
      .send({ name: 'New Hub', lat: 14.5, lng: 121, zoneId: 'zone-1' });

    expect(res.status).toBe(201);
    const callArgs = prismaMock.hub.create.mock.calls[0][0];
    expect((callArgs as { data: Record<string, unknown> }).data).not.toHaveProperty(
      'radiusMeters'
    );
  });
});

describe('PUT /api/admin/hubs/:id', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).put('/api/admin/hubs/h-1').send({ name: 'X' });
    expect(res.status).toBe(401);
  });

  it('404 when the hub does not exist', async () => {
    prismaMock.hub.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .put('/api/admin/hubs/h-missing')
      .set('Authorization', adminAuthHeader())
      .send({ name: 'New' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Hub not found' });
    expect(prismaMock.hub.update).not.toHaveBeenCalled();
  });

  it('409 when renaming to a name another hub already owns', async () => {
    prismaMock.hub.findUnique
      .mockResolvedValueOnce(makeHub({ id: 'h-1', name: 'OldName' }) as never)
      .mockResolvedValueOnce(makeHub({ id: 'h-2', name: 'TakenName' }) as never);

    const res = await request(app)
      .put('/api/admin/hubs/h-1')
      .set('Authorization', adminAuthHeader())
      .send({ name: 'TakenName' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Hub "TakenName" already exists' });
    expect(prismaMock.hub.update).not.toHaveBeenCalled();
  });

  it('404 when zoneId is provided but the zone does not exist', async () => {
    prismaMock.hub.findUnique.mockResolvedValueOnce(makeHub({ id: 'h-1' }) as never);
    prismaMock.zone.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .put('/api/admin/hubs/h-1')
      .set('Authorization', adminAuthHeader())
      .send({ zoneId: 'missing-zone' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Zone not found' });
    expect(prismaMock.hub.update).not.toHaveBeenCalled();
  });

  it('200 partially updates only the fields provided', async () => {
    prismaMock.hub.findUnique.mockResolvedValueOnce(
      makeHub({ id: 'h-1', name: 'OldName', radiusMeters: 200 }) as never
    );
    prismaMock.hub.update.mockResolvedValue(
      makeHubWithZone({ id: 'h-1', name: 'OldName', radiusMeters: 500 }) as never
    );

    const res = await request(app)
      .put('/api/admin/hubs/h-1')
      .set('Authorization', adminAuthHeader())
      .send({ radiusMeters: 500 });

    expect(res.status).toBe(200);
    expect(res.body.hub.radiusMeters).toBe(500);
    expect(prismaMock.hub.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'h-1' },
        data: { radiusMeters: 500 },
      })
    );
  });
});

describe('DELETE /api/admin/hubs/:id', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).delete('/api/admin/hubs/h-1');
    expect(res.status).toBe(401);
  });

  it('404 when the hub does not exist', async () => {
    prismaMock.hub.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .delete('/api/admin/hubs/h-missing')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(404);
    expect(prismaMock.hub.delete).not.toHaveBeenCalled();
  });

  it('409 when riders are still attached to the hub', async () => {
    prismaMock.hub.findUnique.mockResolvedValue({
      ...makeHub({ id: 'h-1' }),
      _count: { riders: 4, orders: 0 },
    } as never);

    const res = await request(app)
      .delete('/api/admin/hubs/h-1')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'Cannot delete hub while riders or orders are assigned to it',
    });
    expect(prismaMock.hub.delete).not.toHaveBeenCalled();
  });

  it('409 when orders are still attached to the hub', async () => {
    prismaMock.hub.findUnique.mockResolvedValue({
      ...makeHub({ id: 'h-1' }),
      _count: { riders: 0, orders: 12 },
    } as never);

    const res = await request(app)
      .delete('/api/admin/hubs/h-1')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(409);
    expect(prismaMock.hub.delete).not.toHaveBeenCalled();
  });

  it('200 deletes the hub when no riders or orders are attached', async () => {
    prismaMock.hub.findUnique.mockResolvedValue({
      ...makeHub({ id: 'h-1' }),
      _count: { riders: 0, orders: 0 },
    } as never);
    prismaMock.hub.delete.mockResolvedValue(makeHub({ id: 'h-1' }) as never);

    const res = await request(app)
      .delete('/api/admin/hubs/h-1')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Hub deleted successfully' });
    expect(prismaMock.hub.delete).toHaveBeenCalledWith({ where: { id: 'h-1' } });
  });
});
