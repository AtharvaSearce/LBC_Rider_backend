import '../../../src/types/express';
import request from 'supertest';
import { OrderStatus } from '@prisma/client';
import { prismaMock } from '../../helpers/prismaMock';
import { buildApp } from '../../helpers/app';
import { adminAuthHeader } from '../../helpers/auth';
import { adminMiddleware } from '../../../src/middleware/admin-auth';
import adminOrderRouter from '../../../src/routes/admin-order';
import { makeHub, makeOrder, makeOrderWithHub } from '../../helpers/fixtures';

const app = buildApp({
  mountPath: '/api/admin/orders',
  router: adminOrderRouter,
  preMiddleware: [adminMiddleware],
});

const validOrderBody = {
  trackingNumber: 'TRK-9999',
  recipient: { name: 'Maria', phone: '+639170000010', field: 'Apt 4B' },
  address: { text: '123 Ayala Ave', lat: 14.55, lng: 121.02, geocoded: true },
  serviceType: 'Express',
  codAmount: 250,
  packageDetails: 'Documents',
  specialInstructions: 'Leave at door',
  hub: 'Makati Hub',
  zone: 'NCR',
};

// ─── GET /api/admin/orders ────────────────────────────────────────────────

describe('GET /api/admin/orders', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).get('/api/admin/orders');
    expect(res.status).toBe(401);
  });

  it('200 lists orders with no filters', async () => {
    (prismaMock.order.findMany as jest.Mock).mockResolvedValue([
      makeOrderWithHub({ id: 'o1' }),
      makeOrderWithHub({ id: 'o2' }),
    ]);

    const res = await request(app)
      .get('/api/admin/orders')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);

    const args = (prismaMock.order.findMany as jest.Mock).mock.calls[0][0];
    expect(args.where).toEqual({});
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('200 builds the hub+zone filter when both are provided', async () => {
    (prismaMock.order.findMany as jest.Mock).mockResolvedValue([]);

    await request(app)
      .get('/api/admin/orders?hub=Makati%20Hub&zone=NCR')
      .set('Authorization', adminAuthHeader());

    const args = (prismaMock.order.findMany as jest.Mock).mock.calls[0][0];
    expect(args.where.hub).toEqual({
      is: {
        name: { equals: 'Makati Hub', mode: 'insensitive' },
        zone: { name: { equals: 'NCR', mode: 'insensitive' } },
      },
    });
  });

  it('200 hub-only and zone-only filters fall back to single-field nested filters', async () => {
    (prismaMock.order.findMany as jest.Mock).mockResolvedValue([]);

    await request(app)
      .get('/api/admin/orders?hub=Makati%20Hub')
      .set('Authorization', adminAuthHeader());

    let args = (prismaMock.order.findMany as jest.Mock).mock.calls[0][0];
    expect(args.where.hub).toEqual({
      is: { name: { equals: 'Makati Hub', mode: 'insensitive' } },
    });

    (prismaMock.order.findMany as jest.Mock).mockClear();

    await request(app)
      .get('/api/admin/orders?zone=NCR')
      .set('Authorization', adminAuthHeader());

    args = (prismaMock.order.findMany as jest.Mock).mock.calls[0][0];
    expect(args.where.hub).toEqual({
      is: { zone: { name: { equals: 'NCR', mode: 'insensitive' } } },
    });
  });

  it('400 on an unknown status filter', async () => {
    const res = await request(app)
      .get('/api/admin/orders?status=bogus')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(400);
  });

  it('200 wires status and search filters', async () => {
    (prismaMock.order.findMany as jest.Mock).mockResolvedValue([]);

    await request(app)
      .get(`/api/admin/orders?status=${OrderStatus.available}&search=TRK0001`)
      .set('Authorization', adminAuthHeader());

    const args = (prismaMock.order.findMany as jest.Mock).mock.calls[0][0];
    expect(args.where.status).toBe(OrderStatus.available);
    expect(args.where.OR).toEqual([
      { trackingNumber: { contains: 'TRK0001', mode: 'insensitive' } },
      { recipientName: { contains: 'TRK0001', mode: 'insensitive' } },
      { addressText: { contains: 'TRK0001', mode: 'insensitive' } },
    ]);
  });
});

// ─── POST /api/admin/orders ───────────────────────────────────────────────

