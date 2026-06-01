/// <reference types="node" />
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('📦 Adding 50 new orders (preserving existing data)...\n');

  // ─── Resolve existing hubs by name ──────────────────────────────────
  const hubMakati = await prisma.hub.findFirst({ where: { name: 'Makati Hub' } });
  const hubBGC = await prisma.hub.findFirst({ where: { name: 'BGC Hub' } });
  const hubAlabang = await prisma.hub.findFirst({ where: { name: 'Alabang Hub' } });

  if (!hubMakati || !hubBGC || !hubAlabang) {
    throw new Error('Missing hubs — run the main seed.ts first');
  }

  console.log(`  Found hubs: ${hubMakati.name}, ${hubBGC.name}, ${hubAlabang.name}\n`);

  // ─── Order templates ────────────────────────────────────────────────
  // Distribution: 25 Makati, 15 BGC, 10 Alabang
  const orderData = [
    // ── Makati Hub (25 orders) ──────────────────────────────────────
    { tn: 'LBC-2026-1001', name: 'Rafael Torres',    phone: '+639301001001', addr: '12 Legazpi St, Makati City',              lat: 14.5571, lng: 121.0195, svc: 'standard', cod: 0,    pkg: 'Envelope — letters',          inst: '', hub: hubMakati.id },
    { tn: 'LBC-2026-1002', name: 'Sofia Dela Vega',  phone: '+639301001002', addr: '34 Makati Ave cor. Paseo, Makati City',   lat: 14.5589, lng: 121.0163, svc: 'express',  cod: 980,  pkg: 'Medium box — shoes',           inst: 'Call upon arrival', hub: hubMakati.id },
    { tn: 'LBC-2026-1003', name: 'Miguel Villanueva', phone: '+639301001003', addr: '56 Valero St, Makati City',              lat: 14.5555, lng: 121.0188, svc: 'standard', cod: 0,    pkg: 'Small parcel — vitamins',      inst: '', hub: hubMakati.id },
    { tn: 'LBC-2026-1004', name: 'Camille Navarro',  phone: '+639301001004', addr: '78 Rada St, Makati City',                 lat: 14.5580, lng: 121.0212, svc: 'express',  cod: 2100, pkg: 'Large box — monitor',          inst: 'Fragile — handle with care', hub: hubMakati.id },
    { tn: 'LBC-2026-1005', name: 'Andres Reyes',     phone: '+639301001005', addr: '100 Chino Roces Ave, Makati City',        lat: 14.5497, lng: 121.0213, svc: 'standard', cod: 450,  pkg: 'Small box — snacks',           inst: 'Leave at guard house', hub: hubMakati.id },
    { tn: 'LBC-2026-1006', name: 'Isabella Cruz',    phone: '+639301001006', addr: '22 Amorsolo St, Makati City',             lat: 14.5603, lng: 121.0157, svc: 'standard', cod: 0,    pkg: 'Envelope — contracts',         inst: 'Deliver to 3rd floor', hub: hubMakati.id },
    { tn: 'LBC-2026-1007', name: 'Lorenzo Santos',   phone: '+639301001007', addr: '44 Dela Rosa St, Makati City',            lat: 14.5565, lng: 121.0230, svc: 'express',  cod: 3200, pkg: 'Large parcel — laptop',         inst: 'Recipient ID required', hub: hubMakati.id },
    { tn: 'LBC-2026-1008', name: 'Patricia Lim',     phone: '+639301001008', addr: '66 Alfaro St, Makati City',               lat: 14.5574, lng: 121.0174, svc: 'standard', cod: 0,    pkg: 'Small parcel — cosmetics',     inst: '', hub: hubMakati.id },
    { tn: 'LBC-2026-1009', name: 'Gabriel Tan',      phone: '+639301001009', addr: '88 Jupiter St Extension, Makati City',    lat: 14.5629, lng: 121.0231, svc: 'standard', cod: 780,  pkg: 'Medium box — kitchenware',     inst: 'Ring bell twice', hub: hubMakati.id },
    { tn: 'LBC-2026-1010', name: 'Victoria Yap',     phone: '+639301001010', addr: '110 Sen. Gil Puyat Ave, Makati City',     lat: 14.5534, lng: 121.0116, svc: 'express',  cod: 0,    pkg: 'Envelope — medical results',   inst: 'Urgent — time-sensitive', hub: hubMakati.id },
    { tn: 'LBC-2026-1011', name: 'Marco Guevara',    phone: '+639301001011', addr: '15 Yakal St, Makati City',                lat: 14.5501, lng: 121.0175, svc: 'standard', cod: 1650, pkg: 'Medium box — tools',           inst: '', hub: hubMakati.id },
    { tn: 'LBC-2026-1012', name: 'Andrea Bautista',  phone: '+639301001012', addr: '33 Palma St, Makati City',                lat: 14.5609, lng: 121.0207, svc: 'standard', cod: 0,    pkg: 'Small box — accessories',      inst: 'Leave with neighbor if absent', hub: hubMakati.id },
    { tn: 'LBC-2026-1013', name: 'Diego Mendoza',    phone: '+639301001013', addr: '55 Polaris St, Makati City',              lat: 14.5622, lng: 121.0191, svc: 'express',  cod: 4500, pkg: 'Large box — desktop PC',        inst: 'Ground floor only', hub: hubMakati.id },
    { tn: 'LBC-2026-1014', name: 'Lucia Fernandez',  phone: '+639301001014', addr: '77 Constellation St, Makati City',        lat: 14.5638, lng: 121.0204, svc: 'standard', cod: 320,  pkg: 'Small parcel — tea set',       inst: '', hub: hubMakati.id },
    { tn: 'LBC-2026-1015', name: 'Emilio Aquino',    phone: '+639301001015', addr: '99 Saturn St, Makati City',               lat: 14.5642, lng: 121.0218, svc: 'standard', cod: 0,    pkg: 'Envelope — passport',          inst: 'ID verification required', hub: hubMakati.id },
    { tn: 'LBC-2026-1016', name: 'Carmen Ocampo',    phone: '+639301001016', addr: '121 Rockwell Drive, Makati City',         lat: 14.5596, lng: 121.0264, svc: 'express',  cod: 5800, pkg: 'Large box — gaming console',    inst: 'Call 10 min before', hub: hubMakati.id },
    { tn: 'LBC-2026-1017', name: 'Joaquin Diaz',     phone: '+639301001017', addr: '143 Kalayaan Ave, Makati City',           lat: 14.5508, lng: 121.0147, svc: 'standard', cod: 0,    pkg: 'Medium parcel — clothes',      inst: '', hub: hubMakati.id },
    { tn: 'LBC-2026-1018', name: 'Teresa Abad',      phone: '+639301001018', addr: '165 JP Rizal St, Makati City',            lat: 14.5480, lng: 121.0135, svc: 'standard', cod: 920,  pkg: 'Small box — jewelry',          inst: 'Signature required', hub: hubMakati.id },
    { tn: 'LBC-2026-1019', name: 'Carlos Rivera',    phone: '+639301001019', addr: '187 Metropolitan Ave, Makati City',       lat: 14.5463, lng: 121.0197, svc: 'express',  cod: 1400, pkg: 'Medium box — camera lens',      inst: 'Fragile — do not stack', hub: hubMakati.id },
    { tn: 'LBC-2026-1020', name: 'Angela Pascual',   phone: '+639301001020', addr: '209 Buendia Ave, Makati City',            lat: 14.5540, lng: 121.0098, svc: 'standard', cod: 0,    pkg: 'Envelope — bank docs',         inst: '', hub: hubMakati.id },
    { tn: 'LBC-2026-1021', name: 'Roberto Manalo',   phone: '+639301001021', addr: '231 Urdaneta Village, Makati City',       lat: 14.5612, lng: 121.0252, svc: 'standard', cod: 2350, pkg: 'Large parcel — printer',        inst: 'Deliver to service entrance', hub: hubMakati.id },
    { tn: 'LBC-2026-1022', name: 'Elena Soriano',    phone: '+639301001022', addr: '253 Salcedo Village, Makati City',        lat: 14.5618, lng: 121.0240, svc: 'express',  cod: 0,    pkg: 'Small box — perfume',          inst: 'Ask for Elena at Unit 12B', hub: hubMakati.id },
    { tn: 'LBC-2026-1023', name: 'Fernando Reyes',   phone: '+639301001023', addr: '275 San Antonio Village, Makati City',    lat: 14.5590, lng: 121.0289, svc: 'standard', cod: 650,  pkg: 'Medium box — pet supplies',    inst: '', hub: hubMakati.id },
    { tn: 'LBC-2026-1024', name: 'Maria Luisa Chua', phone: '+639301001024', addr: '297 Bel-Air Village, Makati City',        lat: 14.5527, lng: 121.0271, svc: 'standard', cod: 0,    pkg: 'Envelope — certificates',      inst: 'Gate 2 only', hub: hubMakati.id },
    { tn: 'LBC-2026-1025', name: 'Ramon Castillo',   phone: '+639301001025', addr: '319 Dasmarinas Village, Makati City',     lat: 14.5487, lng: 121.0254, svc: 'express',  cod: 7200, pkg: 'Large box — home gym equipment', inst: 'Heavy item — bring dolly', hub: hubMakati.id },

    // ── BGC Hub (15 orders) ────────────────────────────────────────
    { tn: 'LBC-2026-1026', name: 'Bianca Estrada',   phone: '+639301001026', addr: '10 Rizal Drive, BGC, Taguig',             lat: 14.5491, lng: 121.0467, svc: 'standard', cod: 0,    pkg: 'Small parcel — stationery',    inst: '', hub: hubBGC.id },
    { tn: 'LBC-2026-1027', name: 'Enrique Moreno',   phone: '+639301001027', addr: '22 7th Avenue, BGC, Taguig',              lat: 14.5524, lng: 121.0514, svc: 'express',  cod: 1800, pkg: 'Medium box — headphones',       inst: 'Leave at concierge', hub: hubBGC.id },
    { tn: 'LBC-2026-1028', name: 'Jasmine Tiu',      phone: '+639301001028', addr: '34 32nd St, BGC, Taguig',                 lat: 14.5507, lng: 121.0537, svc: 'standard', cod: 0,    pkg: 'Envelope — invitation',        inst: '', hub: hubBGC.id },
    { tn: 'LBC-2026-1029', name: 'Paolo Aguilar',    phone: '+639301001029', addr: '46 McKinley Pkwy, BGC, Taguig',           lat: 14.5479, lng: 121.0498, svc: 'express',  cod: 3400, pkg: 'Large box — drone',             inst: 'Fragile — electronics', hub: hubBGC.id },
    { tn: 'LBC-2026-1030', name: 'Grace Villanueva', phone: '+639301001030', addr: '58 9th Avenue, BGC, Taguig',              lat: 14.5539, lng: 121.0543, svc: 'standard', cod: 550,  pkg: 'Small box — candles',          inst: 'Do not tilt', hub: hubBGC.id },
    { tn: 'LBC-2026-1031', name: 'Mark Salazar',     phone: '+639301001031', addr: 'Venice Grand Canal Mall, BGC, Taguig',    lat: 14.5456, lng: 121.0466, svc: 'standard', cod: 0,    pkg: 'Medium parcel — art prints',   inst: 'Building B, Unit 5', hub: hubBGC.id },
    { tn: 'LBC-2026-1032', name: 'Samantha Lee',     phone: '+639301001032', addr: 'Serendra, BGC, Taguig',                   lat: 14.5513, lng: 121.0469, svc: 'express',  cod: 2900, pkg: 'Large parcel — espresso machine', inst: 'Heavy item', hub: hubBGC.id },
    { tn: 'LBC-2026-1033', name: 'Justin Roxas',     phone: '+639301001033', addr: 'Market! Market!, Taguig',                 lat: 14.5493, lng: 121.0552, svc: 'standard', cod: 0,    pkg: 'Small box — chargers',         inst: '', hub: hubBGC.id },
    { tn: 'LBC-2026-1034', name: 'Karina Mendez',    phone: '+639301001034', addr: 'Icon Plaza, 26th St, BGC, Taguig',        lat: 14.5503, lng: 121.0491, svc: 'standard', cod: 1100, pkg: 'Medium box — skincare set',     inst: 'Text before delivery', hub: hubBGC.id },
    { tn: 'LBC-2026-1035', name: 'Vincent Gomez',    phone: '+639301001035', addr: 'Arya Residences, BGC, Taguig',            lat: 14.5534, lng: 121.0524, svc: 'express',  cod: 0,    pkg: 'Envelope — legal notice',      inst: 'Hand to recipient only', hub: hubBGC.id },
    { tn: 'LBC-2026-1036', name: 'Daniela Ponce',    phone: '+639301001036', addr: 'Two Serendra, BGC, Taguig',               lat: 14.5518, lng: 121.0478, svc: 'standard', cod: 680,  pkg: 'Small parcel — snacks box',    inst: '', hub: hubBGC.id },
    { tn: 'LBC-2026-1037', name: 'Adrian Flores',    phone: '+639301001037', addr: 'Grand Hyatt, 8th Ave, BGC, Taguig',       lat: 14.5544, lng: 121.0502, svc: 'express',  cod: 4100, pkg: 'Large box — TV wall mount',     inst: 'Delivery dock entrance', hub: hubBGC.id },
    { tn: 'LBC-2026-1038', name: 'Christine Yu',     phone: '+639301001038', addr: 'BGC Stopover, 31st St, Taguig',           lat: 14.5498, lng: 121.0528, svc: 'standard', cod: 0,    pkg: 'Medium parcel — baby clothes', inst: 'Ring unit 14A', hub: hubBGC.id },
    { tn: 'LBC-2026-1039', name: 'Jason Lam',        phone: '+639301001039', addr: 'East Gallery Place, BGC, Taguig',         lat: 14.5528, lng: 121.0487, svc: 'standard', cod: 1250, pkg: 'Small box — watch',            inst: 'Signature required', hub: hubBGC.id },
    { tn: 'LBC-2026-1040', name: 'Nikki Bernardo',   phone: '+639301001040', addr: 'Uptown Ritz, 36th St, BGC, Taguig',       lat: 14.5550, lng: 121.0558, svc: 'express',  cod: 0,    pkg: 'Envelope — visa docs',         inst: 'Urgent — passport enclosed', hub: hubBGC.id },

    // ── Alabang Hub (10 orders) ────────────────────────────────────
    { tn: 'LBC-2026-1041', name: 'Ricardo Magno',    phone: '+639301001041', addr: 'Festival Mall, Filinvest, Alabang',        lat: 14.4176, lng: 121.0397, svc: 'standard', cod: 0,    pkg: 'Small parcel — phone case',    inst: '', hub: hubAlabang.id },
    { tn: 'LBC-2026-1042', name: 'Maricel Santos',   phone: '+639301001042', addr: 'Molito Lifestyle Center, Alabang',         lat: 14.4210, lng: 121.0370, svc: 'express',  cod: 3600, pkg: 'Large box — blender set',       inst: 'Fragile — glass jar', hub: hubAlabang.id },
    { tn: 'LBC-2026-1043', name: 'Jerome Pascual',   phone: '+639301001043', addr: 'Alabang Hills Village, Muntinlupa',        lat: 14.4143, lng: 121.0422, svc: 'standard', cod: 850,  pkg: 'Medium box — supplements',     inst: 'Gate 1 — call guard', hub: hubAlabang.id },
    { tn: 'LBC-2026-1044', name: 'Trisha Velasco',   phone: '+639301001044', addr: 'Ayala Alabang Village, Muntinlupa',        lat: 14.4128, lng: 121.0480, svc: 'standard', cod: 0,    pkg: 'Envelope — certificates',      inst: 'Main gate only', hub: hubAlabang.id },
    { tn: 'LBC-2026-1045', name: 'Bryan dela Pena',  phone: '+639301001045', addr: 'Westgate Center, Filinvest, Alabang',      lat: 14.4188, lng: 121.0365, svc: 'express',  cod: 2200, pkg: 'Medium box — sneakers',        inst: '', hub: hubAlabang.id },
    { tn: 'LBC-2026-1046', name: 'Angelica Roque',   phone: '+639301001046', addr: 'Portofino Heights, Las Pinas',             lat: 14.4098, lng: 121.0445, svc: 'standard', cod: 0,    pkg: 'Small box — children toys',    inst: 'Ring intercom — Unit 7', hub: hubAlabang.id },
    { tn: 'LBC-2026-1047', name: 'Dennis Jimenez',   phone: '+639301001047', addr: 'Verdana Homes, Mamplasan, Alabang',        lat: 14.4062, lng: 121.0510, svc: 'express',  cod: 6500, pkg: 'Large parcel — office chair',   inst: 'Bulky item — ground floor', hub: hubAlabang.id },
    { tn: 'LBC-2026-1048', name: 'Hazel Manansala',  phone: '+639301001048', addr: 'Southvale, Las Pinas',                     lat: 14.4111, lng: 121.0332, svc: 'standard', cod: 420,  pkg: 'Small parcel — spices',        inst: '', hub: hubAlabang.id },
    { tn: 'LBC-2026-1049', name: 'Oliver Santiago',   phone: '+639301001049', addr: 'Evia Lifestyle Center, Las Pinas',        lat: 14.4050, lng: 121.0304, svc: 'standard', cod: 0,    pkg: 'Envelope — contracts',         inst: 'Hand to Oliver only', hub: hubAlabang.id },
    { tn: 'LBC-2026-1050', name: 'Monique Salinas',  phone: '+639301001050', addr: 'Camella Alabang, Muntinlupa',              lat: 14.4155, lng: 121.0348, svc: 'express',  cod: 1900, pkg: 'Medium box — tablet',          inst: 'Call before delivery', hub: hubAlabang.id },
  ];

  let created = 0;
  let skipped = 0;

  for (const o of orderData) {
    const exists = await prisma.order.findUnique({ where: { trackingNumber: o.tn } });
    if (exists) {
      console.log(`  ⏭  ${o.tn} — already exists, skipping`);
      skipped++;
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
    created++;
  }

  console.log();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Done! Created ${created} orders, skipped ${skipped}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Makati Hub:  25 orders (LBC-2026-1001 → 1025)`);
  console.log(`  BGC Hub:     15 orders (LBC-2026-1026 → 1040)`);
  console.log(`  Alabang Hub: 10 orders (LBC-2026-1041 → 1050)`);
  console.log(`  All orders created with status: available`);
  console.log();
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error('Seed failed:', e);
    prisma.$disconnect();
    process.exit(1);
  });
