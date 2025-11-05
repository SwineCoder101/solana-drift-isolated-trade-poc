#!/usr/bin/env ts-node

import { DriftClient } from '@drift-labs/sdk';

async function main() {
  console.log('Order execution service bootstrapped');
  console.log('Drift SDK version:', DriftClient.packageVersion);
}

main().catch((err) => {
  console.error('Fatal error in order execution service', err);
  process.exit(1);
});