describe('POST /api/admin/orders', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).post('/api/admin/orders').send(validOrderBody);
    expect(res.status).toBe(401);
  });

  it('400 when required fields are missing', async () => {
    const res = await request(app)
      .post('/api/admin/orders')
      .set('Authorization', adminAuthHeader())
      .send({ trackingNumber: 'TRK-1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('409 when trackingNumber already exists', async () => {
    (prismaMock.order.findUnique as jest.Mock).mockResolvedValue(makeOrder());

    const res = await request(app)
      .post('/api/admin/orders')
      .set('Authorization', adminAuthHeader())
      .send(validOrderBody);

    expect(res.status).toBe(409);
  });

  it('404 when hub+zone combo cannot be resolved to a hub', async () => {
    (prismaMock.order.findUnique as jest.Mock).mockResolvedValue(null);
    (prismaMock.hub.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post('/api/admin/orders')
      .set('Authorization', adminAuthHeader())
      .send(validOrderBody);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Hub "Makati Hub" not found in zone "NCR"');
  });

  it('201 resolves hub by (hub, zone), maps fields, and persists status=available', async () => {
    (prismaMock.order.findUnique as jest.Mock).mockResolvedValue(null);
    (prismaMock.hub.findFirst as jest.Mock).mockResolvedValue({ id: 'hub-1' });
    (prismaMock.order.create as jest.Mock).mockResolvedValue(makeOrderWithHub());

    const res = await request(app)
      .post('/api/admin/orders')
      .set('Authorization', adminAuthHeader())
      .send(validOrderBody);

    expect(res.status).toBe(201);

    const args = (prismaMock.order.create as jest.Mock).mock.calls[0][0];
    expect(args.data).toMatchObject({
      trackingNumber: 'TRK-9999',
      recipientName: 'Maria',
      recipientPhone: '+639170000010',
      recipientField: 'Apt 4B',
      addressText: '123 Ayala Ave',
      addressLat: 14.55,
      addressLng: 121.02,
      addressGeocoded: true,
      serviceType: 'Express',
      codAmount: 250,
      packageDetails: 'Documents',
      specialInstructions: 'Leave at door',
      hubId: 'hub-1',
      status: OrderStatus.available,
    });
  });

  it('201 fills sensible defaults for optional address/recipient fields', async () => {
    (prismaMock.order.findUnique as jest.Mock).mockResolvedValue(null);
    (prismaMock.hub.findFirst as jest.Mock).mockResolvedValue({ id: 'hub-1' });
    (prismaMock.order.create as jest.Mock).mockResolvedValue(makeOrderWithHub());

    const minimal = {
      trackingNumber: 'TRK-MIN',
      recipient: { name: 'Maria', phone: '+639170000010' },
      address: { text: '123 Ayala Ave' },
      hub: 'Makati Hub',
      zone: 'NCR',
    };

    await request(app)
      .post('/api/admin/orders')
      .set('Authorization', adminAuthHeader())
      .send(minimal);

    const args = (prismaMock.order.create as jest.Mock).mock.calls[0][0];
    expect(args.data).toMatchObject({
      recipientField: '',
      addressLat: 0,
      addressLng: 0,
      addressGeocoded: false,
      serviceType: 'Standard',
      codAmount: 0,
      packageDetails: '',
      specialInstructions: '',
    });
  });
});

// ─── POST /api/admin/orders/bulk ──────────────────────────────────────────

describe('POST /api/admin/orders/bulk', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app)
      .post('/api/admin/orders/bulk')
      .send({ orders: [validOrderBody] });

    expect(res.status).toBe(401);
  });

  it('400 when orders is missing or empty', async () => {
    const res = await request(app)
      .post('/api/admin/orders/bulk')
      .set('Authorization', adminAuthHeader())
      .send({ orders: [] });

    expect(res.status).toBe(400);
  });

  it('201 imports valid orders, skips duplicates, missing fields, and unknown hubs — never throws on a bad item', async () => {
    const goodA = { ...validOrderBody, trackingNumber: 'TRK-A' };
    const goodB = { ...validOrderBody, trackingNumber: 'TRK-B', zone: 'Visayas' };
    const dupe = { ...validOrderBody, trackingNumber: 'TRK-DUP' };
    const incomplete = { trackingNumber: 'TRK-INC' };

    (prismaMock.order.findUnique as jest.Mock).mockImplementation(
      async (args: { where: { trackingNumber: string } }) => {
        return args.where.trackingNumber === 'TRK-DUP' ? makeOrder() : null;
      }
    );

    (prismaMock.hub.findFirst as jest.Mock).mockImplementation(
      async (args: {
        where: { zone: { name: { equals: string } } };
      }) => {
        const zoneName = args.where.zone.name.equals;
        return zoneName === 'NCR' ? { id: 'hub-1' } : null;
      }
    );

    (prismaMock.order.create as jest.Mock).mockResolvedValue(makeOrder());

    const res = await request(app)
      .post('/api/admin/orders/bulk')
      .set('Authorization', adminAuthHeader())
      .send({ orders: [goodA, dupe, incomplete, goodB] });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(1);
    expect(res.body.skipped).toBe(3);
    expect(res.body.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Duplicate tracking number: TRK-DUP'),
        expect.stringMatching(/Missing required fields for tracking: TRK-INC/),
        expect.stringContaining('TRK-B: Hub'),
      ])
    );
    expect((prismaMock.order.create as jest.Mock)).toHaveBeenCalledTimes(1);
  });
});

