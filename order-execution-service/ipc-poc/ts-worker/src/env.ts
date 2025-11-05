import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_ENV_PATH = path.resolve(__dirname, '..', '..', '..', '.env');
const ENV_PATH = process.env.TS_WORKER_ENV_PATH ?? DEFAULT_ENV_PATH;

dotenv.config({ path: ENV_PATH });

export const RPC_URL =
	process.env.RPC_URL?.trim() || 'https://api.devnet.solana.com';

export const NETWORK = 'devnet' as const;

export const SERVER_KEYPAIR_PATH = process.env.SERVER_KEYPAIR_PATH?.trim();
const SERVER_PRIVATE_KEY = process.env.SERVER_PRIVATE_KEY?.trim();

function parseSecretKey(raw: string): Keypair {
	const trimmed = raw.trim();
	if (!trimmed) {
		throw new Error('Empty secret key');
	}

	// Try JSON array
	if (trimmed.startsWith('[')) {
		const bytes = JSON.parse(trimmed) as number[];
		return Keypair.fromSecretKey(Uint8Array.from(bytes));
	}

	// Try CSV numbers
	if (trimmed.includes(',')) {
		const parts = trimmed.split(',').map((value) => Number(value.trim()));
		return Keypair.fromSecretKey(Uint8Array.from(parts));
	}

	// Try base58 / base64
	try {
		const decoded = bs58.decode(trimmed);
		if (decoded.length > 0) {
			return Keypair.fromSecretKey(decoded);
		}
	} catch {
		// fallthrough
	}

	const buff = Buffer.from(trimmed, 'base64');
	if (buff.length > 0) {
		return Keypair.fromSecretKey(buff);
	}

	throw new Error('Unsupported secret key format');
}

export function getServerKeypair(): Keypair | null {
	if (SERVER_PRIVATE_KEY) {
		try {
			return parseSecretKey(SERVER_PRIVATE_KEY);
		} catch (err) {
			throw new Error(
				`Failed to parse SERVER_PRIVATE_KEY: ${
					err instanceof Error ? err.message : String(err)
				}`
			);
		}
	}

	if (SERVER_KEYPAIR_PATH) {
		try {
			const fileContent = fs.readFileSync(SERVER_KEYPAIR_PATH, 'utf8');
			return parseSecretKey(fileContent);
		} catch (err) {
			throw new Error(
				`Failed to read SERVER_KEYPAIR_PATH: ${
					err instanceof Error ? err.message : String(err)
				}`
			);
		}
	}

	return null;
}
