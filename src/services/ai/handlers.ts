import { StopStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { optimizeManifestRoute } from '../route-optimization';
import { getActiveManifest, getManifestsForDateFilter } from './context';
import {
  AppTab,
  ClientAction,
  DeliveryDateFilter,
  DeliveryStatusFilter,
  RouteStatsMetric,
  StopListFilter,
  ToolExecutionResult,
  ToolHandler,
} from './types';

const ACTIVE_STATUSES: StopStatus[] = [
  StopStatus.pending,
  StopStatus.in_progress,
];

const FAILED_STATUSES = new Set<StopStatus>([
  StopStatus.failed,
  StopStatus.rts,
  StopStatus.reschedule,
]);

function strArg(args: Record<string, unknown>, key: string): string | undefined {
  return typeof args[key] === 'string' ? (args[key] as string) : undefined;
}

function numArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  if (typeof v === 'number' && Number.isFinite(v)) return Math.min(v, 25);
  return fallback;
}

function statusFilterToPrisma(filter: StopListFilter | undefined): StopStatus[] | null {
  switch (filter) {
    case 'pending':
      return [StopStatus.pending];
    case 'in_progress':
      return [StopStatus.in_progress];
    case 'completed':
      return [StopStatus.completed];
    case 'failed':
      return [StopStatus.failed, StopStatus.rts, StopStatus.reschedule];
    case 'active':
      return ACTIVE_STATUSES;
    case 'all':
    default:
      return null;
  }
}

async function resolvePriorityStopId(
  manifestDbId: string,
  args: Record<string, unknown>
): Promise<string | undefined> {
  const direct = strArg(args, 'priorityStopId');
  if (direct) return direct;

  const name = strArg(args, 'priorityRecipientName');
  if (!name) return undefined;

  const stop = await prisma.stop.findFirst({
    where: {
      manifestId: manifestDbId,
      status: { in: ACTIVE_STATUSES },
      order: {
        recipientName: { contains: name, mode: 'insensitive' },
      },
    },
  });
  return stop?.stopId;
}

export const handleOptimizeRoute: ToolHandler = async (riderId, args, ctx) => {
  const manifest = await getActiveManifest(riderId);
  if (!manifest) {
    return { data: { error: 'No manifest found' } };
  }

  const priorityStopId = await resolvePriorityStopId(manifest.id, args);
  const result = await optimizeManifestRoute(manifest.id, {
    priorityStopId,
    origin: ctx.origin,
  });

  const clientAction: ClientAction = { type: 'REFRESH_MANIFEST' };

  return {
    data: result,
    clientAction,
  };
};

export const handleQueryRouteStats: ToolHandler = async (riderId, args) => {
  const metric = (strArg(args, 'metric') ?? 'summary') as RouteStatsMetric;
  const manifest = await getActiveManifest(riderId);
  if (!manifest) {
    return { data: { error: 'No manifest found' } };
  }

  const stops = await prisma.stop.findMany({
    where: { manifestId: manifest.id },
    include: {
      order: { select: { recipientName: true, trackingNumber: true } },
      deliveryResult: { select: { codCollected: true } },
    },
    orderBy: { sequence: 'asc' },
  });

  const remaining = stops.filter((s) => ACTIVE_STATUSES.includes(s.status))
    .length;
  const completed = stops.filter((s) => s.status === StopStatus.completed)
    .length;
  const failed = stops.filter((s) => FAILED_STATUSES.has(s.status)).length;
  const codTotal = stops
    .filter(
      (s) => s.status === StopStatus.completed && s.deliveryResult?.codCollected
    )
    .reduce(
      (sum, s) => sum + Number(s.deliveryResult?.codCollected ?? 0),
      0
    );
  const nextStop = stops
    .filter((s) => ACTIVE_STATUSES.includes(s.status))
    .sort((a, b) => a.sequence - b.sequence)[0];

  const stats: Record<string, unknown> = {
    remaining,
    completed,
    failed,
    cod_total: codTotal,
    eta_next: nextStop
      ? {
          stopId: nextStop.stopId,
          recipient: nextStop.order.recipientName,
          trackingNumber: nextStop.order.trackingNumber,
          eta: nextStop.eta,
          distance: nextStop.distance,
        }
      : null,
    next_stop: nextStop
      ? {
          stopId: nextStop.stopId,
          sequence: nextStop.sequence,
          recipient: nextStop.order.recipientName,
          trackingNumber: nextStop.order.trackingNumber,
          eta: nextStop.eta,
          distance: nextStop.distance,
          status: nextStop.status,
        }
      : null,
    manifest_status: {
      manifestId: manifest.manifestId,
      status: manifest.status,
      total: stops.length,
      remaining,
      completed,
      failed,
    },
    summary: { total: stops.length, remaining, completed, failed, codTotal },
  };

  return { data: { metric, data: stats[metric] ?? stats.summary } };
};

