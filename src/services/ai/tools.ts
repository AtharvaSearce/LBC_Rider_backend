import { SchemaType, FunctionDeclaration } from '@google/generative-ai';

function enumProp(description: string, values: string[]) {
  return {
    type: SchemaType.STRING,
    format: 'enum' as const,
    description,
    enum: values,
  };
}

/**
 * Gemini function declarations for the rider AI assistant.
 * Each tool maps to a server handler and optionally emits a client-side action
 * for the Flutter app.
 */
export const AI_TOOL_DECLARATIONS = [
  {
    name: 'optimize_route',
    description:
      'Reorder pending delivery stops for the shortest driving path. Use when the rider asks to optimize, reorder, or prioritize a stop. Requires an active manifest with pending stops. Cannot complete deliveries or change stop statuses beyond sequence.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        priorityStopId: {
          type: SchemaType.STRING,
          description:
            'Exact stop ID to deliver first (e.g. "stop-a1b2c3d4"). Prefer this when the ID is known from context.',
        },
        priorityRecipientName: {
          type: SchemaType.STRING,
          description:
            'Recipient name to prioritize when stop ID is unknown. Partial, case-insensitive match.',
        },
      },
    },
  },
  {
    name: 'query_route_stats',
    description:
      'Return live statistics about the rider\'s current manifest: remaining/completed/failed counts, COD collected, next stop ETA, or a full summary. Use for status questions; do not guess numbers.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        metric: enumProp(
          'Statistic to return. Use "summary" for an overview, "next_stop" for the upcoming delivery, "cod_total" for cash-on-delivery collected today.',
          [
            'remaining',
            'completed',
            'failed',
            'cod_total',
            'eta_next',
            'next_stop',
            'summary',
            'manifest_status',
          ]
        ),
      },
      required: ['metric'],
    },
  },
  {
    name: 'find_stop',
    description:
      'Search stops on the current manifest by recipient name, tracking number, or address fragment. Use when the rider asks "where is…", "find Maria", or needs stop details.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description:
            'Search text: recipient name, tracking number, or address substring.',
        },
        statusFilter: enumProp(
          'Limit results to stops in this status group. Default "active" (pending + in_progress).',
          ['all', 'active', 'pending', 'in_progress', 'completed', 'failed']
        ),
      },
      required: ['query'],
    },
  },
  {
    name: 'list_stops',
    description:
      'List stops on the rider\'s ACTIVE manifest today (pending/in_progress route only) filtered by status. Use for pending stops, current work, or what is left on today\'s route.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        statusFilter: enumProp(
          'Which stops to list.',
          ['all', 'active', 'pending', 'in_progress', 'completed', 'failed']
        ),
        limit: {
          type: SchemaType.NUMBER,
          description: 'Max stops to return (default 10, max 25).',
        },
      },
    },
  },
  {
    name: 'query_manifest_history',
    description:
      'Look up completed or past manifests by date (today, yesterday, this week). Use when the rider asks about a previous manifest, yesterday\'s route, or historical delivery summary — NOT for today\'s active pending stops.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        date: enumProp(
          'Which day to search for manifests.',
          ['today', 'yesterday', 'this_week']
        ),
      },
    },
  },
  {
    name: 'navigate_app',
    description:
      'Suggest opening an app tab after the rider confirms. Use for Deliveries history filters or Profile with a specific past manifest expanded. Do NOT use for today\'s pending stops — use list_stops instead. Do NOT use for past manifest summaries without query_manifest_history first.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        tab: enumProp(
          'App tab to open. "sequence" = route/stop list, "deliveries" = delivery history, "profile" = past manifests.',
          ['home', 'sequence', 'deliveries', 'profile', 'notifications']
        ),
        date: enumProp(
          'Date filter for the Deliveries tab only.',
          ['today', 'yesterday', 'this_week']
        ),
        status: enumProp(
          'Status filter for the Deliveries tab only.',
          ['all', 'delivered', 'failed', 'rts', 'returned', 'rescheduled']
        ),
        search: {
          type: SchemaType.STRING,
          description:
            'Pre-fill search on Deliveries tab (tracking number or recipient).',
        },
        stopId: {
          type: SchemaType.STRING,
          description:
            'When set with tab "sequence", open the active-route screen for this stop.',
        },
        expandManifestId: {
          type: SchemaType.STRING,
          description:
            'When tab is "profile", expand this manifest in Past Manifests (internal manifest id from query_manifest_history).',
        },
      },
      required: ['tab'],
    },
  },
  // Backward-compatible alias — delegates to navigate_app with tab=deliveries.
  {
    name: 'filter_deliveries',
    description:
      'Legacy alias: navigate to Deliveries tab with date/status filters. Prefer navigate_app for new requests.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        date: enumProp('Date filter.', ['today', 'yesterday', 'this_week']),
        status: enumProp('Status filter.', [
          'all',
          'delivered',
          'failed',
          'rts',
          'returned',
          'rescheduled',
        ]),
        search: {
          type: SchemaType.STRING,
          description: 'Optional search query for tracking or recipient.',
        },
      },
    },
  },
  // Backward-compatible alias for query_route_stats.
  {
    name: 'query_status',
    description:
      'Legacy alias for query_route_stats. Prefer query_route_stats for new requests.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        metric: enumProp('Statistic to return.', [
          'remaining',
          'completed',
          'failed',
          'cod_total',
          'eta_next',
          'summary',
        ]),
      },
      required: ['metric'],
    },
  },
] as FunctionDeclaration[];
