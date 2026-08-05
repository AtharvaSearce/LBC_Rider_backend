/// <reference types="node" />
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🚀 QuadX Seed — Adding Pune Metro Zone, Hinjewadi Hub, Riders & Orders...\n');

  // ─── 1. Zone: Pune Metro ────────────────────────────────────────────
  let zonePune = await prisma.zone.findFirst({ where: { name: 'Pune Metro' } });
  if (!zonePune) {
    zonePune = await prisma.zone.create({ data: { name: 'Pune Metro' } });
    console.log(`  ✓ Created Zone: ${zonePune.name}`);
  } else {
    console.log(`  ⏭  Zone already exists: ${zonePune.name}`);
  }

  // ─── 2. Hub: Hinjewadi Hub ──────────────────────────────────────────
  let hubHinjewadi = await prisma.hub.findFirst({ where: { name: 'Hinjewadi Hub' } });
  if (!hubHinjewadi) {
    hubHinjewadi = await prisma.hub.create({
      data: {
        name: 'Hinjewadi Hub',
        lat: 18.5913,
        lng: 73.7389,
        radiusMeters: 5000,
        zoneId: zonePune.id,
      },
    });
    console.log(`  ✓ Created Hub: ${hubHinjewadi.name}`);
  } else {
    console.log(`  ⏭  Hub already exists: ${hubHinjewadi.name}`);
  }

  // ─── 3. Riders ──────────────────────────────────────────────────────
  console.log('\n  Adding QuadX riders...\n');
  const passwordHash = await bcrypt.hash('rider123', 12);

  const riderData = [
    { empId: 'QDX-RDR-001', name: 'Arjun Patil',   email: 'demo@quadx.xyz',  phone: '+919876500001' },
    { empId: 'QDX-RDR-002', name: 'Sneha Kulkarni', email: 'rider@quadx.xyz', phone: '+919876500002' },
  ];

  let ridersCreated = 0;
  for (const r of riderData) {
    let rider = await prisma.rider.findFirst({
      where: { OR: [{ employeeId: r.empId }, { email: r.email }] },
    });
    if (!rider) {
      rider = await prisma.rider.create({
        data: {
          employeeId: r.empId,
          name: r.name,
          email: r.email,
          phone: r.phone,
          passwordHash,
          hubId: hubHinjewadi.id,
          vehicleType: 'motorcycle',
        },
      });
      console.log(`  ✓ Created Rider: ${rider.name} (${rider.employeeId}) — ${r.email}`);
      ridersCreated++;
    } else {
      console.log(`  ⏭  Rider already exists: ${rider.name} (${rider.employeeId})`);
    }
  }

  // ─── 4. Orders (50 total) — all for Hinjewadi Hub ───────────────────
  console.log('\n  Adding 50 QuadX orders for Hinjewadi Hub...\n');

  // Real addresses and coordinates around Hinjewadi / Wakad / Balewadi / Baner, Pune
  const orderData = [
    { tn: 'QDX-2026-0001', name: 'Rahul Sharma',       phone: '+919800100001', addr: 'Phase 1, Hinjewadi IT Park, Pune',                lat: 18.5912, lng: 73.7380, svc: 'standard', cod: 0,    pkg: 'Envelope — offer letter',         inst: 'Reception desk, Tower A' },
    { tn: 'QDX-2026-0002', name: 'Priya Deshmukh',     phone: '+919800100002', addr: 'Phase 2, Hinjewadi IT Park, Pune',                lat: 18.5870, lng: 73.7230, svc: 'express',  cod: 1250, pkg: 'Medium box — headphones',          inst: 'Call before delivery' },
    { tn: 'QDX-2026-0003', name: 'Aditya Joshi',       phone: '+919800100003', addr: 'Phase 3, Hinjewadi IT Park, Pune',                lat: 18.5785, lng: 73.7070, svc: 'standard', cod: 0,    pkg: 'Small parcel — USB drives',        inst: '' },
    { tn: 'QDX-2026-0004', name: 'Neha Kulkarni',      phone: '+919800100004', addr: 'Rajiv Gandhi Infotech Park, Hinjewadi, Pune',     lat: 18.5895, lng: 73.7345, svc: 'express',  cod: 3200, pkg: 'Large box — monitor',               inst: 'Fragile — handle with care' },
    { tn: 'QDX-2026-0005', name: 'Vikram Pawar',       phone: '+919800100005', addr: 'Xion Mall, Hinjewadi, Pune',                      lat: 18.5920, lng: 73.7410, svc: 'standard', cod: 500,  pkg: 'Small box — phone cover',          inst: '' },
    { tn: 'QDX-2026-0006', name: 'Sakshi Bhosale',     phone: '+919800100006', addr: 'Wakad Bridge Rd, Wakad, Pune',                    lat: 18.5988, lng: 73.7625, svc: 'standard', cod: 0,    pkg: 'Envelope — legal documents',       inst: 'Leave at security gate' },
    { tn: 'QDX-2026-0007', name: 'Rohan Mane',         phone: '+919800100007', addr: 'Datta Mandir Rd, Wakad, Pune',                    lat: 18.6010, lng: 73.7590, svc: 'express',  cod: 2100, pkg: 'Medium box — shoes',               inst: 'Ring doorbell twice' },
    { tn: 'QDX-2026-0008', name: 'Ananya Deshpande',   phone: '+919800100008', addr: 'Bhumkar Chowk, Wakad, Pune',                     lat: 18.6005, lng: 73.7545, svc: 'standard', cod: 750,  pkg: 'Small parcel — cosmetics',         inst: '' },
    { tn: 'QDX-2026-0009', name: 'Siddharth Patil',    phone: '+919800100009', addr: 'Mont Vert Avion, Wakad, Pune',                    lat: 18.5995, lng: 73.7580, svc: 'standard', cod: 0,    pkg: 'Medium parcel — baby items',       inst: 'Do not ring bell — baby sleeping' },
    { tn: 'QDX-2026-0010', name: 'Pooja Gaikwad',      phone: '+919800100010', addr: 'Shankar Kalat Nagar, Wakad, Pune',                lat: 18.6035, lng: 73.7615, svc: 'express',  cod: 4500, pkg: 'Large box — air fryer',             inst: 'Fragile — keep upright' },
    { tn: 'QDX-2026-0011', name: 'Amol Kale',          phone: '+919800100011', addr: 'Balewadi High St, Balewadi, Pune',                lat: 18.5720, lng: 73.7700, svc: 'standard', cod: 0,    pkg: 'Envelope — insurance papers',      inst: '' },
    { tn: 'QDX-2026-0012', name: 'Shreya Naik',        phone: '+919800100012', addr: 'Balewadi Phata, Pune',                            lat: 18.5745, lng: 73.7680, svc: 'express',  cod: 1800, pkg: 'Medium box — keyboard',             inst: 'Call upon arrival' },
    { tn: 'QDX-2026-0013', name: 'Karthik Iyer',       phone: '+919800100013', addr: 'ICC Trade Tower, Balewadi, Pune',                 lat: 18.5730, lng: 73.7720, svc: 'standard', cod: 350,  pkg: 'Small box — charger cables',       inst: '' },
    { tn: 'QDX-2026-0014', name: 'Meena Raut',         phone: '+919800100014', addr: 'Baner Rd, near Orchid School, Pune',              lat: 18.5625, lng: 73.7810, svc: 'standard', cod: 0,    pkg: 'Small parcel — stationery',        inst: 'Leave at watchman cabin' },
    { tn: 'QDX-2026-0015', name: 'Tushar More',        phone: '+919800100015', addr: 'DSK Vishwa, Baner, Pune',                         lat: 18.5615, lng: 73.7830, svc: 'express',  cod: 6800, pkg: 'Large box — gaming console',        inst: 'ID verification required' },
    { tn: 'QDX-2026-0016', name: 'Ritu Chavan',        phone: '+919800100016', addr: 'Pancard Club Rd, Baner, Pune',                    lat: 18.5590, lng: 73.7795, svc: 'standard', cod: 920,  pkg: 'Medium box — skincare set',        inst: '' },
    { tn: 'QDX-2026-0017', name: 'Gaurav Sathe',       phone: '+919800100017', addr: 'Verandah, Baner, Pune',                           lat: 18.5640, lng: 73.7865, svc: 'standard', cod: 0,    pkg: 'Envelope — certificates',          inst: 'Building C, Flat 403' },
    { tn: 'QDX-2026-0018', name: 'Deepa Jadhav',       phone: '+919800100018', addr: 'Sus Rd, Pashan, Pune',                            lat: 18.5540, lng: 73.7870, svc: 'express',  cod: 1500, pkg: 'Medium box — sneakers',             inst: 'Text before delivery' },
    { tn: 'QDX-2026-0019', name: 'Manish Wagh',        phone: '+919800100019', addr: 'Mahalunge, Pune',                                 lat: 18.5855, lng: 73.7480, svc: 'standard', cod: 0,    pkg: 'Small box — medicines',            inst: 'Urgent — time-sensitive' },
    { tn: 'QDX-2026-0020', name: 'Kavita Shinde',      phone: '+919800100020', addr: 'Life Republic, Marunji, Pune',                    lat: 18.5820, lng: 73.7150, svc: 'express',  cod: 2500, pkg: 'Large parcel — office chair',       inst: 'Ground floor delivery' },
    { tn: 'QDX-2026-0021', name: 'Suresh Bhagat',      phone: '+919800100021', addr: 'Blue Ridge Society, Hinjewadi, Pune',             lat: 18.5880, lng: 73.7320, svc: 'standard', cod: 480,  pkg: 'Small parcel — spices',            inst: '' },
    { tn: 'QDX-2026-0022', name: 'Pallavi Khandekar',  phone: '+919800100022', addr: 'Megapolis, Hinjewadi Phase 3, Pune',              lat: 18.5780, lng: 73.7050, svc: 'standard', cod: 0,    pkg: 'Envelope — bank statements',       inst: 'Tower D, Reception' },
    { tn: 'QDX-2026-0023', name: 'Nitin Kadam',        phone: '+919800100023', addr: 'Panchshil Tech Park, Hinjewadi, Pune',            lat: 18.5905, lng: 73.7355, svc: 'express',  cod: 3800, pkg: 'Large box — printer',               inst: 'Deliver to admin office' },
    { tn: 'QDX-2026-0024', name: 'Swati Londhe',       phone: '+919800100024', addr: 'Laxmi Chowk, Maan, Hinjewadi, Pune',              lat: 18.5840, lng: 73.7280, svc: 'standard', cod: 650,  pkg: 'Medium box — tea set',             inst: '' },
    { tn: 'QDX-2026-0025', name: 'Vishal Ghate',       phone: '+919800100025', addr: 'EON Free Zone, Kharadi, Pune',                    lat: 18.5560, lng: 73.9410, svc: 'express',  cod: 0,    pkg: 'Envelope — contracts',             inst: 'Hand to recipient only' },
    { tn: 'QDX-2026-0026', name: 'Anjali Tambe',       phone: '+919800100026', addr: 'Teerth Towers, Baner, Pune',                      lat: 18.5600, lng: 73.7750, svc: 'standard', cod: 1100, pkg: 'Medium box — kitchen appliance',   inst: 'Ring intercom — Flat 802' },
    { tn: 'QDX-2026-0027', name: 'Rajesh Sawant',      phone: '+919800100027', addr: 'Kumar Shantiniketan, Pashan, Pune',               lat: 18.5510, lng: 73.7860, svc: 'standard', cod: 0,    pkg: 'Small box — pen drives',           inst: '' },
    { tn: 'QDX-2026-0028', name: 'Smita Phadke',       phone: '+919800100028', addr: 'Pride World City, Lohegaon, Pune',                lat: 18.5750, lng: 73.7690, svc: 'express',  cod: 5200, pkg: 'Large box — soundbar',              inst: 'Fragile — do not stack' },
    { tn: 'QDX-2026-0029', name: 'Abhijit Gokhale',    phone: '+919800100029', addr: 'Godrej Infinity, Keshav Nagar, Pune',             lat: 18.5480, lng: 73.9250, svc: 'standard', cod: 320,  pkg: 'Small parcel — herbal tea',        inst: '' },
    { tn: 'QDX-2026-0030', name: 'Tanvi Deshpande',    phone: '+919800100030', addr: 'Nyati Eternity, NIBM Rd, Pune',                   lat: 18.4720, lng: 73.8960, svc: 'express',  cod: 0,    pkg: 'Envelope — passport copies',       inst: 'Urgent' },
    { tn: 'QDX-2026-0031', name: 'Hemant Thakkar',     phone: '+919800100031', addr: 'Elita Promenade, Hinjewadi Phase 1, Pune',        lat: 18.5900, lng: 73.7370, svc: 'standard', cod: 1400, pkg: 'Medium box — desk lamp',            inst: 'Leave at ground floor lobby' },
    { tn: 'QDX-2026-0032', name: 'Aarti Phalke',       phone: '+919800100032', addr: 'Kolte Patil 24K, Hinjewadi, Pune',                lat: 18.5930, lng: 73.7420, svc: 'standard', cod: 0,    pkg: 'Small box — earbuds',              inst: '' },
    { tn: 'QDX-2026-0033', name: 'Prasad Bhide',       phone: '+919800100033', addr: 'Paranjpe Schemes, Wakad, Pune',                   lat: 18.6020, lng: 73.7600, svc: 'express',  cod: 7500, pkg: 'Large box — laptop',                inst: 'Recipient ID required' },
    { tn: 'QDX-2026-0034', name: 'Nandini Apte',       phone: '+919800100034', addr: 'Pebbles II Society, Bavdhan, Pune',               lat: 18.5250, lng: 73.7780, svc: 'standard', cod: 850,  pkg: 'Medium parcel — crockery',         inst: 'Gate 2 entry' },
    { tn: 'QDX-2026-0035', name: 'Vivek Marathe',      phone: '+919800100035', addr: 'Amanora Park Town, Hadapsar, Pune',               lat: 18.5120, lng: 73.9340, svc: 'standard', cod: 0,    pkg: 'Envelope — tax documents',         inst: '' },
    { tn: 'QDX-2026-0036', name: 'Rashmi Kamat',       phone: '+919800100036', addr: 'Sobha Dream Acres, Balewadi, Pune',               lat: 18.5710, lng: 73.7650, svc: 'express',  cod: 2800, pkg: 'Medium box — blender',              inst: 'Deliver between 10am–1pm' },
    { tn: 'QDX-2026-0037', name: 'Omkar Divekar',      phone: '+919800100037', addr: 'Pimpri-Chinchwad Link Rd, Wakad, Pune',           lat: 18.6050, lng: 73.7570, svc: 'standard', cod: 0,    pkg: 'Small parcel — vitamins',          inst: '' },
    { tn: 'QDX-2026-0038', name: 'Sonali Godbole',     phone: '+919800100038', addr: 'Oxford Village, Hinjewadi Phase 2, Pune',         lat: 18.5860, lng: 73.7200, svc: 'express',  cod: 4200, pkg: 'Large box — desktop PC',            inst: 'Ground floor only' },
    { tn: 'QDX-2026-0039', name: 'Akash Dhamale',      phone: '+919800100039', addr: 'Fortune Park, Hinjewadi, Pune',                   lat: 18.5940, lng: 73.7400, svc: 'standard', cod: 600,  pkg: 'Small box — perfume',              inst: 'Signature required' },
    { tn: 'QDX-2026-0040', name: 'Jyoti Gavhane',      phone: '+919800100040', addr: 'Lohia Jain, Hinjewadi, Pune',                     lat: 18.5945, lng: 73.7435, svc: 'standard', cod: 0,    pkg: 'Envelope — company badge',         inst: '' },
    { tn: 'QDX-2026-0041', name: 'Dhiraj Nikam',       phone: '+919800100041', addr: 'Cybercity, Magarpatta, Pune',                     lat: 18.5170, lng: 73.9260, svc: 'express',  cod: 1650, pkg: 'Medium box — watch',                inst: 'Call 5 min before' },
    { tn: 'QDX-2026-0042', name: 'Vaishali Shete',     phone: '+919800100042', addr: 'Westend Mall, Aundh, Pune',                       lat: 18.5670, lng: 73.8080, svc: 'standard', cod: 980,  pkg: 'Small box — chocolate box',        inst: '' },
    { tn: 'QDX-2026-0043', name: 'Sunil Karpe',        phone: '+919800100043', addr: 'Bramha Sun City, Wadgaon, Pune',                  lat: 18.5200, lng: 73.7920, svc: 'standard', cod: 0,    pkg: 'Medium parcel — art supplies',     inst: 'Building 7, Ground floor' },
    { tn: 'QDX-2026-0044', name: 'Megha Potdar',       phone: '+919800100044', addr: 'City Point, Dange Chowk, Pune',                   lat: 18.6090, lng: 73.7660, svc: 'express',  cod: 5800, pkg: 'Large box — home gym rack',         inst: 'Heavy item — bring dolly' },
    { tn: 'QDX-2026-0045', name: 'Kunal Bapat',        phone: '+919800100045', addr: 'Sai Park, Hinjewadi Village, Pune',               lat: 18.5925, lng: 73.7395, svc: 'standard', cod: 0,    pkg: 'Envelope — visa application',      inst: 'Urgent — time-sensitive' },
    { tn: 'QDX-2026-0046', name: 'Isha Khadilkar',     phone: '+919800100046', addr: 'Lodha Belmondo, Gahunje, Pune',                   lat: 18.5810, lng: 73.7010, svc: 'express',  cod: 3500, pkg: 'Large parcel — table fan',          inst: 'Deliver to clubhouse' },
    { tn: 'QDX-2026-0047', name: 'Ashwin Lele',        phone: '+919800100047', addr: 'Marvel Fria, Wagholi, Pune',                      lat: 18.5870, lng: 73.9750, svc: 'standard', cod: 420,  pkg: 'Small parcel — protein powder',    inst: '' },
    { tn: 'QDX-2026-0048', name: 'Gauri Pandit',       phone: '+919800100048', addr: 'VTP Bluewaters, Mahalunge, Pune',                 lat: 18.5830, lng: 73.7460, svc: 'standard', cod: 0,    pkg: 'Envelope — medical reports',       inst: 'Leave at reception' },
    { tn: 'QDX-2026-0049', name: 'Nikhil Ranade',      phone: '+919800100049', addr: 'Samarth Nagar, Hinjewadi Rd, Pune',               lat: 18.5935, lng: 73.7360, svc: 'express',  cod: 8900, pkg: 'Large box — smart TV',              inst: 'Very fragile — keep upright' },
    { tn: 'QDX-2026-0050', name: 'Madhura Chitale',    phone: '+919800100050', addr: 'Kohinoor City, Phase 2, Hinjewadi, Pune',         lat: 18.5865, lng: 73.7215, svc: 'standard', cod: 1200, pkg: 'Medium box — apparel',              inst: 'Call on reaching gate' },
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
        hubId: hubHinjewadi.id,
      },
    });
    const codLabel = o.cod > 0 ? `COD ₹${o.cod}` : 'prepaid';
    console.log(`  ✓ ${o.tn} → ${o.name} (${codLabel})`);
    ordersCreated++;
  }

  // ─── Summary ────────────────────────────────────────────────────────
  console.log();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  QuadX Seed Complete!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Zone:    Pune Metro`);
  console.log(`  Hub:     Hinjewadi Hub`);
  console.log(`  Riders:  ${ridersCreated} created`);
  console.log(`  Orders:  ${ordersCreated} created, ${ordersSkipped} skipped`);
  console.log(`  Tracking: QDX-2026-0001 → QDX-2026-0050`);
  console.log(`  All orders created with status: available`);
  console.log();
  console.log('  QuadX Demo Logins:');
  console.log('  ┌──────────────────┬───────────────────┬──────────┐');
  console.log('  │ Rider Name       │ Email             │ Password │');
  console.log('  ├──────────────────┼───────────────────┼──────────┤');
  console.log('  │ Arjun Patil      │ demo@quadx.xyz    │ rider123 │');
  console.log('  │ Sneha Kulkarni   │ rider@quadx.xyz   │ rider123 │');
  console.log('  └──────────────────┴───────────────────┴──────────┘');
  console.log();
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error('QuadX seed failed:', e);
    prisma.$disconnect();
    process.exit(1);
  });
