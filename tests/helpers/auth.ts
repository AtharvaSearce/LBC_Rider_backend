import jwt from 'jsonwebtoken';

export interface RiderTokenInput {
  riderId?: string;
  employeeId?: string;
  hubId?: string;
  pinVersion?: number;
  role?: string;
  expiresIn?: string | number;
}

export interface AdminTokenInput {
  adminId?: string;
  email?: string;
  role?: string;
  expiresIn?: string | number;
}

function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET must be set in tests/setup.ts');
  return s;
}

export function signTestRiderToken(input: RiderTokenInput = {}): string {
  const payload = {
    riderId: input.riderId ?? 'rider-1',
    employeeId: input.employeeId ?? 'EMP-001',
    hubId: input.hubId ?? 'hub-1',
    pinVersion: input.pinVersion ?? 0,
    role: input.role ?? 'rider',
  };
  // @ts-expect-error jsonwebtoken accepts string for expiresIn
  return jwt.sign(payload, secret(), { expiresIn: input.expiresIn ?? '1h' });
}

export function signTestAdminToken(input: AdminTokenInput = {}): string {
  const payload = {
    adminId: input.adminId ?? 'ADM-001',
    email: input.email ?? 'admin@lbc.ph',
    role: input.role ?? 'admin',
  };
  // @ts-expect-error jsonwebtoken accepts string for expiresIn
  return jwt.sign(payload, secret(), { expiresIn: input.expiresIn ?? '1h' });
}

export function bearer(token: string): string {
  return `Bearer ${token}`;
}

export function riderAuthHeader(input?: RiderTokenInput): string {
  return bearer(signTestRiderToken(input));
}

export function adminAuthHeader(input?: AdminTokenInput): string {
  return bearer(signTestAdminToken(input));
}
