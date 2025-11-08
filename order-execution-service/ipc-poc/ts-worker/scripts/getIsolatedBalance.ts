#!/usr/bin/env ts-node

import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env file from order-execution-service directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '..', '..', '..', '.env');
dotenv.config({ path: envPath });

import { initDrift, getIsolatedBalance } from '../src/drift.js';

type CliArgs = {
	wallet: string;
	market: string;
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

	const market = args.market;
	if (!market) throw new Error('Missing --market <MARKET_SYMBOL>');

	return { wallet, market };
}

async function main() {
	const args = parseArgs();

	await initDrift();
	const balance = await getIsolatedBalance({
		wallet: args.wallet,
		market: args.market,
	});

	console.log('Isolated Balance:');
	console.log(`  Market: ${balance.market}`);
	console.log(`  Token Amount: ${balance.tokenAmount}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

