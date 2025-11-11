#!/usr/bin/env ts-node

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '..', '..', '..', '.env');
dotenv.config({ path: envPath });

import { RPC_URL, getServerKeypair } from '../src/env.js';
import {
	DriftClient,
	PositionDirection,
	OrderType,
	Wallet,
	getUserAccountPublicKeySync,
} from '@drift-labs/sdk';

function toBasePrecision(amount: number, precision: number) {
	return BigInt(Math.round(amount * 10 ** precision));
}

async function main() {
	const serverKeypair = getServerKeypair();
	if (!serverKeypair) {
		throw new Error('Server keypair not found');
	}

	const connection = new Connection(RPC_URL, 'confirmed');
	const baseWallet = new Wallet(serverKeypair);

	const driftClient = new DriftClient({
		connection,
		wallet: baseWallet,
		env: 'devnet',
		skipLoadUsers: true,
	});

	const driftUserAccount = getUserAccountPublicKeySync(
		driftClient.program.programId,
		serverKeypair.publicKey,
		0,
	);

	console.log('Drift User Account:', driftUserAccount.toBase58());
	console.log('Server Account:', serverKeypair.publicKey.toBase58());

	await driftClient.addUser(0, serverKeypair.publicKey);
	await driftClient.subscribe();

	const usdcTokenMint = new PublicKey('8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2');
	const associatedTokenAccount = await driftClient.getAssociatedTokenAccount(0);
	console.log('associatedTokenAccount:', associatedTokenAccount.toBase58());

	const orderSignature = await driftClient.placePerpOrder({
		marketIndex: 0,
		direction: PositionDirection.LONG,
		baseAssetAmount: toBasePrecision(10, 6),
		orderType: OrderType.MARKET,
	});

	console.log('Order Signature:', orderSignature);
	const isolatedAmount = await driftClient.getIsolatedPerpPositionTokenAmount(0, 0);
	console.log('Isolated Position Amount:', Number(isolatedAmount) / 1e6, 'USDC');

	await driftClient.unsubscribe();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
