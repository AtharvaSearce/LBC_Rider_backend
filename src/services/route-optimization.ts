import { Prisma, StopStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { GeoPoint, optimizeStopOrder } from '../utils/geo';

export const TERMINAL_STOP_STATUSES: StopStatus[] = [
  StopStatus.completed,
  StopStatus.rts,
  StopStatus.reschedule,
];

const stopWithOrderInclude = {
  order: {
    select: {
      addressLat: true,
      addressLng: true,
    },
  },
} as const;

export type StopWithGeo = Prisma.StopGetPayload<{
  include: typeof stopWithOrderInclude;
}>;

const SEQUENCE_PARK_OFFSET = 100000;

export function isTerminalStopStatus(status: StopStatus): boolean {
  return TERMINAL_STOP_STATUSES.includes(status);
}

export function parseGeoPoint(input: unknown): GeoPoint | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  const lat = obj.lat ?? obj.latitude;
  const lng = obj.lng ?? obj.longitude;
  if (typeof lat === 'number' && typeof lng === 'number') {
    return { latitude: lat, longitude: lng };
  }
  return null;
}

/**
 * Renumber every stop in a manifest into a single contiguous 1..N sequence.
 * Runs inside the caller's transaction.
 */
export async function resequenceManifest(
  tx: Prisma.TransactionClient,
  manifestDbId: string,
  orderedActiveStopIds: string[]
): Promise<string[]> {
  const allStops = await tx.stop.findMany({
    where: { manifestId: manifestDbId },
    orderBy: { sequence: 'asc' },
    select: { id: true, stopId: true, status: true },
  });

  const byStopId = new Map(allStops.map((s) => [s.stopId, s]));
  const activeSet = new Set(orderedActiveStopIds);

  const terminalStops = allStops.filter((s) => isTerminalStopStatus(s.status));

  const orderedActive = orderedActiveStopIds
    .map((sid) => byStopId.get(sid))
    .filter(
      (s): s is (typeof allStops)[number] =>
        !!s && !isTerminalStopStatus(s.status)
    );

  const leftover = allStops.filter(
    (s) => !isTerminalStopStatus(s.status) && !activeSet.has(s.stopId)
  );

  const finalOrder = [...terminalStops, ...orderedActive, ...leftover];

  for (let i = 0; i < finalOrder.length; i++) {
    await tx.stop.update({
      where: { id: finalOrder[i].id },
      data: { sequence: SEQUENCE_PARK_OFFSET + i },
    });
  }

  const firstActiveId = orderedActive[0]?.id;
  for (let i = 0; i < finalOrder.length; i++) {
    const stop = finalOrder[i];
    const data: Prisma.StopUpdateInput = { sequence: i + 1 };
    if (!isTerminalStopStatus(stop.status) && activeSet.has(stop.stopId)) {
      data.status =
        stop.id === firstActiveId
          ? StopStatus.in_progress
          : StopStatus.pending;
    }
    await tx.stop.update({ where: { id: stop.id }, data });
  }

  return orderedActive.map((s) => s.stopId);
}

export interface OptimizeManifestOptions {
  priorityStopId?: string;
  origin?: unknown;
}

export interface OptimizeManifestResult {
  newOrder: string[];
  firstStopId?: string;
  message: string;
}

function stopPoint(stop: StopWithGeo): GeoPoint {
  return {
    latitude: stop.order.addressLat,
    longitude: stop.order.addressLng,
  };
}

/**
 * Geo-optimise pending stops for a manifest and persist the new sequence.
 */
export async function optimizeManifestRoute(
  manifestDbId: string,
  options: OptimizeManifestOptions = {}
): Promise<OptimizeManifestResult> {
  const { priorityStopId, origin } = options;

  const primaryStops = await prisma.stop.findMany({
    where: {
      manifestId: manifestDbId,
      status: { in: [StopStatus.pending, StopStatus.in_progress] },
    },
    orderBy: { sequence: 'asc' },
    include: stopWithOrderInclude,
  });

  const failedStopsRaw = await prisma.stop.findMany({
    where: {
      manifestId: manifestDbId,
      status: StopStatus.failed,
    },
    orderBy: { sequence: 'asc' },
    include: stopWithOrderInclude,
  });

  const failedStops = failedStopsRaw.filter(
    (stop) => stop.attemptCount < stop.maxAttempts
  );

  const pendingStops: StopWithGeo[] = [...primaryStops, ...failedStops];

  if (pendingStops.length === 0) {
    return {
      newOrder: [],
      message: 'No pending stops to optimize',
    };
  }

  const inProgressStop = pendingStops.find(
    (s) => s.status === StopStatus.in_progress
  );
  const originPoint = parseGeoPoint(origin);
  const startPoint: GeoPoint =
    originPoint ??
    (inProgressStop
      ? stopPoint(inProgressStop)
      : stopPoint(pendingStops[0]));

  let ordered: StopWithGeo[];
  const priorityStop = priorityStopId
    ? pendingStops.find((s) => s.stopId === priorityStopId)
    : undefined;

  if (priorityStop) {
    const rest = pendingStops.filter((s) => s.stopId !== priorityStop.stopId);
    const restOrder = optimizeStopOrder(
      stopPoint(priorityStop),
      rest.map(stopPoint)
    );
    ordered = [priorityStop, ...restOrder.map((idx) => rest[idx])];
  } else {
    const order = optimizeStopOrder(startPoint, pendingStops.map(stopPoint));
    ordered = order.map((idx) => pendingStops[idx]);
  }

  await prisma.$transaction(
    async (tx) => {
      await resequenceManifest(
        tx,
        manifestDbId,
        ordered.map((s) => s.stopId)
      );
    },
    { timeout: 15000 }
  );

  const newOrder = ordered.map((s) => s.stopId);

  return {
    newOrder,
    firstStopId: newOrder[0],
    message: priorityStopId
      ? `Route optimized with ${priorityStopId} prioritized first`
      : 'Route optimized for shortest path',
  };
}
