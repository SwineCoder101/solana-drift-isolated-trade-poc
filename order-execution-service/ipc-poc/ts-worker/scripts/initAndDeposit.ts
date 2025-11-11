#!/usr/bin/env ts-node

import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '..', '..', '..', '.env');
dotenv.config({ path: envPath });

import { RPC_URL } from '../src/env.js';
import { initDrift, buildInitializeAndDepositIsolatedTx } from '../src/drift.js';

function parseArgs() {
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

	return {
		wallet,
		market: args.market ?? 'PERP_SOL',
		amount: Number(args.amount ?? '1'),
	};
}

function loadKeypair(expectedPubkey: string): Keypair {
	const raw = process.env.WALLET_PRIVATE_KEY?.trim() || process.env.SERVER_PRIVATE_KEY?.trim();
	if (!raw) {
		throw new Error('Set WALLET_PRIVATE_KEY or SERVER_PRIVATE_KEY in .env file (base58 or comma-separated bytes)');
	}

	let secret: Uint8Array;
	if (raw.startsWith('[')) {
		secret = Uint8Array.from(JSON.parse(raw));
	} else if (raw.includes(',')) {
		secret = Uint8Array.from(raw.split(',').map((v) => Number(v.trim())));
	} else {
		secret = bs58.decode(raw);
	}

	const kp = Keypair.fromSecretKey(secret);
	if (kp.publicKey.toBase58() !== expectedPubkey) {
		throw new Error('Provided private key does not match --wallet pubkey');
	}
	return kp;
}

async function main() {
	const args = parseArgs();
	const keypair = loadKeypair(args.wallet);

	await initDrift();
	const { txBase64 } = await buildInitializeAndDepositIsolatedTx({
		wallet: args.wallet,
		market: args.market,
		amount: args.amount,
	});

	const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));
	tx.sign([keypair]);

	const connection = new Connection(RPC_URL, 'confirmed');
	const signature = await connection.sendTransaction(tx, { skipPreflight: false });
	console.log('Submitted transaction', signature);
	console.log(`Initialized account (if needed) and deposited ${args.amount} to ${args.market}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
