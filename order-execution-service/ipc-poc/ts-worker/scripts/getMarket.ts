#!/usr/bin/env ts-node

import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env file from order-execution-service directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '..', '..', '..', '.env');
dotenv.config({ path: envPath });

import { initDrift, getMarket } from '../src/drift.js';

type CliArgs = {
	symbol: string;
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

	const symbol = args.symbol;
	if (!symbol) throw new Error('Missing --symbol <MARKET_SYMBOL>');

	return { symbol };
}

async function main() {
	const args = parseArgs();

	await initDrift();
	const market = await getMarket({
		symbol: args.symbol,
	});

	console.log('Market Information:');
	console.log(`  Symbol: ${market.symbol}`);
	console.log(`  Price: ${market.price}`);
	console.log(`  Mark Price: ${market.mark}`);
	console.log(`  Funding Rate: ${market.funding}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

