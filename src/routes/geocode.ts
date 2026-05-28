import { Router, Request, Response } from 'express';

const router = Router();

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const PLACES_URL = 'https://maps.googleapis.com/maps/api/place/autocomplete/json';

type GoogleGeocodeResponse = {
  status: string;
  results: {
    formatted_address: string;
    place_id: string;
    geometry: { location: { lat: number; lng: number } };
    address_components?: unknown[];
  }[];
};

type GooglePlacesResponse = {
  status: string;
  predictions: {
    place_id: string;
    description: string;
    structured_formatting?: {
      main_text?: string;
      secondary_text?: string;
    };
  }[];
};

function queryString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function getApiKey(res: Response): string | null {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Google Maps API key not configured' });
    return null;
  }
  return apiKey;
}

router.post('/address', async (req: Request, res: Response) => {
  try {
    const { address } = req.body;
    const apiKey = getApiKey(res);
    if (!apiKey) return;

    if (!address || typeof address !== 'string') {
      res.status(400).json({ error: 'Address is required' });
      return;
    }

    const url = `${GEOCODE_URL}?address=${encodeURIComponent(address)}&key=${apiKey}&region=ph`;
    const response = await fetch(url);
    const data = (await response.json()) as GoogleGeocodeResponse;

    if (data.status === 'OK' && data.results.length > 0) {
      const result = data.results[0];
      res.json({
        lat: result.geometry.location.lat,
        lng: result.geometry.location.lng,
        formattedAddress: result.formatted_address,
        placeId: result.place_id,
      });
    } else {
      res.status(404).json({ error: 'Address not found', status: data.status });
    }
  } catch (err) {
    console.error('[Geocode] Address error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/reverse', async (req: Request, res: Response) => {
  try {
    const { lat, lng } = req.body;
    const apiKey = getApiKey(res);
    if (!apiKey) return;

    if (lat === undefined || lat === null || lng === undefined || lng === null) {
      res.status(400).json({ error: 'Latitude and longitude are required' });
      return;
    }

    const url = `${GEOCODE_URL}?latlng=${lat},${lng}&key=${apiKey}`;
    const response = await fetch(url);
    const data = (await response.json()) as GoogleGeocodeResponse;

    if (data.status === 'OK' && data.results.length > 0) {
      const result = data.results[0];
      res.json({
        address: result.formatted_address,
        placeId: result.place_id,
        components: result.address_components,
      });
    } else {
      res.status(404).json({ error: 'Location not found', status: data.status });
    }
  } catch (err) {
    console.error('[Geocode] Reverse error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/places-autocomplete', async (req: Request, res: Response) => {
  try {
    const query = queryString(req.query.query);
    const apiKey = getApiKey(res);
    if (!apiKey) return;

    if (!query) {
      res.status(400).json({ error: 'Search query is required' });
      return;
    }

    const url = `${PLACES_URL}?input=${encodeURIComponent(query)}&key=${apiKey}&components=country:ph&types=address`;
    const response = await fetch(url);
    const data = (await response.json()) as GooglePlacesResponse;

    if (data.status === 'OK') {
      const suggestions = data.predictions.map((p) => ({
        placeId: p.place_id,
        description: p.description,
        mainText: p.structured_formatting?.main_text || '',
        secondaryText: p.structured_formatting?.secondary_text || '',
      }));
      res.json({ suggestions });
    } else {
      res.json({ suggestions: [] });
    }
  } catch (err) {
    console.error('[Geocode] Autocomplete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
