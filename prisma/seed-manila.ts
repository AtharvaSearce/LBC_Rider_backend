/// <reference types="node" />
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('📦 Adding Manila Zone, Hubs, Riders, and Orders...\n');

  // 1. Create or find Zone
  let zoneManila = await prisma.zone.findFirst({ where: { name: 'Metro Manila Central' } });
  if (!zoneManila) {
    zoneManila = await prisma.zone.create({
      data: { name: 'Metro Manila Central' },
    });
    console.log(`  ✓ Created Zone: ${zoneManila.name}`);
  } else {
    console.log(`  Found Zone: ${zoneManila.name}`);
  }

  // 2. Create or find Hubs
  const hubs = [
    { name: 'Searce Philippines Office', lat: 14.5512, lng: 121.0498, radiusMeters: 5000, zoneId: zoneManila.id },
    { name: 'LBC Express Manila',        lat: 14.5095, lng: 121.0140, radiusMeters: 5000, zoneId: zoneManila.id },
  ];

  const dbHubs: Record<string, any> = {};

  for (const h of hubs) {
    let hub = await prisma.hub.findFirst({ where: { name: h.name } });
    if (!hub) {
      hub = await prisma.hub.create({ data: h });
      console.log(`  ✓ Created Hub: ${hub.name}`);
    } else {
      console.log(`  Found Hub: ${hub.name}`);
    }
    dbHubs[h.name] = hub;
  }

  const hubSearce = dbHubs['Searce Philippines Office'];
  const hubLBC = dbHubs['LBC Express Manila'];

  // 3. Create or find Riders
  console.log('\n  Adding riders for Manila...\n');
  const passwordHash = await bcrypt.hash('rider123', 12);
  const riderData = [
    { empId: 'RDR-MNL-001', name: 'Dhaval', email: 'dhaval@lbc.ph', phone: '+639171110001', hub: hubSearce.id },
    { empId: 'RDR-MNL-002', name: 'Joseph', email: 'joseph@lbc.ph', phone: '+639171110002', hub: hubLBC.id },
    { empId: 'RDR-MNL-003', name: 'Alvin',  email: 'alvin@lbc.ph',  phone: '+639171110003', hub: hubSearce.id },
  ];

  let ridersCreated = 0;
  for (const r of riderData) {
    let rider = await prisma.rider.findUnique({ where: { employeeId: r.empId } });
    if (!rider) {
      rider = await prisma.rider.create({
        data: {
          employeeId: r.empId,
          name: r.name,
          email: r.email,
          phone: r.phone,
          passwordHash,
          hubId: r.hub,
          vehicleType: 'motorcycle',
        },
      });
      console.log(`  ✓ Created Rider: ${rider.name} (${rider.employeeId})`);
      ridersCreated++;
    } else {
      console.log(`  ⏭  Rider already exists: ${rider.name} (${rider.employeeId})`);
    }
  }

  // 4. Orders (30 total)
  console.log('\n  Adding orders for Manila...\n');

  const orderData = [
    // ── Searce Philippines Office — BGC / Taguig (16 orders) ───────────
    { tn: 'LBC-MNL-2001', name: 'Marco Reyes',       phone: '+639281002001', addr: 'High Street, 9th Ave, BGC, Taguig',           lat: 14.5524, lng: 121.0514, svc: 'standard', cod: 0,    pkg: 'Envelope — documents',         inst: 'Leave at reception', hub: hubSearce.id },
    { tn: 'LBC-MNL-2002', name: 'Bea Salonga',       phone: '+639281002002', addr: 'One Bonifacio High Street, BGC, Taguig',      lat: 14.5500, lng: 121.0513, svc: 'express',  cod: 980,  pkg: 'Medium box — shoes',           inst: '', hub: hubSearce.id },
    { tn: 'LBC-MNL-2003', name: 'Carlo Aquino',      phone: '+639281002003', addr: '7th Avenue cor 28th St, BGC, Taguig',         lat: 14.5519, lng: 121.0507, svc: 'standard', cod: 1500, pkg: 'Large box — monitor',          inst: 'Fragile', hub: hubSearce.id },
    { tn: 'LBC-MNL-2004', name: 'Denise Lim',        phone: '+639281002004', addr: 'Uptown Mall, 36th St, BGC, Taguig',           lat: 14.5548, lng: 121.0562, svc: 'express',  cod: 0,    pkg: 'Envelope — contracts',         inst: 'Call upon arrival', hub: hubSearce.id },
    { tn: 'LBC-MNL-2005', name: 'Enrico Cruz',       phone: '+639281002005', addr: 'Serendra, McKinley Pkwy, BGC, Taguig',        lat: 14.5513, lng: 121.0469, svc: 'standard', cod: 250,  pkg: 'Small box — accessories',      inst: '', hub: hubSearce.id },
    { tn: 'LBC-MNL-2006', name: 'Frances Tan',       phone: '+639281002006', addr: 'Icon Plaza, 26th St, BGC, Taguig',            lat: 14.5503, lng: 121.0491, svc: 'standard', cod: 0,    pkg: 'Envelope — letters',           inst: '', hub: hubSearce.id },
    { tn: 'LBC-MNL-2007', name: 'Gabriel Uy',        phone: '+639281002007', addr: 'Net Park, 5th Ave, BGC, Taguig',              lat: 14.5536, lng: 121.0524, svc: 'express',  cod: 3500, pkg: 'Large box — desktop',          inst: 'Deliver to IT dept', hub: hubSearce.id },
    { tn: 'LBC-MNL-2008', name: 'Hannah Sy',         phone: '+639281002008', addr: 'Two Serendra, BGC, Taguig',                   lat: 14.5518, lng: 121.0478, svc: 'standard', cod: 600,  pkg: 'Small parcel — medicines',     inst: 'Leave with guard', hub: hubSearce.id },
    { tn: 'LBC-MNL-2009', name: 'Ivan Mercado',      phone: '+639281002009', addr: 'Arya Residences, BGC, Taguig',                lat: 14.5534, lng: 121.0524, svc: 'standard', cod: 0,    pkg: 'Medium box — supplies',        inst: '', hub: hubSearce.id },
    { tn: 'LBC-MNL-2010', name: 'Julia Ramos',       phone: '+639281002010', addr: 'East Gallery Place, BGC, Taguig',             lat: 14.5528, lng: 121.0487, svc: 'express',  cod: 0,    pkg: 'Envelope — visa forms',        inst: 'ID required', hub: hubSearce.id },
    { tn: 'LBC-MNL-2011', name: 'Kevin Ong',         phone: '+639281002011', addr: 'Grand Hyatt, 8th Ave, BGC, Taguig',           lat: 14.5544, lng: 121.0502, svc: 'standard', cod: 1500, pkg: 'Medium box — headset',         inst: 'Call 5 mins before', hub: hubSearce.id },
    { tn: 'LBC-MNL-2012', name: 'Lara Gomez',        phone: '+639281002012', addr: 'Venice Grand Canal Mall, BGC, Taguig',        lat: 14.5456, lng: 121.0466, svc: 'standard', cod: 0,    pkg: 'Small box — pendrive',         inst: '', hub: hubSearce.id },
    { tn: 'LBC-MNL-2013', name: 'Miguel Flores',     phone: '+639281002013', addr: 'Maridien, 30th St, BGC, Taguig',              lat: 14.5495, lng: 121.0540, svc: 'express',  cod: 4200, pkg: 'Large parcel — equipment',     inst: 'Fragile', hub: hubSearce.id },
    { tn: 'LBC-MNL-2014', name: 'Nadia Castro',      phone: '+639281002014', addr: 'Forbeswood Heights, BGC, Taguig',             lat: 14.5475, lng: 121.0530, svc: 'standard', cod: 800,  pkg: 'Small parcel — uniform',       inst: '', hub: hubSearce.id },
    { tn: 'LBC-MNL-2015', name: 'Oscar Padilla',     phone: '+639281002015', addr: 'The Fort Residences, BGC, Taguig',            lat: 14.5512, lng: 121.0498, svc: 'express',  cod: 0,    pkg: 'Envelope — contracts',         inst: 'Urgent', hub: hubSearce.id },
    { tn: 'LBC-MNL-2016', name: 'Patricia Dizon',    phone: '+639281002016', addr: 'Market! Market!, McKinley, Taguig',           lat: 14.5493, lng: 121.0552, svc: 'standard', cod: 650,  pkg: 'Medium parcel — gifts',        inst: '', hub: hubSearce.id },

    // ── LBC Express Manila — Pasay / MOA Complex (14 orders) ───────────
    { tn: 'LBC-MNL-2017', name: 'Quennie Bautista',  phone: '+639281002017', addr: 'Mall of Asia Complex, Pasay City',            lat: 14.5350, lng: 120.9820, svc: 'standard', cod: 2500, pkg: 'Medium box — shoes',           inst: '', hub: hubLBC.id },
    { tn: 'LBC-MNL-2018', name: 'Rafael Navarro',    phone: '+639281002018', addr: 'Two Ecom Center, MOA Complex, Pasay City',    lat: 14.5345, lng: 120.9810, svc: 'express',  cod: 0,    pkg: 'Envelope — books',             inst: 'Hand to recipient only', hub: hubLBC.id },
    { tn: 'LBC-MNL-2019', name: 'Sofia Reyes',       phone: '+639281002019', addr: 'Conrad Manila, Seaside Blvd, Pasay City',     lat: 14.5300, lng: 120.9800, svc: 'standard', cod: 800,  pkg: 'Small parcel — cosmetics',     inst: 'Leave at security', hub: hubLBC.id },
    { tn: 'LBC-MNL-2020', name: 'Tomas Aguilar',     phone: '+639281002020', addr: 'Pasay Rotonda, Taft Ave, Pasay City',         lat: 14.5378, lng: 120.9968, svc: 'standard', cod: 0,    pkg: 'Medium box — kitchenware',     inst: '', hub: hubLBC.id },
    { tn: 'LBC-MNL-2021', name: 'Ursula Vega',       phone: '+639281002021', addr: 'Newport City, Pasay City',                    lat: 14.5190, lng: 121.0190, svc: 'express',  cod: 450,  pkg: 'Small box — snacks',           inst: '', hub: hubLBC.id },
    { tn: 'LBC-MNL-2022', name: 'Victor Santos',     phone: '+639281002022', addr: 'Resorts World Manila, Pasay City',            lat: 14.5175, lng: 121.0205, svc: 'standard', cod: 1200, pkg: 'Medium box — apparel',         inst: 'Call on reaching', hub: hubLBC.id },
    { tn: 'LBC-MNL-2023', name: 'Wendy Cruz',        phone: '+639281002023', addr: 'NAIA Terminal 3, Pasay City',                 lat: 14.5113, lng: 121.0190, svc: 'standard', cod: 0,    pkg: 'Envelope — tax documents',     inst: '', hub: hubLBC.id },
    { tn: 'LBC-MNL-2024', name: 'Xander Lopez',      phone: '+639281002024', addr: 'Domestic Airport Rd, Pasay City',             lat: 14.5095, lng: 121.0140, svc: 'express',  cod: 5400, pkg: 'Large box — soundbar',         inst: 'Fragile', hub: hubLBC.id },
    { tn: 'LBC-MNL-2025', name: 'Yna Mariano',       phone: '+639281002025', addr: 'Cuneta Astrodome, Roxas Blvd, Pasay City',    lat: 14.5430, lng: 120.9930, svc: 'standard', cod: 0,    pkg: 'Small box — vitamins',         inst: 'Leave outside door', hub: hubLBC.id },
    { tn: 'LBC-MNL-2026', name: 'Zandro Pineda',     phone: '+639281002026', addr: 'Heritage Hotel, EDSA cor Roxas Blvd, Pasay',  lat: 14.5410, lng: 120.9950, svc: 'standard', cod: 600,  pkg: 'Small parcel — watch',         inst: '', hub: hubLBC.id },
    { tn: 'LBC-MNL-2027', name: 'Andrea Lim',        phone: '+639281002027', addr: 'SM Mall of Asia Arena, Pasay City',           lat: 14.5340, lng: 120.9840, svc: 'express',  cod: 0,    pkg: 'Medium box — baby items',      inst: 'Do not ring bell', hub: hubLBC.id },
    { tn: 'LBC-MNL-2028', name: 'Bruno Tan',         phone: '+639281002028', addr: 'Five E-Com Center, MOA Complex, Pasay City',  lat: 14.5358, lng: 120.9805, svc: 'standard', cod: 950,  pkg: 'Small box — tools',            inst: '', hub: hubLBC.id },
    { tn: 'LBC-MNL-2029', name: 'Carla Dizon',       phone: '+639281002029', addr: 'Macapagal Blvd, Pasay City',                  lat: 14.5290, lng: 120.9880, svc: 'standard', cod: 1800, pkg: 'Medium box — cables',          inst: 'Deliver at Gate 2', hub: hubLBC.id },
    { tn: 'LBC-MNL-2030', name: 'Diego Ramos',       phone: '+639281002030', addr: 'Okada Manila, Entertainment City, Pasay',     lat: 14.5165, lng: 120.9820, svc: 'express',  cod: 8900, pkg: 'Large box — smart TV',         inst: 'Very fragile', hub: hubLBC.id },
  ];

  let ordersCreated = 0;
  let ordersSkipped = 0;

  for (const o of orderData) {
    const exists = await prisma.order.findUnique({ where: { trackingNumber: o.tn } });
    if (exists) {
      console.log(`  ⏭  ${o.tn} — already exists, skipping`);
      ordersSkipped++;
      continue;
    }

    await prisma.order.create({
      data: {
        trackingNumber: o.tn,
        recipientName: o.name,
        recipientPhone: o.phone,
        addressText: o.addr,
        addressLat: o.lat,
        addressLng: o.lng,
        addressGeocoded: true,
        serviceType: o.svc,
        codAmount: o.cod,
        packageDetails: o.pkg,
        specialInstructions: o.inst,
        hubId: o.hub,
      },
    });
    const codLabel = o.cod > 0 ? `COD ₱${o.cod}` : 'prepaid';
    console.log(`  ✓ ${o.tn} → ${o.name} (${codLabel})`);
    ordersCreated++;
  }

  console.log();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Done! Created ${ordersCreated} orders, skipped ${ordersSkipped}`);
  console.log(`  Created ${ridersCreated} new riders`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Searce Philippines Office: 16 orders (LBC-MNL-2001 → 2016)`);
  console.log(`  LBC Express Manila:        14 orders (LBC-MNL-2017 → 2030)`);
  console.log(`  All orders created with status: available`);
  console.log();

  console.log('  Demo Logins for Manila:');
  console.log('  ┌──────────────┬────────────────┬──────────┐');
  console.log('  │ Rider Name   │ Email          │ Password │');
  console.log('  ├──────────────┼────────────────┼──────────┤');
  for (const r of riderData) {
    console.log(`  │ ${r.name.padEnd(12)} │ ${r.email.padEnd(14)} │ rider123 │`);
  }
  console.log('  └──────────────┴────────────────┴──────────┘');
  console.log();
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error('Seed failed:', e);
    prisma.$disconnect();
    process.exit(1);
  });
