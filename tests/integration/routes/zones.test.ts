import '../../../src/types/express';
import request from 'supertest';
import { prismaMock } from '../../helpers/prismaMock';
import { buildApp } from '../../helpers/app';
import { adminAuthHeader } from '../../helpers/auth';
import { adminMiddleware } from '../../../src/middleware/admin-auth';
import zoneRouter from '../../../src/routes/zones';

const app = buildApp({
  mountPath: '/api/admin/zones',
  router: zoneRouter,
  preMiddleware: [adminMiddleware],
});

function makeZone(
  overrides: Partial<{ id: string; name: string; hubs: Array<{ id: string; name: string }> }> = {}
) {
  return {
    id: overrides.id ?? 'zone-1',
    name: overrides.name ?? 'NCR',
    hubs: overrides.hubs ?? [],
    createdAt: new Date('2026-06-03T10:00:00.000Z'),
    updatedAt: new Date('2026-06-03T10:00:00.000Z'),
  };
}

describe('GET /api/admin/zones', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).get('/api/admin/zones');
    expect(res.status).toBe(401);
  });

  it('200 returns zones and total count', async () => {
    const zones = [
      makeZone({ id: 'z-1', name: 'NCR', hubs: [{ id: 'h-1', name: 'Makati' }] }),
      makeZone({ id: 'z-2', name: 'Visayas', hubs: [] }),
    ];
    prismaMock.zone.findMany.mockResolvedValue(zones as never);

    const res = await request(app)
      .get('/api/admin/zones')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.zones).toHaveLength(2);
    expect(res.body.zones[0]).toMatchObject({ id: 'z-1', name: 'NCR' });
    expect(res.body.zones[0].hubs).toEqual([{ id: 'h-1', name: 'Makati' }]);

    expect(prismaMock.zone.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { name: 'asc' } })
    );
  });
});

describe('POST /api/admin/zones', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).post('/api/admin/zones').send({ name: 'NCR' });
    expect(res.status).toBe(401);
  });

  it('400 when name is missing', async () => {
    const res = await request(app)
      .post('/api/admin/zones')
      .set('Authorization', adminAuthHeader())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing required field: name' });
  });

  it('409 when a zone with the same name already exists', async () => {
    prismaMock.zone.findUnique.mockResolvedValue(makeZone({ name: 'NCR' }) as never);

    const res = await request(app)
      .post('/api/admin/zones')
      .set('Authorization', adminAuthHeader())
      .send({ name: 'NCR' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Zone "NCR" already exists' });
    expect(prismaMock.zone.create).not.toHaveBeenCalled();
  });

  it('201 returns the created zone with hubs included', async () => {
    prismaMock.zone.findUnique.mockResolvedValue(null);
    prismaMock.zone.create.mockResolvedValue(
      makeZone({ id: 'z-99', name: 'Mindanao', hubs: [] }) as never
    );

    const res = await request(app)
      .post('/api/admin/zones')
      .set('Authorization', adminAuthHeader())
      .send({ name: 'Mindanao' });

    expect(res.status).toBe(201);
    expect(res.body.zone).toMatchObject({ id: 'z-99', name: 'Mindanao', hubs: [] });
    expect(prismaMock.zone.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { name: 'Mindanao' },
        include: { hubs: { select: { id: true, name: true } } },
      })
    );
  });
});

describe('PUT /api/admin/zones/:id', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).put('/api/admin/zones/z-1').send({ name: 'X' });
    expect(res.status).toBe(401);
  });

  it('404 when the zone does not exist', async () => {
    prismaMock.zone.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .put('/api/admin/zones/z-missing')
      .set('Authorization', adminAuthHeader())
      .send({ name: 'New' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Zone not found' });
    expect(prismaMock.zone.update).not.toHaveBeenCalled();
  });

  it('409 when renaming to a name that already belongs to another zone', async () => {
    prismaMock.zone.findUnique
      .mockResolvedValueOnce(makeZone({ id: 'z-1', name: 'OldName' }) as never)
      .mockResolvedValueOnce(makeZone({ id: 'z-2', name: 'TakenName' }) as never);

    const res = await request(app)
      .put('/api/admin/zones/z-1')
      .set('Authorization', adminAuthHeader())
      .send({ name: 'TakenName' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Zone "TakenName" already exists' });
    expect(prismaMock.zone.update).not.toHaveBeenCalled();
  });

  it('200 updates the zone when the name is new and unique', async () => {
    prismaMock.zone.findUnique
      .mockResolvedValueOnce(makeZone({ id: 'z-1', name: 'OldName' }) as never)
      .mockResolvedValueOnce(null); // no duplicate
    prismaMock.zone.update.mockResolvedValue(
      makeZone({ id: 'z-1', name: 'NewName', hubs: [] }) as never
    );

    const res = await request(app)
      .put('/api/admin/zones/z-1')
      .set('Authorization', adminAuthHeader())
      .send({ name: 'NewName' });

    expect(res.status).toBe(200);
    expect(res.body.zone).toMatchObject({ id: 'z-1', name: 'NewName' });
    expect(prismaMock.zone.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'z-1' },
        data: { name: 'NewName' },
      })
    );
  });

  it('200 skips the duplicate check when the name is unchanged', async () => {
    prismaMock.zone.findUnique.mockResolvedValueOnce(
      makeZone({ id: 'z-1', name: 'NCR' }) as never
    );
    prismaMock.zone.update.mockResolvedValue(makeZone({ id: 'z-1', name: 'NCR' }) as never);

    const res = await request(app)
      .put('/api/admin/zones/z-1')
      .set('Authorization', adminAuthHeader())
      .send({ name: 'NCR' });

    expect(res.status).toBe(200);
    // Only the existence lookup should fire, not the duplicate-name check
    expect(prismaMock.zone.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('DELETE /api/admin/zones/:id', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).delete('/api/admin/zones/z-1');
    expect(res.status).toBe(401);
  });

  it('404 when the zone does not exist', async () => {
    prismaMock.zone.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .delete('/api/admin/zones/z-missing')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(404);
    expect(prismaMock.zone.delete).not.toHaveBeenCalled();
  });

  it('409 when hubs are still assigned to the zone', async () => {
    prismaMock.zone.findUnique.mockResolvedValue({
      ...makeZone({ id: 'z-1', name: 'NCR' }),
      _count: { hubs: 3 },
    } as never);

    const res = await request(app)
      .delete('/api/admin/zones/z-1')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'Cannot delete zone while hubs are assigned to it',
    });
    expect(prismaMock.zone.delete).not.toHaveBeenCalled();
  });

  it('200 deletes the zone when it has no hubs', async () => {
    prismaMock.zone.findUnique.mockResolvedValue({
      ...makeZone({ id: 'z-1', name: 'NCR' }),
      _count: { hubs: 0 },
    } as never);
    prismaMock.zone.delete.mockResolvedValue(makeZone({ id: 'z-1' }) as never);

    const res = await request(app)
      .delete('/api/admin/zones/z-1')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Zone deleted successfully' });
    expect(prismaMock.zone.delete).toHaveBeenCalledWith({ where: { id: 'z-1' } });
  });
});
