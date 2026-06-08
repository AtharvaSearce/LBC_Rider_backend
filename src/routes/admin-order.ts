import { Router, Request, Response } from 'express';
import { OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

const router = Router();

const orderInclude = {
  hub: {
    select: {
      id: true,
      name: true,
      zone: { select: { id: true, name: true } },
    },
  },
} as const;

function queryString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function getOrderId(req: Request): string | null {
  const { id } = req.params;
  return typeof id === 'string' ? id : null;
}

function isOrderStatus(value: string): value is OrderStatus {
  return Object.values(OrderStatus).includes(value as OrderStatus);
}

async function resolveHubId(
  hubName: string,
  zoneName: string
): Promise<{ hubId: string } | { error: string }> {
  const hub = await prisma.hub.findFirst({
    where: {
      name: { equals: hubName, mode: 'insensitive' },
      zone: { name: { equals: zoneName, mode: 'insensitive' } },
    },
    select: { id: true },
  });

  if (!hub) {
    return { error: `Hub "${hubName}" not found in zone "${zoneName}"` };
  }

  return { hubId: hub.id };
}

type OrderInput = {
  trackingNumber?: string;
  recipient?: { name?: string; phone?: string; field?: string };
  address?: {
    text?: string;
    lat?: number;
    lng?: number;
    geocoded?: boolean;
  };
  serviceType?: string;
  codAmount?: number;
  packageDetails?: string;
  specialInstructions?: string;
  hub?: string;
  zone?: string;
  hubId?: string;
  status?: OrderStatus;
};

function validateRequiredOrderFields(item: OrderInput): string | null {
  if (
    !item.trackingNumber ||
    !item.recipient?.name ||
    !item.recipient?.phone ||
    !item.address?.text ||
    !item.hub ||
    !item.zone
  ) {
    return `Missing required fields for tracking: ${item.trackingNumber || 'unknown'}`;
  }
  return null;
}

async function buildOrderCreateData(
  item: OrderInput
): Promise<
  { data: Prisma.OrderUncheckedCreateInput } | { error: string }
> {
  const validationError = validateRequiredOrderFields(item);
  if (validationError) {
    return { error: validationError };
  }

  const hubResult = await resolveHubId(item.hub!, item.zone!);
  if ('error' in hubResult) {
    return { error: hubResult.error };
  }

  const data = {
    trackingNumber: item.trackingNumber!,
    recipientName: item.recipient!.name!,
    recipientPhone: item.recipient!.phone!,
    recipientField: item.recipient!.field ?? '',
    addressText: item.address!.text!,
    addressLat: item.address!.lat ?? 0,
    addressLng: item.address!.lng ?? 0,
    addressGeocoded: item.address!.geocoded ?? false,
    serviceType: item.serviceType ?? 'Standard',
    codAmount: item.codAmount ?? 0,
    packageDetails: item.packageDetails ?? '',
    specialInstructions: item.specialInstructions ?? '',
    hubId: hubResult.hubId,
    status: OrderStatus.available,
  } satisfies Prisma.OrderUncheckedCreateInput;

  return { data };
}

async function buildOrderUpdateData(
  body: OrderInput
): Promise<{ data: Prisma.OrderUpdateInput } | { error: string }> {
  const data: Prisma.OrderUpdateInput = {};

  if (body.trackingNumber !== undefined) {
    data.trackingNumber = body.trackingNumber;
  }

  if (body.recipient !== undefined) {
    if (body.recipient.name !== undefined) data.recipientName = body.recipient.name;
    if (body.recipient.phone !== undefined) data.recipientPhone = body.recipient.phone;
    if (body.recipient.field !== undefined) data.recipientField = body.recipient.field;
  }

  if (body.address !== undefined) {
    if (body.address.text !== undefined) data.addressText = body.address.text;
    if (body.address.lat !== undefined) data.addressLat = body.address.lat;
    if (body.address.lng !== undefined) data.addressLng = body.address.lng;
    if (body.address.geocoded !== undefined) {
      data.addressGeocoded = body.address.geocoded;
    }
  }

  if (body.serviceType !== undefined) data.serviceType = body.serviceType;
  if (body.codAmount !== undefined) data.codAmount = body.codAmount;
  if (body.packageDetails !== undefined) data.packageDetails = body.packageDetails;
  if (body.specialInstructions !== undefined) {
    data.specialInstructions = body.specialInstructions;
  }

  if (body.status !== undefined) {
    if (!isOrderStatus(body.status)) {
      return { error: 'Invalid status' };
    }
    data.status = body.status;
  }

  if (body.hub !== undefined || body.zone !== undefined) {
    if (!body.hub || !body.zone) {
      return { error: 'Both hub and zone are required to update hub assignment' };
    }

    const hubResult = await resolveHubId(body.hub, body.zone);
    if ('error' in hubResult) {
      return { error: hubResult.error };
    }

    data.hub = { connect: { id: hubResult.hubId } };
  } else if (body.hubId !== undefined) {
    const hub = await prisma.hub.findUnique({ where: { id: body.hubId } });
    if (!hub) {
      return { error: 'Hub not found' };
    }
    data.hub = { connect: { id: body.hubId } };
  }

  return { data };
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const hub = queryString(req.query.hub);
    const zone = queryString(req.query.zone);
    const status = queryString(req.query.status);
    const search = queryString(req.query.search);

    const where: Prisma.OrderWhereInput = {};

    if (hub && zone) {
      where.hub = {
        is: {
          name: { equals: hub, mode: 'insensitive' },
          zone: { name: { equals: zone, mode: 'insensitive' } },
        },
      };
    } else if (hub) {
      where.hub = { is: { name: { equals: hub, mode: 'insensitive' } } };
    } else if (zone) {
      where.hub = {
        is: { zone: { name: { equals: zone, mode: 'insensitive' } } },
      };
    }

    if (status) {
      if (!isOrderStatus(status)) {
        res.status(400).json({ error: 'Invalid status filter' });
        return;
      }
      where.status = status;
    }

    if (search) {
      where.OR = [
        { trackingNumber: { contains: search, mode: 'insensitive' } },
        { recipientName: { contains: search, mode: 'insensitive' } },
        { addressText: { contains: search, mode: 'insensitive' } },
      ];
    }

    const orders = await prisma.order.findMany({
      where,
      include: orderInclude,
      orderBy: { createdAt: 'desc' },
    });

    res.json({ orders, total: orders.length });
  } catch (err) {
    console.error('[Admin Orders] List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/bulk', async (req: Request, res: Response) => {
  try {
    const { orders: orderData } = req.body;

    if (!Array.isArray(orderData) || orderData.length === 0) {
      res.status(400).json({
        error: 'Request body must contain a non-empty "orders" array',
      });
      return;
    }

    const results = { created: 0, skipped: 0, errors: [] as string[] };

    for (const item of orderData as OrderInput[]) {
      try {
        const validationError = validateRequiredOrderFields(item);
        if (validationError) {
          results.errors.push(validationError);
          results.skipped++;
          continue;
        }

        const existing = await prisma.order.findUnique({
          where: { trackingNumber: item.trackingNumber! },
        });

        if (existing) {
          results.errors.push(`Duplicate tracking number: ${item.trackingNumber}`);
          results.skipped++;
          continue;
        }

        const built = await buildOrderCreateData(item);
        if ('error' in built) {
          results.errors.push(`${item.trackingNumber}: ${built.error}`);
          results.skipped++;
          continue;
        }

        await prisma.order.create({ data: built.data });
        results.created++;
      } catch (itemErr) {
        const message =
          itemErr instanceof Error ? itemErr.message : 'Unknown error';
        results.errors.push(
          `Error creating ${item.trackingNumber || 'unknown'}: ${message}`
        );
        results.skipped++;
      }
    }

    res.status(201).json({
      message: `Imported ${results.created} orders, skipped ${results.skipped}`,
      ...results,
    });
  } catch (err) {
    console.error('[Admin Orders] Bulk import error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const { trackingNumber, recipient, address, hub, zone } = req.body;

    if (
      !trackingNumber ||
      !recipient?.name ||
      !recipient?.phone ||
      !address?.text ||
      !hub ||
      !zone
    ) {
      res.status(400).json({
        error:
          'Missing required fields: trackingNumber, recipient (name, phone), address (text), hub, zone',
      });
      return;
    }

    const existing = await prisma.order.findUnique({
      where: { trackingNumber },
    });

    if (existing) {
      res.status(409).json({
        error: `Order with tracking number ${trackingNumber} already exists`,
      });
      return;
    }

    const built = await buildOrderCreateData(req.body);
    if ('error' in built) {
      res.status(404).json({ error: built.error });
      return;
    }

    const order = await prisma.order.create({
      data: built.data,
      include: orderInclude,
    });

    res.status(201).json({ order });
  } catch (err) {
    console.error('[Admin Orders] Create error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const orderId = getOrderId(req);
    if (!orderId) {
      res.status(400).json({ error: 'Invalid order id' });
      return;
    }

    const existing = await prisma.order.findUnique({ where: { id: orderId } });
    if (!existing) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    const built = await buildOrderUpdateData(req.body);
    if ('error' in built) {
      res.status(400).json({ error: built.error });
      return;
    }

    const order = await prisma.order.update({
      where: { id: orderId },
      data: built.data,
      include: orderInclude,
    });

    res.json({ order });
  } catch (err) {
    console.error('[Admin Orders] Update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const orderId = getOrderId(req);
    if (!orderId) {
      res.status(400).json({ error: 'Invalid order id' });
      return;
    }

    const existing = await prisma.order.findUnique({ where: { id: orderId } });
    if (!existing) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    await prisma.order.delete({ where: { id: orderId } });

    res.json({ message: 'Order deleted successfully' });
  } catch (err) {
    console.error('[Admin Orders] Delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
