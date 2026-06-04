import '../../../src/types/express';
import request from 'supertest';
import { prismaMock } from '../../helpers/prismaMock';
import { buildApp } from '../../helpers/app';
import { riderAuthHeader } from '../../helpers/auth';
import { authMiddleware } from '../../../src/middleware/rider-auth';
import attendanceRouter from '../../../src/routes/attendance';

const app = buildApp({
  mountPath: '/api/attendance',
  router: attendanceRouter,
  preMiddleware: [authMiddleware],
});

interface RiderWithHub {
  id: string;
  hub: {
    name: string;
    lat: number;
    lng: number;
    radiusMeters: number;
  } | null;
}

function makeRiderWithHub(
  overrides: Partial<{ id: string; hub: RiderWithHub['hub'] }> = {}
): RiderWithHub {
  return {
    id: overrides.id ?? 'rider-1',
    hub:
      overrides.hub === null
        ? null
        : {
            name: 'Makati Hub',
            lat: 14.5547,
            lng: 121.0244,
            radiusMeters: 200,
            ...(overrides.hub ?? {}),
          },
  };
}

describe('POST /api/attendance/checkin', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app)
      .post('/api/attendance/checkin')
      .send({ lat: 14.5547, lng: 121.0244 });

    expect(res.status).toBe(401);
  });

  it('400 when lat is missing', async () => {
    const res = await request(app)
      .post('/api/attendance/checkin')
      .set('Authorization', riderAuthHeader())
      .send({ lng: 121.0244 });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'lat and lng are required' });
  });

  it('400 when lng is missing', async () => {
    const res = await request(app)
      .post('/api/attendance/checkin')
      .set('Authorization', riderAuthHeader())
      .send({ lat: 14.5547 });

    expect(res.status).toBe(400);
  });

  it('404 when the rider record cannot be found', async () => {
    prismaMock.rider.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/attendance/checkin')
      .set('Authorization', riderAuthHeader())
      .send({ lat: 14.5547, lng: 121.0244 });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Rider not found' });
  });

  it('404 when the rider has no hub assigned', async () => {
    prismaMock.rider.findUnique.mockResolvedValue(
      makeRiderWithHub({ hub: null }) as never
    );

    const res = await request(app)
      .post('/api/attendance/checkin')
      .set('Authorization', riderAuthHeader())
      .send({ lat: 14.5547, lng: 121.0244 });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'No hub found for this rider' });
  });

  it('403 when the rider is outside the hub geofence', async () => {
    prismaMock.rider.findUnique.mockResolvedValue(
      makeRiderWithHub({
        hub: {
          name: 'Makati Hub',
          lat: 14.5547,
          lng: 121.0244,
          radiusMeters: 200,
        },
      }) as never
    );

    // Quezon City is ~13km from Makati — well outside a 200m fence
    const res = await request(app)
      .post('/api/attendance/checkin')
      .set('Authorization', riderAuthHeader())
      .send({ lat: 14.676, lng: 121.0437 });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: 'Not within hub geofence',
      hub: { name: 'Makati Hub', lat: 14.5547, lng: 121.0244 },
      radiusMeters: 200,
      distance: expect.any(Number),
    });
    expect(res.body.distance).toBeGreaterThan(200);
    expect(Number.isInteger(res.body.distance)).toBe(true);
  });

  it('200 when the rider is exactly at the hub coordinates', async () => {
    prismaMock.rider.findUnique.mockResolvedValue(
      makeRiderWithHub({
        hub: {
          name: 'Makati Hub',
          lat: 14.5547,
          lng: 121.0244,
          radiusMeters: 200,
        },
      }) as never
    );

    const res = await request(app)
      .post('/api/attendance/checkin')
      .set('Authorization', riderAuthHeader({ riderId: 'rider-42' }))
      .send({ lat: 14.5547, lng: 121.0244 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      hub: { name: 'Makati Hub', lat: 14.5547, lng: 121.0244 },
      distance: 0,
      checkedInAt: expect.any(String),
    });
    expect(() => new Date(res.body.checkedInAt as string).toISOString()).not.toThrow();

    expect(prismaMock.rider.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'rider-42' } })
    );
  });

  it('200 when the rider is just inside the geofence radius', async () => {
    prismaMock.rider.findUnique.mockResolvedValue(
      makeRiderWithHub({
        hub: {
          name: 'Makati Hub',
          lat: 14.5547,
          lng: 121.0244,
          radiusMeters: 200,
        },
      }) as never
    );

    // ~150m north of the hub centre (well within 200m)
    const res = await request(app)
      .post('/api/attendance/checkin')
      .set('Authorization', riderAuthHeader())
      .send({ lat: 14.5560, lng: 121.0244 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.distance).toBeGreaterThan(0);
    expect(res.body.distance).toBeLessThan(200);
  });

  it('coerces string lat/lng to numbers', async () => {
    prismaMock.rider.findUnique.mockResolvedValue(
      makeRiderWithHub({
        hub: {
          name: 'Makati Hub',
          lat: 14.5547,
          lng: 121.0244,
          radiusMeters: 200,
        },
      }) as never
    );

    const res = await request(app)
      .post('/api/attendance/checkin')
      .set('Authorization', riderAuthHeader())
      .send({ lat: '14.5547', lng: '121.0244' });

    expect(res.status).toBe(200);
    expect(res.body.distance).toBe(0);
  });
});
