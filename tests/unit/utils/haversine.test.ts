import { haversineDistance } from '../../../src/routes/attendance';

describe('haversineDistance', () => {
  it('returns 0 for the same point', () => {
    expect(haversineDistance(14.5547, 121.0244, 14.5547, 121.0244)).toBe(0);
  });

  it('is symmetric: distance(A,B) === distance(B,A)', () => {
    const ab = haversineDistance(14.5547, 121.0244, 14.676, 121.0437);
    const ba = haversineDistance(14.676, 121.0437, 14.5547, 121.0244);
    expect(ab).toBeCloseTo(ba, 6);
  });

  it('returns the expected ground distance from Makati to Quezon City (≈13.6 km)', () => {
    // Makati (14.5547, 121.0244) -> Quezon City (14.676, 121.0437)
    // Reference: ~13,600 m via great-circle
    const meters = haversineDistance(14.5547, 121.0244, 14.676, 121.0437);
    expect(meters).toBeGreaterThan(13_400);
    expect(meters).toBeLessThan(13_800);
  });

  it('returns ~111 km for one degree of latitude on the same meridian', () => {
    const meters = haversineDistance(0, 0, 1, 0);
    expect(meters).toBeGreaterThan(111_000);
    expect(meters).toBeLessThan(111_400);
  });

  it('returns ~111 km for one degree of longitude at the equator', () => {
    const meters = haversineDistance(0, 0, 0, 1);
    expect(meters).toBeGreaterThan(111_000);
    expect(meters).toBeLessThan(111_400);
  });

  it('returns less than 111 km for one degree of longitude at higher latitude (cosine shrinking)', () => {
    const equator = haversineDistance(0, 0, 0, 1);
    const at60 = haversineDistance(60, 0, 60, 1);
    // At latitude 60° the meridional spacing is ~half the equator value
    expect(at60).toBeLessThan(equator);
    expect(at60).toBeGreaterThan(equator * 0.45);
    expect(at60).toBeLessThan(equator * 0.55);
  });

  it('returns ~157 m for two close points (within a hub geofence)', () => {
    // Two points ~150m apart in Makati
    const meters = haversineDistance(14.5547, 121.0244, 14.5561, 121.0244);
    expect(meters).toBeGreaterThan(140);
    expect(meters).toBeLessThan(170);
  });

  it('returns the antipodal half-circumference (~20,015 km)', () => {
    const meters = haversineDistance(0, 0, 0, 180);
    expect(meters).toBeGreaterThan(20_000_000);
    expect(meters).toBeLessThan(20_040_000);
  });
});
