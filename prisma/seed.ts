/// <reference types="node" />
import { PrismaClient, OrderStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...\n');

  // ─── Clean existing data (order matters for FK constraints) ────────
  console.log('Cleaning existing data...');
  await prisma.deliveryResult.deleteMany();
  await prisma.stop.deleteMany();
  await prisma.order.deleteMany();
  await prisma.manifest.deleteMany();
  await prisma.rider.deleteMany();
  await prisma.hub.deleteMany();
  await prisma.zone.deleteMany();
  console.log('  ✓ All tables cleared\n');

  // ─── Zones ─────────────────────────────────────────────────────────
  console.log('Creating zones...');
  const zone1 = await prisma.zone.create({
    data: { name: 'Metro Manila North' },
  });
  const zone2 = await prisma.zone.create({
    data: { name: 'Metro Manila South' },
  });
  console.log(`  ✓ ${zone1.name}, ${zone2.name}\n`);

  // ─── Hubs (real Manila coordinates) ────────────────────────────────
  console.log('Creating hubs...');
  const hubMakati = await prisma.hub.create({
    data: {
      name: 'Makati Hub',
      lat: 14.5547,
      lng: 121.0244,
      radiusMeters: 500,
      zoneId: zone1.id,
    },
  });
  const hubBGC = await prisma.hub.create({
    data: {
      name: 'BGC Hub',
      lat: 14.5518,
      lng: 121.0509,
      radiusMeters: 400,
      zoneId: zone1.id,
    },
  });
  const hubAlabang = await prisma.hub.create({
    data: {
      name: 'Alabang Hub',
      lat: 14.4168,
      lng: 121.0487,
      radiusMeters: 600,
      zoneId: zone2.id,
    },
  });
  console.log(`  ✓ ${hubMakati.name}, ${hubBGC.name}, ${hubAlabang.name}\n`);

  // ─── Riders ────────────────────────────────────────────────────────
  console.log('Creating riders...');
  const passwordHash = await bcrypt.hash('rider123', 12);
  const demoPasswordHash = await bcrypt.hash('demo123', 12);

  const riders = await Promise.all([
    prisma.rider.create({
      data: {
        employeeId: 'RDR-001',
        name: 'Juan Dela Cruz',
        email: 'juan@lbc.ph',
        phone: '+639171234567',
        passwordHash,
        hubId: hubMakati.id,
        vehicleType: 'motorcycle',
      },
    }),
    prisma.rider.create({
      data: {
        employeeId: 'RDR-002',
        name: 'Maria Santos',
        email: 'maria@lbc.ph',
        phone: '+639181234567',
        passwordHash,
        hubId: hubBGC.id,
        vehicleType: 'motorcycle',
      },
    }),
    prisma.rider.create({
      data: {
        employeeId: 'RDR-003',
        name: 'Pedro Reyes',
        email: 'pedro@lbc.ph',
        phone: '+639191234567',
        passwordHash,
        hubId: hubAlabang.id,
        vehicleType: 'van',
      },
    }),
    prisma.rider.create({
      data: {
        employeeId: 'RDR-DEMO',
        name: 'Demo Rider',
        email: 'demo@lbc.ph',
        phone: '+639001234567',
        passwordHash: demoPasswordHash,
        hubId: hubMakati.id,
        vehicleType: 'motorcycle',
      },
    }),
  ]);

  const [juan, maria, pedro, demo] = riders;
  for (const r of riders) {
    console.log(`  ✓ ${r.employeeId} — ${r.name} (${r.email})`);
  }
  console.log();

  // ─── Orders (available for barcode scanning) ───────────────────────
  console.log('Creating orders...');

  const orderData = [
    // Makati Hub orders
    {
      trackingNumber: 'LBC-2026-0001',
      recipientName: 'Ana Garcia',
      recipientPhone: '+639201111111',
      addressText: '123 Ayala Avenue, Makati City',
      addressLat: 14.5567,
      addressLng: 121.0236,
      addressGeocoded: true,
      serviceType: 'standard',
      codAmount: 0,
      packageDetails: 'Small parcel — documents',
      specialInstructions: 'Leave at reception',
      hubId: hubMakati.id,
    },
    {
      trackingNumber: 'LBC-2026-0002',
      recipientName: 'Carlo Mendoza',
      recipientPhone: '+639202222222',
      addressText: '456 Makati Avenue, Makati City',
      addressLat: 14.5584,
      addressLng: 121.0152,
      addressGeocoded: true,
      serviceType: 'express',
      codAmount: 1500,
      packageDetails: 'Medium box — electronics',
      specialInstructions: 'Call before delivery',
      hubId: hubMakati.id,
    },
    {
      trackingNumber: 'LBC-2026-0003',
      recipientName: 'Diana Cruz',
      recipientPhone: '+639203333333',
      addressText: '789 Gil Puyat Ave, Makati City',
      addressLat: 14.5547,
      addressLng: 121.0134,
      addressGeocoded: true,
      serviceType: 'standard',
      codAmount: 350,
      packageDetails: 'Small box — clothing',
      specialInstructions: '',
      hubId: hubMakati.id,
    },
    {
      trackingNumber: 'LBC-2026-0004',
      recipientName: 'Eduardo Lim',
      recipientPhone: '+639204444444',
      addressText: '1001 Paseo de Roxas, Makati City',
      addressLat: 14.5585,
      addressLng: 121.0201,
      addressGeocoded: true,
      serviceType: 'express',
      codAmount: 2800,
      packageDetails: 'Large box — appliance',
      specialInstructions: 'Fragile — handle with care',
      hubId: hubMakati.id,
    },
    {
      trackingNumber: 'LBC-2026-0005',
      recipientName: 'Fiona Tan',
      recipientPhone: '+639205555555',
      addressText: '88 Jupiter St, Makati City',
      addressLat: 14.5620,
      addressLng: 121.0220,
      addressGeocoded: true,
      serviceType: 'standard',
      codAmount: 0,
      packageDetails: 'Envelope — contracts',
      specialInstructions: 'Deliver to 5th floor, office 502',
      hubId: hubMakati.id,
    },
    // BGC Hub orders
    {
      trackingNumber: 'LBC-2026-0006',
      recipientName: 'George Sy',
      recipientPhone: '+639206666666',
      addressText: '5th Ave corner 28th St, BGC, Taguig',
      addressLat: 14.5516,
      addressLng: 121.0485,
      addressGeocoded: true,
      serviceType: 'express',
      codAmount: 4200,
      packageDetails: 'Large box — computer parts',
      specialInstructions: 'Lobby only — no unit access',
      hubId: hubBGC.id,
    },
    {
      trackingNumber: 'LBC-2026-0007',
      recipientName: 'Helen Ramos',
      recipientPhone: '+639207777777',
      addressText: 'One Bonifacio High Street, BGC, Taguig',
      addressLat: 14.5500,
      addressLng: 121.0513,
      addressGeocoded: true,
      serviceType: 'standard',
      codAmount: 750,
      packageDetails: 'Medium parcel — cosmetics',
      specialInstructions: '',
      hubId: hubBGC.id,
    },
    {
      trackingNumber: 'LBC-2026-0008',
      recipientName: 'Ian Ong',
      recipientPhone: '+639208888888',
      addressText: 'Uptown Mall, 36th St, BGC, Taguig',
      addressLat: 14.5548,
      addressLng: 121.0562,
      addressGeocoded: true,
      serviceType: 'standard',
      codAmount: 0,
      packageDetails: 'Small box — books',
      specialInstructions: 'Ring doorbell twice',
      hubId: hubBGC.id,
    },
    // Alabang Hub orders
    {
      trackingNumber: 'LBC-2026-0009',
      recipientName: 'Jessica Villanueva',
      recipientPhone: '+639209999999',
      addressText: 'Alabang Town Center, Muntinlupa',
      addressLat: 14.4170,
      addressLng: 121.0455,
      addressGeocoded: true,
      serviceType: 'express',
      codAmount: 5500,
      packageDetails: 'Large parcel — furniture part',
      specialInstructions: 'Gate 3 — ask for security',
      hubId: hubAlabang.id,
    },
    {
      trackingNumber: 'LBC-2026-0010',
      recipientName: 'Kevin Santos',
      recipientPhone: '+639210000000',
      addressText: 'Filinvest Corporate City, Alabang',
      addressLat: 14.4195,
      addressLng: 121.0397,
      addressGeocoded: true,
      serviceType: 'standard',
      codAmount: 250,
      packageDetails: 'Small parcel — vitamins',
      specialInstructions: '',
      hubId: hubAlabang.id,
    },
    // Extra available orders for Makati (demo scanning)
    {
      trackingNumber: 'LBC-2026-0011',
      recipientName: 'Luis Aquino',
      recipientPhone: '+639211111111',
      addressText: '222 Legaspi St, Makati City',
      addressLat: 14.5563,
      addressLng: 121.0182,
      addressGeocoded: true,
      serviceType: 'express',
      codAmount: 1200,
      packageDetails: 'Medium box — gadgets',
      specialInstructions: 'Do not leave at door',
      hubId: hubMakati.id,
    },
    {
      trackingNumber: 'LBC-2026-0012',
      recipientName: 'Nina Reyes',
      recipientPhone: '+639212222222',
      addressText: '55 Salcedo St, Makati City',
      addressLat: 14.5604,
      addressLng: 121.0217,
      addressGeocoded: true,
      serviceType: 'standard',
      codAmount: 0,
      packageDetails: 'Envelope — legal docs',
      specialInstructions: 'Ask for Nina at front desk',
      hubId: hubMakati.id,
    },
  ];

  const orders = [];
  for (const o of orderData) {
    const order = await prisma.order.create({ data: o });
    orders.push(order);
    console.log(`  ✓ ${order.trackingNumber} → ${order.recipientName} (${o.codAmount > 0 ? `COD ₱${o.codAmount}` : 'prepaid'})`);
  }
  console.log();

  // ─── Pre-built manifest for Juan (shows completed delivery flow) ───
  console.log('Creating sample manifest for Juan (RDR-001)...');
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const juanOrders = orders.filter((o) => o.hubId === hubMakati.id).slice(0, 3);

  const manifest1 = await prisma.manifest.create({
    data: {
      manifestId: `DDR-${today.toISOString().slice(0, 10).replace(/-/g, '')}-DEMO`,
      riderId: juan.id,
      date: today,
      status: 'in_progress',
      totalStops: juanOrders.length,
      completedStops: 1,
      failedStops: 0,
    },
  });

  for (let i = 0; i < juanOrders.length; i++) {
    const order = juanOrders[i];
    const isFirst = i === 0;
    const stopStatus = isFirst ? 'completed' : i === 1 ? 'in_progress' : 'pending';

    const stop = await prisma.stop.create({
      data: {
        stopId: `STOP-DEMO-${String(i + 1).padStart(3, '0')}`,
        manifestId: manifest1.id,
        orderId: order.id,
        sequence: i + 1,
        status: stopStatus,
        distance: 1.2 + i * 0.8,
        eta: `${10 + i * 8} min`,
        attemptCount: isFirst ? 1 : 0,
      },
    });

    await prisma.order.update({
      where: { id: order.id },
      data: {
        status: isFirst ? 'delivered' as OrderStatus : 'assigned' as OrderStatus,
        assignedManifestId: manifest1.id,
      },
    });

    if (isFirst) {
      await prisma.deliveryResult.create({
        data: {
          stopId: stop.id,
          outcome: 'delivered',
          timestamp: new Date(),
          codCollected: order.codAmount,
        },
      });
    }

    console.log(`  ✓ Stop ${i + 1}: ${order.trackingNumber} — ${stopStatus}`);
  }
  console.log();

  // ─── Pre-built manifest for Maria (BGC, all pending) ──────────────
  console.log('Creating sample manifest for Maria (RDR-002)...');
  const mariaOrders = orders.filter((o) => o.hubId === hubBGC.id);

  const manifest2 = await prisma.manifest.create({
    data: {
      manifestId: `DDR-${today.toISOString().slice(0, 10).replace(/-/g, '')}-BGC1`,
      riderId: maria.id,
      date: today,
      status: 'pending',
      totalStops: mariaOrders.length,
    },
  });

  for (let i = 0; i < mariaOrders.length; i++) {
    const order = mariaOrders[i];
    await prisma.stop.create({
      data: {
        stopId: `STOP-BGC-${String(i + 1).padStart(3, '0')}`,
        manifestId: manifest2.id,
        orderId: order.id,
        sequence: i + 1,
        status: i === 0 ? 'in_progress' : 'pending',
        distance: 0.5 + i * 1.1,
        eta: `${5 + i * 12} min`,
      },
    });

    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'assigned', assignedManifestId: manifest2.id },
    });

    console.log(`  ✓ Stop ${i + 1}: ${order.trackingNumber} — ${i === 0 ? 'in_progress' : 'pending'}`);
  }
  console.log();

  // ─── Summary ───────────────────────────────────────────────────────
  const availableOrders = orders.length - juanOrders.length - mariaOrders.length;
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Seed complete!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Zones:     ${2}`);
  console.log(`  Hubs:      ${3}`);
  console.log(`  Riders:    ${riders.length}`);
  console.log(`  Orders:    ${orders.length} (${availableOrders} available for scanning)`);
  console.log(`  Manifests: 2`);
  console.log();
  console.log('  Demo Logins:');
  console.log('  ┌──────────────┬────────────────┬──────────┐');
  console.log('  │ Role         │ Email          │ Password │');
  console.log('  ├──────────────┼────────────────┼──────────┤');
  console.log('  │ Demo Rider   │ demo@lbc.ph    │ demo123  │');
  console.log('  │ Rider Juan   │ juan@lbc.ph    │ rider123 │');
  console.log('  │ Rider Maria  │ maria@lbc.ph   │ rider123 │');
  console.log('  │ Rider Pedro  │ pedro@lbc.ph   │ rider123 │');
  console.log('  │ Admin        │ admin@lbc.ph   │ admin123 │');
  console.log('  └──────────────┴────────────────┴──────────┘');
  console.log();
  console.log('  Available tracking numbers to scan:');
  for (const o of orders) {
    const assigned = juanOrders.some((j) => j.id === o.id) || mariaOrders.some((m) => m.id === o.id);
    if (!assigned) {
      console.log(`    ${o.trackingNumber}  →  ${o.recipientName}`);
    }
  }
  console.log();
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error('Seed failed:', e);
    prisma.$disconnect();
    process.exit(1);
  });
