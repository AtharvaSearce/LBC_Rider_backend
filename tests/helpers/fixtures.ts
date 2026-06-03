import {
  DeliveryNextAction,
  DeliveryOutcome,
  ManifestStatus,
  OrderStatus,
  StopStatus,
} from '@prisma/client';
import { Prisma } from '@prisma/client';

const now = () => new Date('2026-06-03T10:00:00.000Z');

export function makeZone(overrides: Partial<{ id: string; name: string }> = {}) {
  return {
    id: overrides.id ?? 'zone-1',
    name: overrides.name ?? 'NCR',
    createdAt: now(),
    updatedAt: now(),
  };
}

export function makeHub(
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
    createdAt: now(),
    updatedAt: now(),
  };
}

export function makeRider(
  overrides: Partial<{
    id: string;
    employeeId: string;
    name: string;
    email: string;
    phone: string;
    passwordHash: string;
    pinHash: string | null;
    pinVersion: number;
    hubId: string;
    vehicleType: string;
    isActive: boolean;
  }> = {}
) {
  return {
    id: overrides.id ?? 'rider-1',
    employeeId: overrides.employeeId ?? 'EMP-001',
    name: overrides.name ?? 'Juan Dela Cruz',
    email: overrides.email ?? 'juan@lbc.ph',
    phone: overrides.phone ?? '+639170000001',
    passwordHash: overrides.passwordHash ?? '$2a$12$abcdefghijklmnopqrstuv',
    pinHash: overrides.pinHash === undefined ? null : overrides.pinHash,
    pinVersion: overrides.pinVersion ?? 0,
    hubId: overrides.hubId ?? 'hub-1',
    vehicleType: overrides.vehicleType ?? 'motorcycle',
    isActive: overrides.isActive ?? true,
    createdAt: now(),
    updatedAt: now(),
  };
}

export function makeRiderWithHub(overrides: Parameters<typeof makeRider>[0] = {}) {
  return {
    ...makeRider(overrides),
    hub: {
      id: 'hub-1',
      name: 'Makati Hub',
      zone: { id: 'zone-1', name: 'NCR' },
    },
  };
}

export function makeOrder(
  overrides: Partial<{
    id: string;
    trackingNumber: string;
    recipientName: string;
    recipientPhone: string;
    addressText: string;
    addressLat: number;
    addressLng: number;
    addressGeocoded: boolean;
    serviceType: string;
    codAmount: Prisma.Decimal | number;
    hubId: string;
    status: OrderStatus;
    assignedManifestId: string | null;
  }> = {}
) {
  return {
    id: overrides.id ?? 'order-1',
    trackingNumber: overrides.trackingNumber ?? 'TRK0001',
    recipientName: overrides.recipientName ?? 'Maria Santos',
    recipientPhone: overrides.recipientPhone ?? '+639170000010',
    recipientField: '',
    addressText: overrides.addressText ?? '123 Ayala Ave, Makati',
    addressLat: overrides.addressLat ?? 14.5547,
    addressLng: overrides.addressLng ?? 121.0244,
    addressGeocoded: overrides.addressGeocoded ?? true,
    serviceType: overrides.serviceType ?? 'standard',
    codAmount: new Prisma.Decimal(overrides.codAmount ?? 0),
    packageDetails: '',
    specialInstructions: '',
    hubId: overrides.hubId ?? 'hub-1',
    status: overrides.status ?? OrderStatus.available,
    assignedManifestId:
      overrides.assignedManifestId === undefined ? null : overrides.assignedManifestId,
    createdAt: now(),
    updatedAt: now(),
  };
}

export function makeOrderWithHub(overrides: Parameters<typeof makeOrder>[0] = {}) {
  return {
    ...makeOrder(overrides),
    hub: {
      name: 'Makati Hub',
      zone: { name: 'NCR' },
    },
  };
}

export function makeManifest(
  overrides: Partial<{
    id: string;
    manifestId: string;
    riderId: string;
    date: Date;
    status: ManifestStatus;
    totalStops: number;
    completedStops: number;
    failedStops: number;
  }> = {}
) {
  return {
    id: overrides.id ?? 'manifest-1',
    manifestId: overrides.manifestId ?? 'DDR-20260603-abcd',
    riderId: overrides.riderId ?? 'rider-1',
    date: overrides.date ?? now(),
    status: overrides.status ?? ManifestStatus.in_progress,
    totalStops: overrides.totalStops ?? 0,
    completedStops: overrides.completedStops ?? 0,
    failedStops: overrides.failedStops ?? 0,
    createdAt: now(),
    updatedAt: now(),
  };
}

export function makeStop(
  overrides: Partial<{
    id: string;
    stopId: string;
    manifestId: string;
    orderId: string;
    sequence: number;
    status: StopStatus;
    distance: number;
    eta: string;
    attemptCount: number;
    maxAttempts: number;
  }> = {}
) {
  return {
    id: overrides.id ?? 'stop-1',
    stopId: overrides.stopId ?? 'stop-aaaa1111',
    manifestId: overrides.manifestId ?? 'manifest-1',
    orderId: overrides.orderId ?? 'order-1',
    sequence: overrides.sequence ?? 1,
    status: overrides.status ?? StopStatus.pending,
    distance: overrides.distance ?? 0,
    eta: overrides.eta ?? '',
    attemptCount: overrides.attemptCount ?? 0,
    maxAttempts: overrides.maxAttempts ?? 3,
    createdAt: now(),
    updatedAt: now(),
  };
}

export function makeDeliveryResult(
  overrides: Partial<{
    id: string;
    stopId: string;
    outcome: DeliveryOutcome;
    timestamp: Date;
    codCollected: Prisma.Decimal | number | null;
    nextAction: DeliveryNextAction | null;
  }> = {}
) {
  return {
    id: overrides.id ?? 'dr-1',
    stopId: overrides.stopId ?? 'stop-1',
    outcome: overrides.outcome ?? DeliveryOutcome.delivered,
    timestamp: overrides.timestamp ?? now(),
    signatureUri: null,
    photoUri: null,
    codCollected:
      overrides.codCollected === null || overrides.codCollected === undefined
        ? null
        : new Prisma.Decimal(overrides.codCollected),
    failureReason: null,
    failureNotes: null,
    nextAction: overrides.nextAction ?? null,
    overrideReason: null,
    createdAt: now(),
    updatedAt: now(),
  };
}
