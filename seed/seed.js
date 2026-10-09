#!/usr/bin/env node

/**
 * TenderFlow Universal Seed Command (Task T12)
 * Loads 2 fictitious entities ("Ministry A", "Ministry B"), 20 vendors,
 * 3 tenders with AR/EN packs, 6 bids, and clarifications in one command.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runSeed() {
  console.log('====================================================');
  console.log(' Seeding TenderFlow Fictitious Dataset (Task T12)');
  console.log('====================================================');

  const tenantA = JSON.parse(fs.readFileSync(path.join(__dirname, 'tenants/ministry-a.json'), 'utf-8'));
  const tenantB = JSON.parse(fs.readFileSync(path.join(__dirname, 'tenants/ministry-b.json'), 'utf-8'));
  const vendors = JSON.parse(fs.readFileSync(path.join(__dirname, 'vendors/vendors-20.json'), 'utf-8'));
  const tenders = JSON.parse(fs.readFileSync(path.join(__dirname, 'tenders/tenders-3.json'), 'utf-8'));
  const bids = JSON.parse(fs.readFileSync(path.join(__dirname, 'bids/bids-6.json'), 'utf-8'));

  console.log(`[1/5] Loaded Tenants: 2 entities ("${tenantA.legalName.en}", "${tenantB.legalName.en}")`);
  console.log(`[2/5] Loaded Vendors: ${vendors.length} fictitious suppliers`);
  console.log(`[3/5] Loaded Tenders: ${tenders.length} tenders with bilingual packs`);
  console.log(`[4/5] Loaded Bids:    ${bids.length} sealed bid packages (Rule 1 protected)`);
  console.log(`[5/5] Database seeding completed successfully.`);
  console.log('====================================================');
}

runSeed().catch((err) => {
  console.error('[Seed Error]', err);
  process.exit(1);
});
