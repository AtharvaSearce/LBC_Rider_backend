import { ManifestStatus, StopStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { DeliveryDateFilter, RiderContext } from './types';

const ACTIVE_STATUSES: StopStatus[] = [
  StopStatus.pending,
  StopStatus.in_progress,
];

const FAILED_STATUSES = new Set<StopStatus>([
  StopStatus.failed,
  StopStatus.rts,
  StopStatus.reschedule,
]);

function utcDayStart(date: Date): Date {
  return new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  );
}

/** Date range for manifest history filters (UTC day boundaries). */
export function dateRangeForFilter(filter: DeliveryDateFilter): {
  gte: Date;
  lt: Date;
} {
  const todayUTC = utcDayStart(new Date());
  const dayMs = 86_400_000;

  switch (filter) {
    case 'yesterday': {
      const yesterday = new Date(todayUTC.getTime() - dayMs);
      return { gte: yesterday, lt: todayUTC };
    }
    case 'this_week': {
      const day = todayUTC.getUTCDay();
      const mondayOffset = day === 0 ? 6 : day - 1;
      const weekStart = new Date(todayUTC.getTime() - mondayOffset * dayMs);
      return { gte: weekStart, lt: new Date(todayUTC.getTime() + dayMs) };
    }
    case 'today':
    default:
      return { gte: todayUTC, lt: new Date(todayUTC.getTime() + dayMs) };
  }
}

/**
 * Today's manifest the rider is actively working — pending or in_progress only.
 * Matches GET /api/manifest so AI context aligns with the Sequence screen.
 */
export async function getActiveManifest(riderId: string) {
  const { gte, lt } = dateRangeForFilter('today');

  return prisma.manifest.findFirst({
    where: {
      riderId,
      date: { gte, lt },
      status: { in: [ManifestStatus.pending, ManifestStatus.in_progress] },
    },
    orderBy: { createdAt: 'desc' },
  });
}

/** @deprecated Use getActiveManifest for current-route tools. */
export async function getLatestManifest(riderId: string) {
  return getActiveManifest(riderId);
}

export async function getManifestsForDateFilter(
  riderId: string,
  filter: DeliveryDateFilter
) {
  const { gte, lt } = dateRangeForFilter(filter);

  return prisma.manifest.findMany({
    where: {
      riderId,
      date: { gte, lt },
    },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    include: {
      stops: {
        orderBy: { sequence: 'asc' },
        include: {
          order: {
            select: {
              recipientName: true,
              addressText: true,
              trackingNumber: true,
              codAmount: true,
            },
          },
        },
      },
    },
  });
}

export async function buildRiderContext(riderId: string): Promise<RiderContext> {
  const rider = await prisma.rider.findUnique({
    where: { id: riderId },
    select: {
      id: true,
      name: true,
      hub: { select: { name: true } },
    },
  });

  if (!rider) {
    throw new Error('Rider not found');
  }

  const manifest = await getActiveManifest(riderId);

  const stops = manifest
    ? await prisma.stop.findMany({
        where: { manifestId: manifest.id },
        orderBy: { sequence: 'asc' },
        include: {
          order: {
            select: {
              recipientName: true,
              addressText: true,
              trackingNumber: true,
              codAmount: true,
              specialInstructions: true,
            },
          },
        },
      })
    : [];

  const remaining = stops.filter((s) => ACTIVE_STATUSES.includes(s.status))
    .length;
  const completed = stops.filter((s) => s.status === StopStatus.completed)
    .length;
  const failed = stops.filter((s) => FAILED_STATUSES.has(s.status)).length;

  const activeStops = stops
    .filter((s) => ACTIVE_STATUSES.includes(s.status))
    .map((s) => ({
      stopId: s.stopId,
      sequence: s.sequence,
      status: s.status,
      recipientName: s.order.recipientName,
      addressText: s.order.addressText,
      trackingNumber: s.order.trackingNumber,
      codAmount: Number(s.order.codAmount),
      eta: s.eta,
      specialInstructions: s.order.specialInstructions,
    }));

  const next = stops
    .filter((s) => ACTIVE_STATUSES.includes(s.status))
    .sort((a, b) => a.sequence - b.sequence)[0];

  return {
    rider: {
      id: rider.id,
      name: rider.name,
      hubName: rider.hub.name,
    },
    manifest: manifest
      ? {
          manifestId: manifest.manifestId,
          status: manifest.status,
          totalStops: stops.length,
          completed,
          failed,
          remaining,
        }
      : null,
    activeStops,
    nextStop: next
      ? {
          stopId: next.stopId,
          recipientName: next.order.recipientName,
          eta: next.eta,
          distance: next.distance,
        }
      : null,
  };
}