export const handleFindStop: ToolHandler = async (riderId, args) => {
  const query = strArg(args, 'query');
  if (!query) {
    return { data: { error: 'Search query is required' } };
  }

  const manifest = await getActiveManifest(riderId);
  if (!manifest) {
    return { data: { error: 'No manifest found' } };
  }

  const statusFilter = strArg(args, 'statusFilter') as StopListFilter | undefined;
  const statuses = statusFilterToPrisma(statusFilter ?? 'active');

  const stops = await prisma.stop.findMany({
    where: {
      manifestId: manifest.id,
      ...(statuses && { status: { in: statuses } }),
      OR: [
        { stopId: { contains: query, mode: 'insensitive' } },
        {
          order: {
            OR: [
              { recipientName: { contains: query, mode: 'insensitive' } },
              { trackingNumber: { contains: query, mode: 'insensitive' } },
              { addressText: { contains: query, mode: 'insensitive' } },
            ],
          },
        },
      ],
    },
    orderBy: { sequence: 'asc' },
    take: 5,
    include: {
      order: {
        select: {
          recipientName: true,
          trackingNumber: true,
          addressText: true,
          codAmount: true,
          recipientPhone: true,
        },
      },
    },
  });

  return {
    data: {
      query,
      count: stops.length,
      stops: stops.map((s) => ({
        stopId: s.stopId,
        sequence: s.sequence,
        status: s.status,
        recipientName: s.order.recipientName,
        trackingNumber: s.order.trackingNumber,
        addressText: s.order.addressText,
        codAmount: Number(s.order.codAmount),
        eta: s.eta,
      })),
    },
  };
};

export const handleListStops: ToolHandler = async (riderId, args) => {
  const manifest = await getActiveManifest(riderId);
  if (!manifest) {
    return { data: { error: 'No manifest found' } };
  }

  const statusFilter = strArg(args, 'statusFilter') as StopListFilter | undefined;
  const limit = numArg(args, 'limit', 10);
  const statuses = statusFilterToPrisma(statusFilter ?? 'active');

  const stops = await prisma.stop.findMany({
    where: {
      manifestId: manifest.id,
      ...(statuses && { status: { in: statuses } }),
    },
    orderBy: { sequence: 'asc' },
    take: limit,
    include: {
      order: {
        select: {
          recipientName: true,
          trackingNumber: true,
          addressText: true,
        },
      },
    },
  });

  return {
    data: {
      count: stops.length,
      stops: stops.map((s) => ({
        stopId: s.stopId,
        sequence: s.sequence,
        status: s.status,
        recipientName: s.order.recipientName,
        trackingNumber: s.order.trackingNumber,
        addressText: s.order.addressText,
        eta: s.eta,
      })),
    },
  };
};

function buildNavigateAction(
  tab: AppTab,
  filters?: {
    date?: DeliveryDateFilter;
    status?: DeliveryStatusFilter;
    search?: string;
    stopStatus?: StopListFilter;
  },
  stopId?: string,
  expandManifestId?: string
): ClientAction {
  if (stopId && tab === 'sequence') {
    return { type: 'OPEN_ROUTE', stopId };
  }
  return {
    type: 'NAVIGATE',
    tab,
    requiresConfirmation: true,
    confirmLabel: tab === 'profile' ? 'View in Profile' : 'Open in app',
    ...(filters && Object.keys(filters).length > 0 ? { filters } : {}),
    ...(expandManifestId ? { expandManifestId } : {}),
  };
}

