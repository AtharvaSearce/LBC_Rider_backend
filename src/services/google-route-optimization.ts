import logger from '../utils/logger';
import { GeoPoint, optimizeStopOrder } from '../utils/geo';

const ROUTES_API_URL =
  'https://routes.googleapis.com/directions/v2:computeRoutes';

/**
 * Use Google Routes API with `optimizeWaypointOrder: true` to find the
 * optimal visiting order for a set of stops.
 *
 * Returns an array of indices into the original [stops] array, exactly like
 * the local `optimizeStopOrder()` function so callers don't need to know
 * which strategy was used.
 *
 * Falls back to local optimisation if the Google API call fails.
 */
export async function googleOptimizeStopOrder(
  origin: GeoPoint,
  stops: GeoPoint[]
): Promise<number[]> {
  if (stops.length <= 1) return stops.map((_, i) => i);

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    logger.warn(
      '[GoogleRouteOpt] No GOOGLE_MAPS_API_KEY set, falling back to local'
    );
    return optimizeStopOrder(origin, stops);
  }

  // Google requires an explicit destination. We use the last stop from a
  // quick nearest-neighbour pass to keep the open-path semantics identical
  // to the local algorithm.
  //
  // With only 1 intermediate (2 stops total) there's nothing to optimise
  // beyond origin → A → B, so we short-circuit.
  if (stops.length === 2) {
    // Only one intermediate waypoint — nothing for the API to reorder.
    // Pick the nearest-first order locally (cheap).
    return optimizeStopOrder(origin, stops);
  }

  // Use the last stop from the greedy local order as the destination so
  // that the open-path shape is preserved.
  const greedyOrder = optimizeStopOrder(origin, stops);
  const destinationIdx = greedyOrder[greedyOrder.length - 1];
  const destination = stops[destinationIdx];

  // Everything except the destination goes into `intermediates`.
  const intermediateIndices = greedyOrder.slice(0, -1);
  const intermediates = intermediateIndices.map((idx) => ({
    location: {
      latLng: { latitude: stops[idx].latitude, longitude: stops[idx].longitude },
    },
  }));

  const body = {
    origin: {
      location: {
        latLng: { latitude: origin.latitude, longitude: origin.longitude },
      },
    },
    destination: {
      location: {
        latLng: {
          latitude: destination.latitude,
          longitude: destination.longitude,
        },
      },
    },
    intermediates,
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE',
    optimizeWaypointOrder: true,
    languageCode: 'en-US',
  };

  try {
    logger.info('[GoogleRouteOpt] Calling Routes API', {
      stopCount: stops.length,
      intermediateCount: intermediates.length,
    });

    const response = await fetch(ROUTES_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask':
          'routes.optimizedIntermediateWaypointIndex,routes.duration,routes.distanceMeters',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('[GoogleRouteOpt] API error', {
        status: response.status,
        body: errorText,
      });
      logger.warn('[GoogleRouteOpt] Falling back to local optimisation');
      return optimizeStopOrder(origin, stops);
    }

    const data = (await response.json()) as {
      routes?: {
        optimizedIntermediateWaypointIndex?: number[];
        duration?: string;
        distanceMeters?: number;
      }[];
    };

    const route = data.routes?.[0];
    if (!route?.optimizedIntermediateWaypointIndex) {
      logger.warn(
        '[GoogleRouteOpt] No optimizedIntermediateWaypointIndex in response, falling back'
      );
      return optimizeStopOrder(origin, stops);
    }

    // Map Google's optimised indices (which reference positions in the
    // `intermediates` array we sent) back to the original `stops` array.
    const optimizedOrder: number[] = route.optimizedIntermediateWaypointIndex.map(
      (googleIdx) => intermediateIndices[googleIdx]
    );
    // Append the destination (which was not part of intermediates).
    optimizedOrder.push(destinationIdx);

    logger.info('[GoogleRouteOpt] Optimisation complete', {
      stopCount: stops.length,
      durationSeconds: route.duration
        ? Number.parseInt(route.duration.replace('s', ''), 10)
        : undefined,
      distanceMeters: route.distanceMeters,
    });

    return optimizedOrder;
  } catch (err) {
    logger.error('[GoogleRouteOpt] Unexpected error', { err });
    logger.warn('[GoogleRouteOpt] Falling back to local optimisation');
    return optimizeStopOrder(origin, stops);
  }
}
