import {
	Connection,
	Keypair,
	PublicKey,
	Transaction,
	TransactionInstruction,
	VersionedTransaction,
} from '@solana/web3.js';
import {
	BN,
	DriftClient,
	Wallet,
	PerpMarkets,
	type PerpMarketConfig,
	getUserAccountPublicKeySync,
	getUserStatsAccountPublicKey,
	getMarketOrderParams,
	PositionDirection,
	findDirectionToClose,
	calculateEntryPrice,
	calculatePositionPNL,
	QUOTE_PRECISION,
	BASE_PRECISION,
	PRICE_PRECISION,
	FUNDING_RATE_PRECISION,
	convertToNumber,
	type UserAccount,
	type PerpMarketAccount,
	type SpotMarketAccount,
	type PerpPosition,
} from '@drift-labs/sdk';

import { RPC_URL, NETWORK, getServerKeypair } from './env';
import {
	ClosePositionReq,
	IsolatedBalanceReq,
	MarketQueryReq,
	OpenIsolatedReq,
	TransferMarginReq,
	WalletOnlyReq,
} from './types.js';


type DriftTx = Transaction | VersionedTransaction;

const TOKEN_PROGRAM_ID = new PublicKey(
	'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
);
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
	'ATokenGPvotn2u6zdtmovC9wGEPX1YVs4Y3t5u4K2Cw'
);

class ReadonlyWallet {
	public readonly publicKey: PublicKey;