export const handleQueryManifestHistory: ToolHandler = async (riderId, args) => {
  const dateFilter = (strArg(args, 'date') ?? 'yesterday') as DeliveryDateFilter;
  const manifests = await getManifestsForDateFilter(riderId, dateFilter);

  if (manifests.length === 0) {
    return {
      data: {
        date: dateFilter,
        count: 0,
        manifests: [],
        message: `No manifests found for ${dateFilter.replace('_', ' ')}.`,
      },
    };
  }

  const formatted = manifests.map((m) => {
    const pending = m.stops.filter((s) => s.status === StopStatus.pending).length;
    const inProgress = m.stops.filter((s) => s.status === StopStatus.in_progress)
      .length;
    const completed = m.stops.filter((s) => s.status === StopStatus.completed)
      .length;
    const failed = m.stops.filter((s) => FAILED_STATUSES.has(s.status)).length;

    return {
      id: m.id,
      manifestId: m.manifestId,
      date: m.date.toISOString().slice(0, 10),
      status: m.status,
      totalStops: m.stops.length,
      pending,
      inProgress,
      completed,
      failed,
      stops: m.stops.slice(0, 15).map((s) => ({
        stopId: s.stopId,
        sequence: s.sequence,
        status: s.status,
        recipientName: s.order.recipientName,
        addressText: s.order.addressText,
        trackingNumber: s.order.trackingNumber,
        codAmount: Number(s.order.codAmount),
      })),
    };
  });

  const primary = formatted[0];
  const clientAction = buildNavigateAction(
    'profile',
    undefined,
    undefined,
    primary.id
  );

  return {
    data: {
      date: dateFilter,
      count: formatted.length,
      manifests: formatted,
    },
    clientAction,
  };
};

export const handleNavigateApp: ToolHandler = async (_riderId, args) => {
  const tab = (strArg(args, 'tab') ?? 'home') as AppTab;
  const filters = {
    date: strArg(args, 'date') as DeliveryDateFilter | undefined,
    status: strArg(args, 'status') as DeliveryStatusFilter | undefined,
    search: strArg(args, 'search'),
    stopStatus: strArg(args, 'stopStatus') as StopListFilter | undefined,
  };

  const cleanedFilters = Object.fromEntries(
    Object.entries(filters).filter(([, v]) => v !== undefined)
  );

  const stopId = strArg(args, 'stopId');
  const expandManifestId = strArg(args, 'expandManifestId');
  const clientAction = buildNavigateAction(
    tab,
    cleanedFilters as typeof filters,
    stopId,
    expandManifestId
  );

  return {
    data: { navigated: tab, filters: cleanedFilters, stopId: stopId ?? null },
    clientAction,
  };
};

export const handleFilterDeliveries: ToolHandler = async (riderId, args, ctx) => {
  return handleNavigateApp(
    riderId,
    {
      tab: 'deliveries',
      date: args.date ?? 'today',
      status: args.status ?? 'all',
      search: args.search,
    },
    ctx
  );
};

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  optimize_route: handleOptimizeRoute,
  query_route_stats: handleQueryRouteStats,
  query_status: handleQueryRouteStats,
  query_manifest_history: handleQueryManifestHistory,
  find_stop: handleFindStop,
  list_stops: handleListStops,
  navigate_app: handleNavigateApp,
  filter_deliveries: handleFilterDeliveries,
};

export async function executeTool(
  name: string,
  riderId: string,
  args: Record<string, unknown>,
  ctx: { origin?: { lat: number; lng: number } }
): Promise<ToolExecutionResult> {
  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    return { data: { error: `Unknown function: ${name}` } };
  }
  return handler(riderId, args, ctx);
}
