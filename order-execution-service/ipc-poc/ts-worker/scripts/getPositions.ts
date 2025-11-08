#!/usr/bin/env ts-node

import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env file from order-execution-service directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '..', '..', '..', '.env');
dotenv.config({ path: envPath });

import { initDrift, getPositions } from '../src/drift.js';

type CliArgs = {
	wallet: string;
};

function parseArgs(): CliArgs {
	const [, , ...rest] = process.argv;
	const args: Record<string, string> = {};
	for (let i = 0; i < rest.length; i += 2) {
		const key = rest[i];
		const value = rest[i + 1];
		if (!key?.startsWith('--') || value === undefined) {
			throw new Error(`Invalid arguments. Expected "--key value" pairs, got ${key} ${value ?? ''}`);
		}
		args[key.replace(/^--/, '')] = value;
	}

	const wallet = args.wallet;
	if (!wallet) throw new Error('Missing --wallet <PUBKEY>');

	return { wallet };
}

async function main() {
	const args = parseArgs();

	await initDrift();
	const positions = await getPositions({
		wallet: args.wallet,
	});

	if (positions.length === 0) {
		console.log('No open positions found');
		return;
	}

	console.log(`Found ${positions.length} open position(s):\n`);
	positions.forEach((pos, index) => {
		console.log(`Position ${index + 1}:`);
		console.log(`  Market: ${pos.market}`);
		console.log(`  Size: ${pos.size}`);
		console.log(`  Entry Price: ${pos.entryPrice ?? 'N/A'}`);
		console.log(`  Leverage: ${pos.leverage ?? 'N/A'}`);
		console.log(`  Unrealized PnL: ${pos.unrealizedPnl}`);
		console.log(`  Liquidation Price: ${pos.liqPrice ?? 'N/A'}`);
		console.log('');
	});
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

