#!/usr/bin/env ts-node

import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env file from order-execution-service directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '..', '..', '..', '.env');
dotenv.config({ path: envPath });

import { RPC_URL, getServerKeypair } from '../src/env.js';
import { BN, DriftClient, OrderType, PerpMarkets, PositionDirection, Wallet, getUserAccountPublicKeySync } from '@drift-labs/sdk';

async function main() {

    const serverKeypair = getServerKeypair();

    if (!serverKeypair) {
        throw new Error('Server keypair not found');
    }

    const connection = new Connection(RPC_URL, 'confirmed');
    const baseWallet = new Wallet(serverKeypair);

    const marketIndex = 0;

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

    console.log('Drift User Account: ', driftUserAccount.toBase58());
    console.log('Server Account: ', serverKeypair.publicKey.toBase58());

    await driftClient.addUser(0, serverKeypair.publicKey);
    await driftClient.subscribe();

    let userAccount = await driftClient.getUserAccount(0, serverKeypair.publicKey);
    const usdcTokenMint = new PublicKey('8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2');
    const associatedTokenAccount = await driftClient.getAssociatedTokenAccount(
        0
    );

    console.log('associatedTokenAccount: ', associatedTokenAccount.toBase58());


    const beforeDepositIsolatedPositionAmount = await driftClient.getIsolatedPerpPositionTokenAmount(
        marketIndex,0
    )

    // const depositSignature = await driftClient.depositIntoIsolatedPerpPosition(
    //     toQuotePrecision(30),
    //     marketIndex,
    //     associatedTokenAccount,
    // );


    //------------------------------------------------------------------------------------------------
    // Place a market order
    //------------------------------------------------------------------------------------------------

    // const orderSignature = await driftClient.placePerpOrder(
    //     {
    //         marketIndex: 0,
    //         direction: PositionDirection.LONG,
    //         baseAssetAmount: toBasePrecision(10, 6),
    //         orderType: OrderType.MARKET,
    //     }
    // );

    // const order = await driftClient.getOrderByUserId(0);
    // console.log('Order: ', JSON.stringify(order, null, 2));
    // const withdrawSignature = await driftClient.withdrawFromIsolatedPerpPosition(
    //     toQuotePrecision(1),
    //     0,
    //     associatedTokenAccount,
    //     0,
    // );

    const transferCrossMarginSignature = await driftClient.transferIsolatedPerpPositionDeposit(
        toQuotePrecision(5),
        marketIndex,
    );

    const isolatedPositionAmount = await driftClient.getIsolatedPerpPositionTokenAmount(
        marketIndex,0
    )

    userAccount  = await driftClient.getUserAccount(0, serverKeypair.publicKey);

    // console.log('Order Signature: ', orderSignature);
    console.log('Before Deposit Isolated Position Amount: ', toReadableAmount(beforeDepositIsolatedPositionAmount));
    console.log('Isolated Position Amount: ', toReadableAmount(isolatedPositionAmount));
    console.log('Transfer Cross Margin Signature: ', transferCrossMarginSignature);
    // console.log('number of positions: ', userAccount?.perpPositions.length);
    // console.log('Withdraw Signature: ', withdrawSignature);
    // console.log('Deposit Signature: ', depositSignature);

}

function toBasePrecision(amount: number, precision: number) {
    return new BN(amount * 10 ** precision);
}

function toQuotePrecision(amount: number) {
    return new BN(amount * 10 ** 6);
}

function toReadableAmount(amount: BN) {
    return amount.div(new BN(10 ** 6)).toNumber();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

