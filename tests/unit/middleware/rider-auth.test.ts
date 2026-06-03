import '../../../src/types/express';
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { authMiddleware, signRiderToken } from '../../../src/middleware/rider-auth';

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
    path: '/api/manifest',
    method: 'GET',
    headers: {},
    ...overrides,
  } as Request;
}

describe('middleware/rider-auth — signRiderToken', () => {
  const ORIGINAL_SECRET = process.env.JWT_SECRET;

  afterEach(() => {
    process.env.JWT_SECRET = ORIGINAL_SECRET;
  });

  it('signs a token that round-trips with the same secret', () => {
    const token = signRiderToken({
      riderId: 'r-1',
      employeeId: 'EMP-1',
      hubId: 'h-1',
      pinVersion: 3,
    });

    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as {
      riderId: string;
      employeeId: string;
      hubId: string;
      pinVersion: number;
      role: string;
      iat: number;
      exp: number;
    };

    expect(decoded.riderId).toBe('r-1');
    expect(decoded.employeeId).toBe('EMP-1');
    expect(decoded.hubId).toBe('h-1');
    expect(decoded.pinVersion).toBe(3);
    expect(decoded.role).toBe('rider');
    expect(decoded.exp).toBeGreaterThan(decoded.iat);
  });

  it('throws when JWT_SECRET is not configured', () => {
    delete process.env.JWT_SECRET;
    expect(() =>
      signRiderToken({ riderId: 'r', employeeId: 'e', hubId: 'h', pinVersion: 0 })
    ).toThrow('JWT_SECRET is not configured');
  });
});

describe('middleware/rider-auth — authMiddleware', () => {
  const ORIGINAL_SECRET = process.env.JWT_SECRET;

  afterEach(() => {
    process.env.JWT_SECRET = ORIGINAL_SECRET;
  });

  describe('public path bypass', () => {
    const publicPaths = [
      '/health',
      '/api/auth/login',
      '/api/admin/auth',
      '/api/admin/auth/login',
      '/api/geocode',
      '/api/geocode/address',
      '/api/admin',
      '/api/admin/riders',
      '/api/zones',
      '/api/hubs',
    ];

    publicPaths.forEach((path) => {
      it(`calls next() without auth for ${path}`, () => {
        const req = makeReq({ path });
        const res = makeRes() as unknown as Response;
        const next = jest.fn();

        authMiddleware(req, res, next as NextFunction);

        expect(next).toHaveBeenCalledTimes(1);
        expect((res as unknown as MockResponse).status).not.toHaveBeenCalled();
        expect(req.rider).toBeUndefined();
      });
    });
  });

  it('returns 401 when Authorization header is missing', () => {
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    authMiddleware(req, res as unknown as Response, next as NextFunction);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toEqual({ error: 'Missing or invalid authorization header' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when Authorization header is not a Bearer token', () => {
    const req = makeReq({ headers: { authorization: 'Basic abc123' } });
    const res = makeRes();
    const next = jest.fn();

    authMiddleware(req, res as unknown as Response, next as NextFunction);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 500 when JWT_SECRET is unset', () => {
    delete process.env.JWT_SECRET;
    const req = makeReq({ headers: { authorization: 'Bearer anything' } });
    const res = makeRes();
    const next = jest.fn();

    authMiddleware(req, res as unknown as Response, next as NextFunction);

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

    authMiddleware(req, res as unknown as Response, next as NextFunction);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toEqual({ error: 'Invalid or expired token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for an expired token', () => {
    const expired = jwt.sign(
      {
        riderId: 'r',
        employeeId: 'e',
        hubId: 'h',
        pinVersion: 0,
        role: 'rider',
      },
      process.env.JWT_SECRET as string,
      { expiresIn: '-1s' }
    );

    const req = makeReq({ headers: { authorization: `Bearer ${expired}` } });
    const res = makeRes();
    const next = jest.fn();

    authMiddleware(req, res as unknown as Response, next as NextFunction);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token role is not "rider"', () => {
    const adminToken = jwt.sign(
      {
        riderId: 'r',
        employeeId: 'e',
        hubId: 'h',
        pinVersion: 0,
        role: 'admin',
      },
      process.env.JWT_SECRET as string,
      { expiresIn: '1h' }
    );

    const req = makeReq({ headers: { authorization: `Bearer ${adminToken}` } });
    const res = makeRes();
    const next = jest.fn();

    authMiddleware(req, res as unknown as Response, next as NextFunction);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toEqual({ error: 'Invalid or expired token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token is signed with a different secret', () => {
    const wrongToken = jwt.sign(
      {
        riderId: 'r',
        employeeId: 'e',
        hubId: 'h',
        pinVersion: 0,
        role: 'rider',
      },
      'wrong-secret',
      { expiresIn: '1h' }
    );

    const req = makeReq({ headers: { authorization: `Bearer ${wrongToken}` } });
    const res = makeRes();
    const next = jest.fn();

    authMiddleware(req, res as unknown as Response, next as NextFunction);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('populates req.rider and calls next() on a valid rider token', () => {
    const token = signRiderToken({
      riderId: 'r-42',
      employeeId: 'EMP-42',
      hubId: 'h-42',
      pinVersion: 5,
    });

    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = makeRes();
    const next = jest.fn();

    authMiddleware(req, res as unknown as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(req.rider).toMatchObject({
      riderId: 'r-42',
      employeeId: 'EMP-42',
      hubId: 'h-42',
      pinVersion: 5,
      role: 'rider',
    });
    expect(typeof req.rider?.iat).toBe('number');
    expect(typeof req.rider?.exp).toBe('number');
  });
});
