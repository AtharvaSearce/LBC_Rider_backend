jest.mock('bcryptjs');

import '../../../src/types/express';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { prismaMock } from '../../helpers/prismaMock';
import { buildApp } from '../../helpers/app';
import { riderAuthHeader } from '../../helpers/auth';
import { authMiddleware } from '../../../src/middleware/rider-auth';
import riderAuthRouter from '../../../src/routes/rider-auth';

const bcryptMock = bcrypt as jest.Mocked<typeof bcrypt>;

const app = buildApp({
  mountPath: '/api/auth',
  router: riderAuthRouter,
  preMiddleware: [authMiddleware],
});

const ORIGINAL_SECRET = process.env.JWT_SECRET;

afterEach(() => {
  process.env.JWT_SECRET = ORIGINAL_SECRET;
});

interface RiderRow {
  id: string;
  employeeId: string;
  name: string;
  email: string;
  phone: string;
  hubId: string;
  vehicleType: string;
  isActive: boolean;
  passwordHash: string;
  pinHash: string | null;
  pinVersion: number;
  hub: {
    id: string;
    name: string;
    zone: { id: string; name: string };
  };
}

function makeRiderRow(overrides: Partial<RiderRow> = {}): RiderRow {
  return {
    id: 'rider-1',
    employeeId: 'EMP-001',
    name: 'Juan Dela Cruz',
    email: 'juan@lbc.ph',
    phone: '+639170000001',
    hubId: 'hub-1',
    vehicleType: 'motorcycle',
    isActive: true,
    passwordHash: 'bcrypt-password-hash',
    pinHash: null,
    pinVersion: 0,
    hub: {
      id: 'hub-1',
      name: 'Makati Hub',
      zone: { id: 'zone-1', name: 'NCR' },
    },
    ...overrides,
  };
}

describe('POST /api/auth/login', () => {
  it('400 when email is missing', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ password: 'pw' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Email and password are required' });
  });

  it('400 when password is missing', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'juan@lbc.ph' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Email and password are required' });
  });

  it('401 when rider does not exist', async () => {
    prismaMock.rider.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nope@lbc.ph', password: 'pw' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid credentials' });
  });

  it('401 when password does not match', async () => {
    prismaMock.rider.findUnique.mockResolvedValue(makeRiderRow() as never);
    bcryptMock.compare.mockResolvedValue(false as never);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'juan@lbc.ph', password: 'wrong' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid credentials' });
  });

  it('403 when rider is deactivated', async () => {
    prismaMock.rider.findUnique.mockResolvedValue(
      makeRiderRow({ isActive: false }) as never
    );
    bcryptMock.compare.mockResolvedValue(true as never);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'juan@lbc.ph', password: 'pw' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Account is deactivated' });
  });

  it('500 when JWT_SECRET is unset (signRiderToken throws)', async () => {
    delete process.env.JWT_SECRET;
    prismaMock.rider.findUnique.mockResolvedValue(makeRiderRow() as never);
    bcryptMock.compare.mockResolvedValue(true as never);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'juan@lbc.ph', password: 'pw' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  it('200 with pinRequired=true when rider has no PIN set', async () => {
    prismaMock.rider.findUnique.mockResolvedValue(
      makeRiderRow({ pinHash: null, pinVersion: 0 }) as never
    );
    bcryptMock.compare.mockResolvedValue(true as never);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'JUAN@LBC.ph', password: 'pw' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      token: expect.any(String),
      pinRequired: true,
      pinVersion: 0,
      rider: expect.objectContaining({
        id: 'rider-1',
        employeeId: 'EMP-001',
        email: 'juan@lbc.ph',
      }),
      serverTimestamp: expect.any(String),
    });
    expect(res.body.rider).not.toHaveProperty('passwordHash');
    expect(res.body.rider).not.toHaveProperty('pinHash');

    // Email should be lowercased and trimmed before the lookup
    expect(prismaMock.rider.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'juan@lbc.ph' } })
    );
  });

  it('200 with pinRequired=false when rider already has a PIN', async () => {
    prismaMock.rider.findUnique.mockResolvedValue(
      makeRiderRow({ pinHash: 'existing-pin-hash', pinVersion: 3 }) as never
    );
    bcryptMock.compare.mockResolvedValue(true as never);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'juan@lbc.ph', password: 'pw' });

    expect(res.status).toBe(200);
    expect(res.body.pinRequired).toBe(false);
    expect(res.body.pinVersion).toBe(3);
  });
});

