/** Human-readable labels for tool execution status in the rider app UI. */
export const TOOL_LABELS: Record<string, { active: string; done: string }> = {
  optimize_route: {
    active: 'Optimizing your route',
    done: 'Route optimized',
  },
  query_route_stats: {
    active: 'Checking your delivery stats',
    done: 'Stats retrieved',
  },
  query_status: {
    active: 'Checking your delivery stats',
    done: 'Stats retrieved',
  },
  find_stop: {
    active: 'Searching your stops',
    done: 'Search complete',
  },
  list_stops: {
    active: 'Loading your stop list',
    done: 'Stops loaded',
  },
  query_manifest_history: {
    active: 'Looking up past manifests',
    done: 'Manifest history loaded',
  },
  navigate_app: {
    active: 'Preparing navigation',
    done: 'Navigation ready',
  },
  filter_deliveries: {
    active: 'Opening delivery history',
    done: 'Delivery history ready',
  },
};

export function toolActiveLabel(toolName: string): string {
  return TOOL_LABELS[toolName]?.active ?? `Running ${toolName.replace(/_/g, ' ')}`;
}

export function toolDoneLabel(toolName: string): string {
  return TOOL_LABELS[toolName]?.done ?? 'Action complete';
}

export function summarizeToolResult(toolName: string, data: unknown): string {
  if (!data || typeof data !== 'object') return toolDoneLabel(toolName);
  const d = data as Record<string, unknown>;

  if (d.error) return String(d.error);

  switch (toolName) {
    case 'optimize_route': {
      const order = d.newOrder as string[] | undefined;
      return order?.length
        ? `Reordered ${order.length} stop${order.length === 1 ? '' : 's'}`
        : String(d.message ?? toolDoneLabel(toolName));
    }
    case 'query_route_stats':
    case 'query_status':
      return 'Live route statistics fetched';
    case 'find_stop': {
      const count = d.count as number | undefined;
      return count === 1
        ? 'Found 1 matching stop'
        : `Found ${count ?? 0} matching stops`;
    }
    case 'list_stops': {
      const count = d.count as number | undefined;
      return `Listed ${count ?? 0} stops`;
    }
    case 'query_manifest_history': {
      const count = d.count as number | undefined;
      return count === 1
        ? 'Found 1 manifest'
        : `Found ${count ?? 0} manifests`;
    }
    case 'navigate_app':
    case 'filter_deliveries':
      return `Ready to open ${String(d.navigated ?? 'screen')}`;
    default:
      return toolDoneLabel(toolName);
  }
}