	constructor(publicKey: PublicKey) {
		this.publicKey = publicKey;
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async signTransaction<T extends DriftTx>(tx: T): Promise<T> {
		return tx;
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async signAllTransactions<T extends DriftTx[]>(txs: T): Promise<T> {
		return txs;
	}
}

class AsyncLock {
	private last: Promise<void> = Promise.resolve();

	runExclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.last.then(fn);
		this.last = run.then(
			() => undefined,
			() => undefined
		);
		return run;
	}
}

const connection = new Connection(RPC_URL, 'confirmed');

const serverKeypair = getServerKeypair();
const baseKeypair = serverKeypair ?? Keypair.generate();
const baseWallet = new Wallet(baseKeypair);

const driftClient = new DriftClient({
	connection,
	wallet: baseWallet,
	env: NETWORK,
	skipLoadUsers: true,
});

const walletLock = new AsyncLock();

type MarketMaps = {
	bySymbol: Map<string, PerpMarketConfig>;
	byIndex: Map<number, PerpMarketConfig>;
};

let marketMaps: MarketMaps | null = null;
let initialized = false;

function ensureInitialized() {
	if (!initialized) {
		throw new Error('Drift context not initialized');
	}
}

function normaliseMarketKey(value: string): string {
	return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function buildMarketMaps(): MarketMaps {
	const configs = PerpMarkets[NETWORK];
	const bySymbol = new Map<string, PerpMarketConfig>();
	const byIndex = new Map<number, PerpMarketConfig>();

	for (const cfg of configs) {
		byIndex.set(cfg.marketIndex, cfg);

		const synonyms = new Set<string>([
			cfg.symbol.toUpperCase(),
			normaliseMarketKey(cfg.symbol),
			cfg.baseAssetSymbol.toUpperCase(),
			`${cfg.baseAssetSymbol.toUpperCase()}_PERP`,
			`PERP_${cfg.baseAssetSymbol.toUpperCase()}`,
		]);

		for (const key of synonyms) {
			if (!bySymbol.has(key)) {
				bySymbol.set(key, cfg);
			}
		}
	}

	return { bySymbol, byIndex };
}

function resolveMarketConfig(requested: string): PerpMarketConfig {
	if (!marketMaps) {
		marketMaps = buildMarketMaps();
	}

	const direct = marketMaps.bySymbol.get(normaliseMarketKey(requested));
	if (direct) {
		return direct;
	}

	throw new Error(`Unknown perp market: ${requested}`);
}

async function withAuthority<T>(
	authority: PublicKey,
	fn: () => Promise<T>
): Promise<T> {
	ensureInitialized();
	return walletLock.runExclusive(async () => {
		const originalAuthority = (driftClient as unknown as { authority: PublicKey })
			.authority;
		const originalWallet = driftClient.wallet;
		const originalUserStatsPk = (driftClient as {
			userStatsAccountPublicKey?: PublicKey;
		}).userStatsAccountPublicKey;

		(driftClient as unknown as { authority: PublicKey }).authority = authority;
		(driftClient as { wallet: ReadonlyWallet }).wallet = new ReadonlyWallet(
			authority
		);
		(driftClient as { userStatsAccountPublicKey?: PublicKey }).userStatsAccountPublicKey =
			undefined;

		try {
			return await fn();
		} finally {
			(driftClient as unknown as { authority: PublicKey }).authority =
				originalAuthority;
			(driftClient as { wallet: Wallet }).wallet = originalWallet;
			(driftClient as { userStatsAccountPublicKey?: PublicKey }).userStatsAccountPublicKey =
				originalUserStatsPk;
		}
	});
}

function toQuotePrecision(amount: number): BN {
	return new BN(Math.round(amount * 1e6));
}

function toBasePrecision(amount: number): BN {
	return new BN(Math.round(amount * 1e9));
}

function findAssociatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
	const [ata] = PublicKey.findProgramAddressSync(
		[
			owner.toBuffer(),
			TOKEN_PROGRAM_ID.toBuffer(),
			mint.toBuffer(),
		],
		ASSOCIATED_TOKEN_PROGRAM_ID
	);
	return ata;
}

async function ensureUserInitIxs(
	wallet: PublicKey
): Promise<TransactionInstruction[]> {
	return withAuthority(wallet, async () => {
		const userPk = getUserAccountPublicKeySync(
			driftClient.program.programId,
			wallet,
			0
		);
		const accountInfo = await connection.getAccountInfo(userPk);
		if (accountInfo) {
			return [];
		}
		const [ixs] = await driftClient.getInitializeUserAccountIxs(0);
		return ixs;
	});
}

async function fetchUserAccount(wallet: PublicKey): Promise<UserAccount | null> {
	const userPk = getUserAccountPublicKeySync(
		driftClient.program.programId,
		wallet,
		0
	);
	const account = await driftClient.program.account.user.fetchNullable(userPk);
	return (account as UserAccount | null) ?? null;
}

async function buildTransaction(
	feePayer: PublicKey,
	instructions: TransactionInstruction[]
): Promise<{ txBase64: string }> {
	if (instructions.length === 0) {
		throw new Error('No instructions to build');
	}

	const { blockhash, lastValidBlockHeight } =
		await connection.getLatestBlockhash();

	const tx = new Transaction({
		feePayer,
		recentBlockhash: blockhash,
		lastValidBlockHeight,
	});

	tx.add(...instructions);

	const serialized = tx.serialize({
		requireAllSignatures: false,
		verifySignatures: false,
	});

	return { txBase64: Buffer.from(serialized).toString('base64') };
}

function calcEntryPrice(position: PerpPosition): number | null {
	const priceBn = calculateEntryPrice(position);
	if (priceBn.isZero()) {
		return null;
	}
	return convertToNumber(priceBn, PRICE_PRECISION);
}

function bnAbs(value: BN): BN {
	return value.isNeg() ? value.neg() : value;
}

export async function initDrift(): Promise<void> {
	if (initialized) {
		return;
	}
	await driftClient.subscribe();
	marketMaps = buildMarketMaps();
	initialized = true;
}

export async function buildOpenIsolatedTx(req: OpenIsolatedReq) {
	const walletPk = new PublicKey(req.wallet);
	const marketConfig = resolveMarketConfig(req.market);
	const perpMarket = driftClient.getPerpMarketAccount(
		marketConfig.marketIndex
	) as PerpMarketAccount;
	const spotMarketIndex = perpMarket.quoteSpotMarketIndex;
	const spotMarket = driftClient.getSpotMarketAccount(
		spotMarketIndex
	) as SpotMarketAccount;

	const depositAmount = toQuotePrecision(req.margin);
	const baseAmount = toBasePrecision(Math.abs(req.size));
	const direction = req.size >= 0 ? PositionDirection.LONG : PositionDirection.SHORT;

	const userPk = getUserAccountPublicKeySync(
		driftClient.program.programId,
		walletPk,
		0
	);

	const initIxs = await ensureUserInitIxs(walletPk);
	const userAccount = await fetchUserAccount(walletPk);

	const userStatsPk = getUserStatsAccountPublicKey(
		driftClient.program.programId,
		walletPk
	);

	const userTokenAccount = findAssociatedTokenAddress(
		walletPk,
		spotMarket.mint
	);

	const depositIx = await withAuthority(walletPk, async () => {
		const remainingAccounts = driftClient.getRemainingAccounts({
			userAccounts: userAccount ? [userAccount] : [],
			writableSpotMarketIndexes: [spotMarketIndex],
			readablePerpMarketIndex: marketConfig.marketIndex,
		});

		return driftClient.program.instruction.depositIntoIsolatedPerpPosition(
			spotMarketIndex,
			marketConfig.marketIndex,
			depositAmount,
			{
				accounts: {
					state: await driftClient.getStatePublicKey(),
					spotMarketVault: spotMarket.vault,
					user: userPk,
					userStats: userStatsPk,
					userTokenAccount,
					authority: walletPk,
					tokenProgram: driftClient.getTokenProgramForSpotMarket(spotMarket),
				},
				remainingAccounts,
			}
		);
	});

	const orderIx = await withAuthority(walletPk, async () => {
	const orderParams = getMarketOrderParams({
		marketIndex: marketConfig.marketIndex,
		direction,
		baseAssetAmount: baseAmount,
		reduceOnly: false,
	});

		const remainingAccounts = driftClient.getRemainingAccounts({
			userAccounts: userAccount ? [userAccount] : [],
			readablePerpMarketIndex: marketConfig.marketIndex,
		});

		return driftClient.program.instruction.placePerpOrder(orderParams, {
			accounts: {
				state: await driftClient.getStatePublicKey(),
				user: userPk,
				userStats: userStatsPk,
				authority: walletPk,
			},
			remainingAccounts,
		});
	});

	const oraclePrice = driftClient.getOracleDataForPerpMarket(
		marketConfig.marketIndex
	).price;

	const meta = {
		entryPrice: convertToNumber(oraclePrice, PRICE_PRECISION),
		estLiquidationPrice: null as number | null,
	};

	const { txBase64 } = await buildTransaction(walletPk, [
		...initIxs,
		depositIx,
		orderIx,
	]);

	return { txBase64, meta };
}

export async function buildClosePositionTx(req: ClosePositionReq) {
	const walletPk = new PublicKey(req.wallet);
	const marketConfig = resolveMarketConfig(req.market);
	const userAccount = await fetchUserAccount(walletPk);
	if (!userAccount) {
		throw new Error('User account not found');
	}

	const position = userAccount.perpPositions.find(
		(pos) => pos.marketIndex === marketConfig.marketIndex
	);

	if (!position || position.baseAssetAmount.eq(new BN(0))) {
		throw new Error('No open position to close');
	}

	const direction = findDirectionToClose(position);
	const targetSize =
		req.size !== undefined
			? BN.min(
					toBasePrecision(Math.abs(req.size)),
					bnAbs(position.baseAssetAmount)
			  )
			: bnAbs(position.baseAssetAmount);

	if (targetSize.isZero()) {
		throw new Error('Close size resolves to zero');
	}

	const userPk = getUserAccountPublicKeySync(
		driftClient.program.programId,
		walletPk,
		0
	);
	const userStatsPk = getUserStatsAccountPublicKey(
		driftClient.program.programId,
		walletPk
	);

	const orderIx = await withAuthority(walletPk, async () => {
		const orderParams = getMarketOrderParams({
			marketIndex: marketConfig.marketIndex,
			marketType: { perp: {} },
			direction,
			baseAssetAmount: targetSize,
			reduceOnly: true,
		});

		const remainingAccounts = driftClient.getRemainingAccounts({
			userAccounts: [userAccount],
			readablePerpMarketIndex: marketConfig.marketIndex,
		});

		return driftClient.program.instruction.placePerpOrder(orderParams, {
			accounts: {
				state: await driftClient.getStatePublicKey(),
				user: userPk,
				userStats: userStatsPk,
				authority: walletPk,
			},
			remainingAccounts,
		});
	});

	const { txBase64 } = await buildTransaction(walletPk, [orderIx]);
	return { txBase64 };
}

export async function buildTransferIsolatedMarginTx(req: TransferMarginReq) {
	const walletPk = new PublicKey(req.wallet);
	const marketConfig = resolveMarketConfig(req.market);
	const perpMarket = driftClient.getPerpMarketAccount(
		marketConfig.marketIndex
	) as PerpMarketAccount;
	const spotMarket = driftClient.getSpotMarketAccount(
		perpMarket.quoteSpotMarketIndex
	) as SpotMarketAccount;
	const userPk = getUserAccountPublicKeySync(
		driftClient.program.programId,
		walletPk,
		0
	);
	const userStatsPk = getUserStatsAccountPublicKey(
		driftClient.program.programId,
		walletPk
	);

	const userAccount = await fetchUserAccount(walletPk);

	const amount = toQuotePrecision(Math.abs(req.delta));
	if (amount.isZero()) {
		throw new Error('Delta resolves to zero');
	}

	const initIxs = await ensureUserInitIxs(walletPk);
	const instructions: TransactionInstruction[] = [...initIxs];

	if (req.delta >= 0) {
		const transferIx = await withAuthority(walletPk, async () => {
			const remainingAccounts = driftClient.getRemainingAccounts({
				userAccounts: userAccount ? [userAccount] : [],
				writableSpotMarketIndexes: [perpMarket.quoteSpotMarketIndex],
				readablePerpMarketIndex: marketConfig.marketIndex,
			});
			return driftClient.program.instruction.transferIsolatedPerpPositionDeposit(
				perpMarket.quoteSpotMarketIndex,
				marketConfig.marketIndex,
				amount,
				{
					accounts: {
						state: await driftClient.getStatePublicKey(),
						spotMarketVault: spotMarket.vault,
						user: userPk,
						userStats: userStatsPk,
						authority: walletPk,
					},
					remainingAccounts,
				}
			);
		});
		instructions.push(transferIx);
	} else {
		const withdrawIxs = await withAuthority(walletPk, async () => {
			return driftClient.getWithdrawFromIsolatedPerpPositionIxsBundle(
				amount,
				marketConfig.marketIndex,
				0,
				findAssociatedTokenAddress(walletPk, spotMarket.mint)
			);
		});
		instructions.push(...withdrawIxs);
	}

	const { txBase64 } = await buildTransaction(walletPk, instructions);
	return { txBase64 };
}

export async function getPositions(req: WalletOnlyReq) {
	const walletPk = new PublicKey(req.wallet);
	const userAccount = await fetchUserAccount(walletPk);
	if (!userAccount) {
		return [];
	}

	if (!marketMaps) {
		marketMaps = buildMarketMaps();
	}

	return userAccount.perpPositions
		.filter((pos) => !pos.baseAssetAmount.eq(new BN(0)))
		.map((pos) => {
			const marketCfg = marketMaps?.byIndex.get(pos.marketIndex);
			const oracle = driftClient.getOracleDataForPerpMarket(pos.marketIndex);
			const perpMarket = driftClient.getPerpMarketAccount(
				pos.marketIndex
			) as PerpMarketAccount;
			const pnl = calculatePositionPNL(perpMarket, pos, true, oracle);

			const size = convertToNumber(pos.baseAssetAmount, BASE_PRECISION);
			const entryPrice = calcEntryPrice(pos);
			const leverageDenominator = pos.isolatedPositionScaledBalance ?? new BN(0);
			const notional =
				Math.abs(size) * convertToNumber(oracle.price, PRICE_PRECISION);
			const margin = convertToNumber(leverageDenominator, QUOTE_PRECISION);
			const leverage =
				margin > 0 ? Number((notional / margin).toFixed(4)) : null;

			return {
				market: marketCfg?.symbol ?? `MARKET_${pos.marketIndex}`,
				size,
				entryPrice,
				liqPrice: null as number | null,
				leverage,
				unrealizedPnl: convertToNumber(pnl, QUOTE_PRECISION),
			};
		});
}

export async function getTrades(_req: WalletOnlyReq) {
	return [];
}

export async function getMarket(req: MarketQueryReq) {
	const marketCfg = resolveMarketConfig(req.symbol);
	const oracle = driftClient.getOracleDataForPerpMarket(marketCfg.marketIndex);
	const perpMarket = driftClient.getPerpMarketAccount(
		marketCfg.marketIndex
	) as PerpMarketAccount;

	const price = convertToNumber(oracle.price, PRICE_PRECISION);
	const mark = convertToNumber(perpMarket.amm.lastMarkPriceTwap, PRICE_PRECISION);
	const funding = convertToNumber(perpMarket.amm.lastFundingRate, FUNDING_RATE_PRECISION);

	return {
		symbol: marketCfg.symbol,
		price,
		mark,
		funding,
	};
}

export async function getIsolatedBalance(req: IsolatedBalanceReq) {
	const walletPk = new PublicKey(req.wallet);
	const marketCfg = resolveMarketConfig(req.market);

	const amount = await withAuthority(walletPk, async () => {
		return driftClient.getIsolatedPerpPositionTokenAmount(
			marketCfg.marketIndex
		);
	});

	return {
		market: marketCfg.symbol,
		tokenAmount: convertToNumber(amount, QUOTE_PRECISION),
	};
}