// ─── PUT /api/admin/orders/:id ────────────────────────────────────────────

describe('PUT /api/admin/orders/:id', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).put('/api/admin/orders/o-1').send({});
    expect(res.status).toBe(401);
  });

  it('404 when order does not exist', async () => {
    (prismaMock.order.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .put('/api/admin/orders/missing')
      .set('Authorization', adminAuthHeader())
      .send({ trackingNumber: 'TRK-NEW' });

    expect(res.status).toBe(404);
  });

  it('400 on an invalid status', async () => {
    (prismaMock.order.findUnique as jest.Mock).mockResolvedValue(makeOrder());

    const res = await request(app)
      .put('/api/admin/orders/order-1')
      .set('Authorization', adminAuthHeader())
      .send({ status: 'banana' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid status' });
  });

  it('400 when only one of hub or zone is supplied', async () => {
    (prismaMock.order.findUnique as jest.Mock).mockResolvedValue(makeOrder());

    const res = await request(app)
      .put('/api/admin/orders/order-1')
      .set('Authorization', adminAuthHeader())
      .send({ hub: 'Makati Hub' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/hub and zone/i);
  });

  it('400 when hubId is provided but the hub does not exist', async () => {
    (prismaMock.order.findUnique as jest.Mock).mockResolvedValue(makeOrder());
    (prismaMock.hub.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .put('/api/admin/orders/order-1')
      .set('Authorization', adminAuthHeader())
      .send({ hubId: 'hub-bogus' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Hub not found' });
  });

  it('200 maps nested recipient/address fields and connects hub by (hub, zone)', async () => {
    (prismaMock.order.findUnique as jest.Mock).mockResolvedValue(makeOrder());
    (prismaMock.hub.findFirst as jest.Mock).mockResolvedValue({ id: 'hub-2' });
    (prismaMock.order.update as jest.Mock).mockResolvedValue(makeOrderWithHub());

    const res = await request(app)
      .put('/api/admin/orders/order-1')
      .set('Authorization', adminAuthHeader())
      .send({
        recipient: { name: 'Updated Maria' },
        address: { text: '456 New Address', lat: 10, lng: 20 },
        status: OrderStatus.delivered,
        hub: 'Cebu Hub',
        zone: 'Visayas',
      });

    expect(res.status).toBe(200);

    const args = (prismaMock.order.update as jest.Mock).mock.calls[0][0];
    expect(args.where).toEqual({ id: 'order-1' });
    expect(args.data).toMatchObject({
      recipientName: 'Updated Maria',
      addressText: '456 New Address',
      addressLat: 10,
      addressLng: 20,
      status: OrderStatus.delivered,
      hub: { connect: { id: 'hub-2' } },
    });
    expect(args.data.recipientPhone).toBeUndefined();
    expect(args.data.addressGeocoded).toBeUndefined();
  });

  it('200 connects hub via hubId when only hubId is provided', async () => {
    (prismaMock.order.findUnique as jest.Mock).mockResolvedValue(makeOrder());
    (prismaMock.hub.findUnique as jest.Mock).mockResolvedValue(makeHub({ id: 'hub-7' }));
    (prismaMock.order.update as jest.Mock).mockResolvedValue(makeOrderWithHub());

    const res = await request(app)
      .put('/api/admin/orders/order-1')
      .set('Authorization', adminAuthHeader())
      .send({ hubId: 'hub-7' });

    expect(res.status).toBe(200);
    const args = (prismaMock.order.update as jest.Mock).mock.calls[0][0];
    expect(args.data.hub).toEqual({ connect: { id: 'hub-7' } });
  });
});

// ─── DELETE /api/admin/orders/:id ─────────────────────────────────────────

describe('DELETE /api/admin/orders/:id', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).delete('/api/admin/orders/o-1');
    expect(res.status).toBe(401);
  });

  it('404 when order does not exist', async () => {
    (prismaMock.order.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .delete('/api/admin/orders/missing')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(404);
  });

  it('200 hard-deletes the order', async () => {
    (prismaMock.order.findUnique as jest.Mock).mockResolvedValue(makeOrder());
    (prismaMock.order.delete as jest.Mock).mockResolvedValue(makeOrder());

    const res = await request(app)
      .delete('/api/admin/orders/order-1')
      .set('Authorization', adminAuthHeader());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Order deleted successfully' });
    expect((prismaMock.order.delete as jest.Mock)).toHaveBeenCalledWith({
      where: { id: 'order-1' },
    });
  });
});