describe('POST /api/auth/pin/setup', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app)
      .post('/api/auth/pin/setup')
      .send({ pin: '1234' });

    expect(res.status).toBe(401);
  });

  it('400 when pin is missing', async () => {
    const res = await request(app)
      .post('/api/auth/pin/setup')
      .set('Authorization', riderAuthHeader())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'PIN must be exactly 4 digits' });
  });

  it('400 when pin is fewer than 4 digits', async () => {
    const res = await request(app)
      .post('/api/auth/pin/setup')
      .set('Authorization', riderAuthHeader())
      .send({ pin: '123' });

    expect(res.status).toBe(400);
  });

  it('400 when pin is more than 4 digits', async () => {
    const res = await request(app)
      .post('/api/auth/pin/setup')
      .set('Authorization', riderAuthHeader())
      .send({ pin: '12345' });

    expect(res.status).toBe(400);
  });

  it('400 when pin contains non-digit characters', async () => {
    const res = await request(app)
      .post('/api/auth/pin/setup')
      .set('Authorization', riderAuthHeader())
      .send({ pin: '12ab' });

    expect(res.status).toBe(400);
  });

  it('200 hashes the pin, increments pinVersion, and returns the verifier', async () => {
    bcryptMock.hash.mockResolvedValue('hashed-pin-12bcrypt' as never);
    prismaMock.rider.update.mockResolvedValue({ pinVersion: 5 } as never);

    const res = await request(app)
      .post('/api/auth/pin/setup')
      .set('Authorization', riderAuthHeader({ riderId: 'rider-7' }))
      .send({ pin: '4242' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      message: 'PIN set successfully',
      pinVersion: 5,
      pinVerifier: {
        hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        salt: expect.stringMatching(/^[a-f0-9]{32}$/),
      },
    });

    expect(bcryptMock.hash).toHaveBeenCalledWith('4242', 12);
    expect(prismaMock.rider.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rider-7' },
        data: {
          pinHash: 'hashed-pin-12bcrypt',
          pinVersion: { increment: 1 },
        },
        select: { pinVersion: true },
      })
    );
  });
});

describe('POST /api/auth/pin/verify', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app)
      .post('/api/auth/pin/verify')
      .send({ pin: '1234' });

    expect(res.status).toBe(401);
  });

  it('400 when pin is missing', async () => {
    const res = await request(app)
      .post('/api/auth/pin/verify')
      .set('Authorization', riderAuthHeader())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'PIN is required' });
  });

  it('400 when rider has no PIN set', async () => {
    prismaMock.rider.findUnique.mockResolvedValue({ pinHash: null } as never);

    const res = await request(app)
      .post('/api/auth/pin/verify')
      .set('Authorization', riderAuthHeader())
      .send({ pin: '1234' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'No PIN set. Use /pin/setup first.' });
  });

  it('401 when pin does not match', async () => {
    prismaMock.rider.findUnique.mockResolvedValue({ pinHash: 'h' } as never);
    bcryptMock.compare.mockResolvedValue(false as never);

    const res = await request(app)
      .post('/api/auth/pin/verify')
      .set('Authorization', riderAuthHeader())
      .send({ pin: '0000' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Incorrect PIN' });
  });

  it('200 when pin matches', async () => {
    prismaMock.rider.findUnique.mockResolvedValue({ pinHash: 'h' } as never);
    bcryptMock.compare.mockResolvedValue(true as never);

    const res = await request(app)
      .post('/api/auth/pin/verify')
      .set('Authorization', riderAuthHeader({ riderId: 'rider-3' }))
      .send({ pin: '1234' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ verified: true });
    expect(prismaMock.rider.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rider-3' },
        select: { pinHash: true },
      })
    );
  });
});

describe('POST /api/auth/refresh', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).post('/api/auth/refresh').send({});

    expect(res.status).toBe(401);
  });

  it('404 when rider no longer exists', async () => {
    prismaMock.rider.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Authorization', riderAuthHeader())
      .send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Rider not found' });
  });

  it('403 when rider has been deactivated', async () => {
    prismaMock.rider.findUnique.mockResolvedValue({
      isActive: false,
      pinVersion: 0,
    } as never);

    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Authorization', riderAuthHeader())
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Account is deactivated' });
  });

  it('200 returns a new token reflecting the latest pinVersion', async () => {
    prismaMock.rider.findUnique.mockResolvedValue({
      isActive: true,
      pinVersion: 7,
    } as never);

    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Authorization', riderAuthHeader({ riderId: 'rider-9', pinVersion: 5 }))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      token: expect.any(String),
      pinVersion: 7,
      serverTimestamp: expect.any(String),
    });
  });
});
