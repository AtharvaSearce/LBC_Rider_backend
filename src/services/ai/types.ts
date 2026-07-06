export type AppTab = 'home' | 'sequence' | 'deliveries' | 'profile' | 'notifications';

export type DeliveryDateFilter = 'today' | 'yesterday' | 'this_week';

export type DeliveryStatusFilter =
  | 'all'
  | 'delivered'
  | 'failed'
  | 'rts'
  | 'returned'
  | 'rescheduled';

export type RouteStatsMetric =
  | 'remaining'
  | 'completed'
  | 'failed'
  | 'cod_total'
  | 'eta_next'
  | 'summary'
  | 'next_stop'
  | 'manifest_status';

export type StopListFilter =
  | 'all'
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'active';

export type ClientActionType =
  | 'NAVIGATE'
  | 'REFRESH_MANIFEST'
  | 'OPEN_STOP'
  | 'OPEN_ROUTE';

export interface NavigateAction {
  type: 'NAVIGATE';
  tab: AppTab;
  filters?: {
    date?: DeliveryDateFilter;
    status?: DeliveryStatusFilter;
    search?: string;
    stopStatus?: StopListFilter;
  };
  expandManifestId?: string;
  requiresConfirmation?: boolean;
  confirmLabel?: string;
}

export interface RefreshManifestAction {
  type: 'REFRESH_MANIFEST';
}

export interface OpenStopAction {
  type: 'OPEN_STOP';
  stopId: string;
}

export interface OpenRouteAction {
  type: 'OPEN_ROUTE';
  stopId: string;
}

export type ClientAction =
  | NavigateAction
  | RefreshManifestAction
  | OpenStopAction
  | OpenRouteAction;

export interface AIChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AICommandRequest {
  text: string;
  origin?: { lat: number; lng: number };
  /** Prior turns in this chat session (excludes the current message in `text`). */
  history?: AIChatTurn[];
}

export interface AICommandResponse {
  intent: string;
  message: string;
  action: ClientAction | null;
  data: unknown;
}

export interface RiderContext {
  rider: {
    id: string;
    name: string;
    hubName: string;
  };
  manifest: {
    manifestId: string;
    status: string;
    totalStops: number;
    completed: number;
    failed: number;
    remaining: number;
  } | null;
  activeStops: Array<{
    stopId: string;
    sequence: number;
    status: string;
    recipientName: string;
    addressText: string;
    trackingNumber: string;
    codAmount: number;
    eta: string;
    specialInstructions: string;
  }>;
  nextStop: {
    stopId: string;
    recipientName: string;
    eta: string;
    distance: number;
  } | null;
}

export interface ToolExecutionResult {
  data: unknown;
  clientAction?: ClientAction;
}

export type ToolHandler = (
  riderId: string,
  args: Record<string, unknown>,
  ctx: { origin?: { lat: number; lng: number } }
) => Promise<ToolExecutionResult>;
