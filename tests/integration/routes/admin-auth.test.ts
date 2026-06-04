import request from 'supertest';
import jwt from 'jsonwebtoken';
import { buildApp } from '../../helpers/app';
import adminAuthRouter from '../../../src/routes/admin-auth';

// ADMIN_CREDENTIALS is captured at module load time from process.env.
// tests/setup.ts pins ADMIN_EMAIL='admin@lbc.ph' and ADMIN_PASSWORD='admin123',
// so the route resolves against those values regardless of any later mutations.
const ADMIN_EMAIL = 'admin@lbc.ph';
const ADMIN_PASSWORD = 'admin123';
const ADMIN_ID = 'ADM-001';
const ADMIN_NAME = 'LBC Admin';

const app = buildApp({
  mountPath: '/api/admin/auth',
  router: adminAuthRouter,
});

const ORIGINAL_SECRET = process.env.JWT_SECRET;

afterEach(() => {
  process.env.JWT_SECRET = ORIGINAL_SECRET;
});

describe('POST /api/admin/auth/login', () => {
  it('400 when email is missing', async () => {
    const res = await request(app)
      .post('/api/admin/auth/login')
      .send({ password: ADMIN_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Email and password are required' });
  });

  it('400 when password is missing', async () => {
    const res = await request(app)
      .post('/api/admin/auth/login')
      .send({ email: ADMIN_EMAIL });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Email and password are required' });
  });

  it('401 when email does not match the configured admin', async () => {
    const res = await request(app)
      .post('/api/admin/auth/login')
      .send({ email: 'someone-else@lbc.ph', password: ADMIN_PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid admin credentials' });
  });

  it('401 when password does not match', async () => {
    const res = await request(app)
      .post('/api/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'wrong-password' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid admin credentials' });
  });

  it('500 when JWT_SECRET is unset (signAdminToken throws)', async () => {
    delete process.env.JWT_SECRET;

    const res = await request(app)
      .post('/api/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  it('200 with token and admin payload on correct credentials', async () => {
    const res = await request(app)
      .post('/api/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      token: expect.any(String),
      admin: {
        id: ADMIN_ID,
        name: ADMIN_NAME,
        email: ADMIN_EMAIL,
        role: 'admin',
      },
    });

    const decoded = jwt.verify(
      res.body.token,
      process.env.JWT_SECRET as string
    ) as { adminId: string; email: string; role: string; iat: number; exp: number };

    expect(decoded.adminId).toBe(ADMIN_ID);
    expect(decoded.email).toBe(ADMIN_EMAIL);
    expect(decoded.role).toBe('admin');
    expect(decoded.exp).toBeGreaterThan(decoded.iat);
  });

  it('200 when email is uppercased — server normalizes before comparing', async () => {
    const res = await request(app)
      .post('/api/admin/auth/login')
      .send({ email: ADMIN_EMAIL.toUpperCase(), password: ADMIN_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.admin.email).toBe(ADMIN_EMAIL);
  });

  it('200 when email has surrounding whitespace — server trims before comparing', async () => {
    const res = await request(app)
      .post('/api/admin/auth/login')
      .send({ email: `  ${ADMIN_EMAIL}  `, password: ADMIN_PASSWORD });

    expect(res.status).toBe(200);
  });
});
