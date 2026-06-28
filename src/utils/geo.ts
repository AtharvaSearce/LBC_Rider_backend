export interface GeoPoint {
  latitude: number;
  longitude: number;
}

const EARTH_RADIUS_M = 6_371_000;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Great-circle distance between two coordinates in meters.
 */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h =
    sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Total length (meters) of a path that starts at [start] and visits each
 * point in [points] in the given [order].
 */
function pathLength(
  start: GeoPoint,
  points: GeoPoint[],
  order: number[]
): number {
  let total = 0;
  let prev = start;
  for (const idx of order) {
    total += haversineMeters(prev, points[idx]);
    prev = points[idx];
  }
  return total;
}

/**
 * Greedy nearest-neighbour ordering of [points] starting from [start].
 * Returns the visiting order as indices into [points].
 */
function nearestNeighborOrder(start: GeoPoint, points: GeoPoint[]): number[] {
  const remaining = points.map((_, i) => i);
  const order: number[] = [];
  let current = start;

  while (remaining.length > 0) {
    let bestPos = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineMeters(current, points[remaining[i]]);
      if (d < bestDist) {
        bestDist = d;
        bestPos = i;
      }
    }
    const [chosen] = remaining.splice(bestPos, 1);
    order.push(chosen);
    current = points[chosen];
  }

  return order;
}

/**
 * 2-opt local search to remove path crossings produced by nearest-neighbour.
 * This is an open-path variant (no return to the depot).
 */
function twoOptImprove(
  start: GeoPoint,
  points: GeoPoint[],
  initial: number[]
): number[] {
  if (initial.length < 4) return initial;

  let order = [...initial];
  let improved = true;

  while (improved) {
    improved = false;
    for (let i = 0; i < order.length - 1; i++) {
      for (let k = i + 1; k < order.length; k++) {
        const candidate = [
          ...order.slice(0, i),
          ...order.slice(i, k + 1).reverse(),
          ...order.slice(k + 1),
        ];
        if (
          pathLength(start, points, candidate) <
          pathLength(start, points, order) - 1e-6
        ) {
          order = candidate;
          improved = true;
        }
      }
    }
  }

  return order;
}

/**
 * Optimise the visiting order of [points] starting from [start] using a
 * nearest-neighbour heuristic refined by 2-opt. Returns visiting order as
 * indices into the original [points] array.
 */
export function optimizeStopOrder(
  start: GeoPoint,
  points: GeoPoint[]
): number[] {
  if (points.length <= 1) return points.map((_, i) => i);
  const greedy = nearestNeighborOrder(start, points);
  return twoOptImprove(start, points, greedy);
}
