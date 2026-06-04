import request from 'supertest';
import { buildApp } from '../../helpers/app';
import geocodeRouter from '../../../src/routes/geocode';

// geocode is on the rider-auth middleware's public path list, so we mount the
// router directly without auth. Live Google Maps calls are never made — every
// test stubs `global.fetch` with `jest.fn()`.
const app = buildApp({
  mountPath: '/api/geocode',
  router: geocodeRouter,
});

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_KEY = process.env.GOOGLE_MAPS_API_KEY;

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  process.env.GOOGLE_MAPS_API_KEY = ORIGINAL_KEY;
});

// ─── POST /address ────────────────────────────────────────────────────────

describe('POST /api/geocode/address', () => {
  it('500 when GOOGLE_MAPS_API_KEY is unset', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;

    const res = await request(app)
      .post('/api/geocode/address')
      .send({ address: 'Ayala Ave, Makati' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Google Maps API key not configured' });
  });

  it('400 when address is missing', async () => {
    const res = await request(app).post('/api/geocode/address').send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Address is required' });
  });

  it('400 when address is not a string', async () => {
    const res = await request(app)
      .post('/api/geocode/address')
      .send({ address: 12345 });

    expect(res.status).toBe(400);
  });

  it('200 returns the first geocoding result and pins the request to PH region', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      json: async () => ({
        status: 'OK',
        results: [
          {
            formatted_address: '123 Ayala Ave, Makati, Philippines',
            place_id: 'ChIJ_test',
            geometry: { location: { lat: 14.5547, lng: 121.0244 } },
          },
        ],
      }),
    });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const res = await request(app)
      .post('/api/geocode/address')
      .send({ address: '123 Ayala Ave, Makati' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      lat: 14.5547,
      lng: 121.0244,
      formattedAddress: '123 Ayala Ave, Makati, Philippines',
      placeId: 'ChIJ_test',
    });

    // The request URL should be the geocode endpoint, region-pinned to PH,
    // with the address URL-encoded.
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('https://maps.googleapis.com/maps/api/geocode/json');
    expect(calledUrl).toContain('region=ph');
    expect(calledUrl).toContain(encodeURIComponent('123 Ayala Ave, Makati'));
  });

  it('404 when Google returns ZERO_RESULTS or no matches', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({ status: 'ZERO_RESULTS', results: [] }),
    }) as unknown as typeof global.fetch;

    const res = await request(app)
      .post('/api/geocode/address')
      .send({ address: 'asdf' });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'Address not found', status: 'ZERO_RESULTS' });
  });
});

// ─── POST /reverse ────────────────────────────────────────────────────────

describe('POST /api/geocode/reverse', () => {
  it('500 when GOOGLE_MAPS_API_KEY is unset', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;

    const res = await request(app)
      .post('/api/geocode/reverse')
      .send({ lat: 14.5, lng: 121 });

    expect(res.status).toBe(500);
  });

  it('400 when lat or lng is missing', async () => {
    const res = await request(app).post('/api/geocode/reverse').send({ lat: 14.5 });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Latitude and longitude are required' });
  });

  it('400 when lng is null', async () => {
    const res = await request(app)
      .post('/api/geocode/reverse')
      .send({ lat: 14.5, lng: null });

    expect(res.status).toBe(400);
  });

  it('200 returns formatted address + place id from the first reverse-geocode hit', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      json: async () => ({
        status: 'OK',
        results: [
          {
            formatted_address: 'Makati, Metro Manila',
            place_id: 'ChIJ_reverse',
            address_components: [{ types: ['locality'] }],
            geometry: { location: { lat: 14.5547, lng: 121.0244 } },
          },
        ],
      }),
    });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const res = await request(app)
      .post('/api/geocode/reverse')
      .send({ lat: 14.5547, lng: 121.0244 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      address: 'Makati, Metro Manila',
      placeId: 'ChIJ_reverse',
      components: [{ types: ['locality'] }],
    });
    expect(fetchMock.mock.calls[0][0]).toContain('latlng=14.5547,121.0244');
  });

  it('404 when no reverse-geocode result matches the coordinates', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({ status: 'ZERO_RESULTS', results: [] }),
    }) as unknown as typeof global.fetch;

    const res = await request(app)
      .post('/api/geocode/reverse')
      .send({ lat: 0, lng: 0 });

    expect(res.status).toBe(404);
  });
});

// ─── GET /places-autocomplete ─────────────────────────────────────────────

describe('GET /api/geocode/places-autocomplete', () => {
  it('500 when GOOGLE_MAPS_API_KEY is unset', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;

    const res = await request(app).get('/api/geocode/places-autocomplete?query=ayala');

    expect(res.status).toBe(500);
  });

  it('400 when ?query is missing', async () => {
    const res = await request(app).get('/api/geocode/places-autocomplete');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Search query is required' });
  });

  it('200 maps Places predictions into a flattened suggestions array, scoped to PH', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      json: async () => ({
        status: 'OK',
        predictions: [
          {
            place_id: 'p1',
            description: 'Ayala Avenue, Makati, Philippines',
            structured_formatting: {
              main_text: 'Ayala Avenue',
              secondary_text: 'Makati, Philippines',
            },
          },
          {
            place_id: 'p2',
            description: 'Ayala Center, Cebu City',
            structured_formatting: {},
          },
        ],
      }),
    });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const res = await request(app).get(
      '/api/geocode/places-autocomplete?query=ayala'
    );

    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual([
      {
        placeId: 'p1',
        description: 'Ayala Avenue, Makati, Philippines',
        mainText: 'Ayala Avenue',
        secondaryText: 'Makati, Philippines',
      },
      {
        placeId: 'p2',
        description: 'Ayala Center, Cebu City',
        mainText: '',
        secondaryText: '',
      },
    ]);

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('components=country:ph');
    expect(calledUrl).toContain('types=address');
    expect(calledUrl).toContain('input=ayala');
  });

  it('200 returns empty suggestions when Google replies with a non-OK status', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({ status: 'ZERO_RESULTS', predictions: [] }),
    }) as unknown as typeof global.fetch;

    const res = await request(app).get(
      '/api/geocode/places-autocomplete?query=zzzz'
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ suggestions: [] });
  });
});
