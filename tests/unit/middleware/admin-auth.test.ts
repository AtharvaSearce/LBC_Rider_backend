import '../../../src/types/express';
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { adminMiddleware, signAdminToken } from '../../../src/middleware/admin-auth';

interface MockResponse {
  status: jest.Mock;
  json: jest.Mock;
  statusCode?: number;
  body?: unknown;
}

function makeRes(): MockResponse {
  const res: MockResponse = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json.mockImplementation((body: unknown) => {
    res.body = body;
    return res;
  });
  return res;
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    path: '/api/admin/manifests',
    method: 'GET',
    headers: {},
    ...overrides,
  } as Request;
}

describe('middleware/admin-auth — signAdminToken', () => {
  const ORIGINAL_SECRET = process.env.JWT_SECRET;

  afterEach(() => {
    process.env.JWT_SECRET = ORIGINAL_SECRET;
  });

  it('signs a token that round-trips with the same secret', () => {
    const token = signAdminToken({
      adminId: 'ADM-007',
      email: 'james@lbc.ph',
    });

    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as {
      adminId: string;
      email: string;
      role: string;
      iat: number;
      exp: number;
    };

    expect(decoded.adminId).toBe('ADM-007');
    expect(decoded.email).toBe('james@lbc.ph');
    expect(decoded.role).toBe('admin');
    expect(decoded.exp).toBeGreaterThan(decoded.iat);
  });

  it('throws when JWT_SECRET is not configured', () => {
    delete process.env.JWT_SECRET;
    expect(() =>
      signAdminToken({ adminId: 'ADM-007', email: 'james@lbc.ph' })
    ).toThrow('JWT_SECRET is not configured');
  });
});

describe('middleware/admin-auth — adminMiddleware', () => {
  const ORIGINAL_SECRET = process.env.JWT_SECRET;

  afterEach(() => {
    process.env.JWT_SECRET = ORIGINAL_SECRET;
  });

  it('returns 401 when Authorization header is missing', () => {
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    adminMiddleware(req, res as unknown as Response, next as NextFunction);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toEqual({ error: 'Missing or invalid authorization header' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when Authorization header is not a Bearer token', () => {
    const req = makeReq({ headers: { authorization: 'Basic abc123' } });
    const res = makeRes();
    const next = jest.fn();

    adminMiddleware(req, res as unknown as Response, next as NextFunction);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 500 when JWT_SECRET is unset', () => {
    delete process.env.JWT_SECRET;
    const req = makeReq({ headers: { authorization: 'Bearer anything' } });
    const res = makeRes();
    const next = jest.fn();

    adminMiddleware(req, res as unknown as Response, next as NextFunction);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.body).toEqual({
      error: 'Server misconfiguration: JWT_SECRET not set',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for a malformed token', () => {
    const req = makeReq({ headers: { authorization: 'Bearer not-a-real-jwt' } });
    const res = makeRes();
    const next = jest.fn();

    adminMiddleware(req, res as unknown as Response, next as NextFunction);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toEqual({ error: 'Invalid or expired token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for an expired token', () => {
    const expired = jwt.sign(
      {
        adminId: 'ADM-1',
        email: 'admin@lbc.ph',
        role: 'admin',
      },
      process.env.JWT_SECRET as string,
      { expiresIn: '-1s' }
    );

    const req = makeReq({ headers: { authorization: `Bearer ${expired}` } });
    const res = makeRes();
    const next = jest.fn();

    adminMiddleware(req, res as unknown as Response, next as NextFunction);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when token role is not "admin" (e.g. a rider token)', () => {
    const riderToken = jwt.sign(
      {
        riderId: 'r-1',
        employeeId: 'EMP-1',
        hubId: 'h-1',
        pinVersion: 0,
        role: 'rider',
      },
      process.env.JWT_SECRET as string,
      { expiresIn: '1h' }
    );

    const req = makeReq({ headers: { authorization: `Bearer ${riderToken}` } });
    const res = makeRes();
    const next = jest.fn();

    adminMiddleware(req, res as unknown as Response, next as NextFunction);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body).toEqual({ error: 'Admin access required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token is signed with a different secret', () => {
    const wrongToken = jwt.sign(
      {
        adminId: 'ADM-1',
        email: 'admin@lbc.ph',
        role: 'admin',
      },
      'wrong-secret',
      { expiresIn: '1h' }
    );

    const req = makeReq({ headers: { authorization: `Bearer ${wrongToken}` } });
    const res = makeRes();
    const next = jest.fn();

    adminMiddleware(req, res as unknown as Response, next as NextFunction);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('populates req.admin and calls next() on a valid admin token', () => {
    const token = signAdminToken({
      adminId: 'ADM-99',
      email: 'super@lbc.ph',
    });

    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = makeRes();
    const next = jest.fn();

    adminMiddleware(req, res as unknown as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(req.admin).toMatchObject({
      adminId: 'ADM-99',
      email: 'super@lbc.ph',
      role: 'admin',
    });
    expect(typeof req.admin?.iat).toBe('number');
    expect(typeof req.admin?.exp).toBe('number');
  });

  it('does not bypass any path — admin middleware has no public paths', () => {
    const req = makeReq({ path: '/health' });
    const res = makeRes();
    const next = jest.fn();

    adminMiddleware(req, res as unknown as Response, next as NextFunction);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
