import {
	Connection,
	Keypair,
	PublicKey,
	Transaction,
	TransactionInstruction,
	VersionedTransaction,
	type TransactionVersion,
	ParsedAccountData,
} from '@solana/web3.js';
import {
	ASSOCIATED_TOKEN_PROGRAM_ID as SPL_ASSOCIATED_TOKEN_PROGRAM_ID,
	TOKEN_PROGRAM_ID as SPL_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
	BN,
	DriftClient,
	Wallet,
	PerpMarkets,
	SpotMarkets,
	User,
	OneShotUserAccountSubscriber,
	type PerpMarketConfig,
	type SpotMarketConfig,
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
	ZERO,
	convertToNumber,
	WRAPPED_SOL_MINT,
	isVariant,
	type UserAccount,
	type PerpMarketAccount,
	type SpotMarketAccount,
	type PerpPosition,
	type IWallet,
} from '@drift-labs/sdk';

import { RPC_URL, NETWORK, getServerKeypair } from './env.js';
import bs58 from 'bs58';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
	ClosePositionReq,
	IsolatedBalanceReq,
	MarketQueryReq,
	OpenIsolatedReq,
	TransferMarginReq,
	WalletOnlyReq,
	DepositNativeReq,
	DepositTokenReq,
	DepositIsolatedReq,
} from './types.js';
import { debugLog, printPayload } from './logger.js';


type DriftTx = Transaction | VersionedTransaction;

const TOKEN_PROGRAM_ID = SPL_TOKEN_PROGRAM_ID;
const ASSOCIATED_TOKEN_PROGRAM_ID = SPL_ASSOCIATED_TOKEN_PROGRAM_ID;

class ReadonlyWallet {
	public readonly publicKey: PublicKey;
	public readonly supportedTransactionVersions: ReadonlySet<TransactionVersion> | null =
		new Set<TransactionVersion>([0, 'legacy']);
	public readonly payer: Keypair | undefined = undefined;

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

	// eslint-disable-next-line @typescript-eslint/require-await
	async signVersionedTransaction(tx: VersionedTransaction): Promise<VersionedTransaction> {
		return tx;
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async signAllVersionedTransactions<T extends VersionedTransaction[]>(
		txs: T
	): Promise<T> {
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

type SpotMarketMaps = {
	bySymbol: Map<string, SpotMarketConfig>;
	byIndex: Map<number, SpotMarketConfig>;
	byMint: Map<string, SpotMarketConfig>;
};

let marketMaps: MarketMaps | null = null;
let spotMarketMaps: SpotMarketMaps | null = null;

type TokenBalanceEntry = {
	symbol: string;
	mint: string;
	balance: number;
};

type AccountBalanceSummary = {
	address: string;
	sol_balance: number;
	tokens: TokenBalanceEntry[];
};
let initialized = false;

function ensureInitialized() {
	if (!initialized) {
		throw new Error('Drift context not initialized');
	}
}

function normaliseMarketKey(value: string): string {
	return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function logInstruction(label: string, wallet: PublicKey, mint: PublicKey) {
	debugLog('instruction', {
		label,
		wallet: wallet.toBase58(),
		mint: mint.toBase58(),
	});
}

async function ensureDriftUserCached(
	wallet: PublicKey,
	userAccount?: UserAccount | null
) {
	await withAuthority(wallet, async () => {
		if (!driftClient.hasUser(0, wallet)) {
			// If user account doesn't exist, we still need to add it (even if null)
			// so the client knows about the user. If userAccount is null, addUser
			// will handle it appropriately.
			if (userAccount) {
				await driftClient.addUser(0, wallet, userAccount);
			} else {
				// User account doesn't exist yet, but we still need to register the user
				// so methods like getIsolatedPerpPositionTokenAmount work
				// We'll fetch it fresh or let it be initialized
				const fetched = await fetchUserAccount(wallet);
				if (fetched) {
					await driftClient.addUser(0, wallet, fetched);
				}
			}
		} else if (userAccount) {
			// User already exists, update it with fresh data
			await driftClient.addUser(0, wallet, userAccount);
		}
	});
}

function buildMarketMaps(): MarketMaps {
	const envKey = NETWORK as keyof typeof PerpMarkets;
	const configs = PerpMarkets[envKey] ?? [];
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

function buildSpotMarketMaps(): SpotMarketMaps {
	const envKey = NETWORK as keyof typeof SpotMarkets;
	const configs = SpotMarkets[envKey] ?? [];
	const bySymbol = new Map<string, SpotMarketConfig>();
	const byIndex = new Map<number, SpotMarketConfig>();
	const byMint = new Map<string, SpotMarketConfig>();
	for (const cfg of configs) {
		byIndex.set(cfg.marketIndex, cfg);
		byMint.set(cfg.mint.toBase58(), cfg);
		const synonyms = new Set<string>([
			cfg.symbol.toUpperCase(),
			normaliseMarketKey(cfg.symbol),
		]);
		for (const key of synonyms) {
			if (!bySymbol.has(key)) {
				bySymbol.set(key, cfg);
			}
		}
	}
	return { bySymbol, byIndex, byMint };
}

function ensureSpotMarkets() {
	if (!spotMarketMaps) {
		spotMarketMaps = buildSpotMarketMaps();
	}
}

function getSpotSymbolByMint(mint: PublicKey): string {
	ensureSpotMarkets();
	const mintKey = mint.toBase58();
	const cfg = spotMarketMaps?.byMint.get(mintKey);
	return cfg?.symbol ?? mintKey.slice(0, 6);
}

function toTokenAmount(amount: number, decimals: number): BN {
	const factor = Math.pow(10, decimals);
	return new BN(Math.round(amount * factor));
}

function deriveAta(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
	return PublicKey.findProgramAddressSync(
		[owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
		ASSOCIATED_TOKEN_PROGRAM_ID
	)[0];
}

function createCloseAccountIx(
	account: PublicKey,
	destination: PublicKey,
	authority: PublicKey,
	tokenProgram: PublicKey = TOKEN_PROGRAM_ID
): TransactionInstruction {
	return new TransactionInstruction({
		programId: tokenProgram,
		keys: [
			{ pubkey: account, isSigner: false, isWritable: true },
			{ pubkey: destination, isSigner: false, isWritable: true },
			{ pubkey: authority, isSigner: true, isWritable: false },
		],
		data: Buffer.from([9]),
	});
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

function resolveSpotMarketConfig(requested?: string): SpotMarketConfig {
	if (!spotMarketMaps) {
		spotMarketMaps = buildSpotMarketMaps();
	}
	const key = requested ? normaliseMarketKey(requested) : 'SOL';
	const cfg = spotMarketMaps.bySymbol.get(key);
	if (cfg) {
		return cfg;
	}
	throw new Error(`Unknown spot market: ${requested ?? 'SOL'}`);
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
		(
			driftClient as unknown as { wallet: IWallet }
		).wallet = new ReadonlyWallet(authority);
		(driftClient as { userStatsAccountPublicKey?: PublicKey }).userStatsAccountPublicKey =
			undefined;

		try {
			return await fn();
		} finally {
			(driftClient as unknown as { authority: PublicKey }).authority =
				originalAuthority;
			(driftClient as unknown as { wallet: IWallet }).wallet = originalWallet;
			(driftClient as { userStatsAccountPublicKey?: PublicKey }).userStatsAccountPublicKey =
				originalUserStatsPk;
		}
	});
}

function toQuotePrecision(amount: number): BN {
	return new BN(Math.round(amount * 1e6));
}

function toBasePrecision(amount: number, precision: BN): BN {
	const scale = precision.toNumber();
	return new BN(Math.round(amount * scale));
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

async function fetchTokenBalancesForOwner(owner: PublicKey): Promise<TokenBalanceEntry[]> {
	const programIds = [TOKEN_PROGRAM_ID];
	const aggregates = new Map<string, { balance: number; symbol: string }>();

	for (const programId of programIds) {
		try {
			const response = await connection.getParsedTokenAccountsByOwner(owner, { programId });
			for (const { account } of response.value) {
				const parsed = account.data as ParsedAccountData;
				const info = (parsed?.parsed as any)?.info;
				const tokenAmount = info?.tokenAmount;
				const uiAmount = Number(tokenAmount?.uiAmount ?? tokenAmount?.uiAmountString ?? 0);
				if (!uiAmount) continue;
				const mint = info?.mint as string;
				const symbol = getSpotSymbolByMint(new PublicKey(mint));
				const current = aggregates.get(mint) ?? { balance: 0, symbol };
				current.balance += uiAmount;
				aggregates.set(mint, current);
			}
		} catch (err) {
		debugLog('token balance fetch failed', err);
		}
	}

	return Array.from(aggregates.entries()).map(([mint, data]) => ({
		mint,
		symbol: data.symbol,
		balance: data.balance,
	}));
}

function getDriftTokenBalancesFromUser(user: User, userAccount: UserAccount): TokenBalanceEntry[] {
	const aggregates = new Map<string, { balance: number; symbol: string }>();
	for (const spotPosition of userAccount.spotPositions) {
		if (!spotPosition || spotPosition.scaledBalance.eq(ZERO)) continue;
		const tokenAmount = user.getTokenAmount(spotPosition.marketIndex);
		if (tokenAmount.eq(ZERO)) continue;
		const spotMarket = driftClient.getSpotMarketAccount(spotPosition.marketIndex) as SpotMarketAccount;
		const decimals = Number(spotMarket.decimals ?? 6);
		const precision = new BN(10).pow(new BN(decimals));
		const amount = convertToNumber(tokenAmount, precision);
		if (!amount) continue;
		const mint = spotMarket.mint.toBase58();
		const symbol = getSpotSymbolByMint(spotMarket.mint);
		const current = aggregates.get(mint) ?? { balance: 0, symbol };
		current.balance += amount;
		aggregates.set(mint, current);
	}
	return Array.from(aggregates.entries())
		.filter(([, data]) => Math.abs(data.balance) > 0)
		.map(([mint, data]) => ({
			mint,
			symbol: data.symbol,
			balance: data.balance,
		}));
}

async function buildAccountSummary(owner: PublicKey): Promise<AccountBalanceSummary> {
	const lamports = await connection.getBalance(owner, 'confirmed').catch(() => 0);
	const tokens = await fetchTokenBalancesForOwner(owner);
	return {
		address: owner.toBase58(),
		sol_balance: lamports / LAMPORTS_PER_SOL,
		tokens,
	};
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

type BuiltTx = {
	txBase64: string;
	signatures: string[];
};

async function buildTransaction(
	feePayer: PublicKey,
	instructions: TransactionInstruction[]
): Promise<BuiltTx> {
	if (instructions.length === 0) {
		throw new Error('No instructions to build');
	}

	const { blockhash, lastValidBlockHeight } =
		await connection.getLatestBlockhash();

	const tx = new Transaction({ feePayer });
	tx.recentBlockhash = blockhash;
	(tx as Partial<Transaction> & { lastValidBlockHeight?: number }).lastValidBlockHeight =
		lastValidBlockHeight;
	tx.add(...instructions);

	const serialized = tx.serialize({
		requireAllSignatures: false,
		verifySignatures: false,
	});

	const signatures = tx.signatures.map(({ signature }) => {
		const bytes = signature ?? new Uint8Array(64);
		return bs58.encode(bytes);
	});

	return { txBase64: Buffer.from(serialized).toString('base64'), signatures };
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
	const amm = perpMarket.amm as unknown as { basePrecision?: BN };
	const basePrecision = amm.basePrecision ?? BASE_PRECISION;

	const depositAmount = toQuotePrecision(req.margin);
	const baseAmount = toBasePrecision(Math.abs(req.size), basePrecision);
	const direction = req.size >= 0 ? PositionDirection.LONG : PositionDirection.SHORT;

	const userPk = getUserAccountPublicKeySync(
		driftClient.program.programId,
		walletPk,
		0
	);

	const initIxs = await ensureUserInitIxs(walletPk) as TransactionInstruction[];
	const userAccount = await fetchUserAccount(walletPk);
	await ensureDriftUserCached(walletPk, userAccount);

	debugLog('open isolated userAccount', userAccount);
	debugLog('open isolated userPk', userPk.toBase58());
	debugLog('open isolated walletPk', walletPk.toBase58());
	debugLog('open isolated marketConfig', marketConfig.symbol);
	debugLog('open isolated perpMarket index', perpMarket.marketIndex);
	debugLog('open isolated spotMarket index', spotMarket.marketIndex);
	debugLog('open isolated spotMarketIndex', spotMarketIndex);
	debugLog('open isolated depositAmount', depositAmount.toString());
	debugLog('open isolated baseAmount', baseAmount.toString());

	const userStatsPk = getUserStatsAccountPublicKey(
		driftClient.program.programId,
		walletPk
	);

	debugLog('open isolated walletPk', walletPk.toBase58());
	debugLog('open isolated mint', spotMarket.mint.toBase58());
	
	const tokenProgram = driftClient.getTokenProgramForSpotMarket(spotMarket);
	const userTokenAccount = await driftClient.getAssociatedTokenAccount(
		spotMarketIndex,
		false,
		tokenProgram,
		walletPk
	);

	debugLog('open isolated userTokenAccount', userTokenAccount.toBase58());

	const userTokenAccountInfo = await connection.getAccountInfo(userTokenAccount);
	const ensureTokenAccountIx =
		userTokenAccountInfo === null
			? driftClient.createAssociatedTokenAccountIdempotentInstruction(
					userTokenAccount,
					walletPk,
					walletPk,
					spotMarket.mint,
					tokenProgram
			  )
			: null;

	const depositIx = await withAuthority(walletPk, async () => {
		logInstruction(
			'depositIntoIsolatedPerpPosition',
			walletPk,
			spotMarket.mint
		);
		return driftClient.getDepositIntoIsolatedPerpPositionIx(
			depositAmount,
			marketConfig.marketIndex,
			userTokenAccount
		);
	});

	const orderIx = await withAuthority(walletPk, async () => {
		const orderParams = getMarketOrderParams({
			marketIndex: marketConfig.marketIndex,
			direction,
			baseAssetAmount: baseAmount,
			reduceOnly: false,
		});
		return driftClient.getPlacePerpOrderIx(orderParams);
	});

	const oraclePrice = driftClient.getOracleDataForPerpMarket(
		marketConfig.marketIndex
	).price;

	const meta = {
		entryPrice: convertToNumber(oraclePrice, PRICE_PRECISION),
		estLiquidationPrice: null as number | null,
	};

	const { txBase64, signatures } = await buildTransaction(walletPk, [
		...initIxs,
		...(ensureTokenAccountIx ? [ensureTokenAccountIx] : []),
		depositIx,
		orderIx,
	]);

	return { txBase64, signatures, meta };
}

export async function buildInitializeAndDepositIsolatedTx(req: DepositIsolatedReq) {
	const walletPk = new PublicKey(req.wallet);
	const marketConfig = resolveMarketConfig(req.market);
	const perpMarket = driftClient.getPerpMarketAccount(
		marketConfig.marketIndex
	) as PerpMarketAccount;
	const spotMarketIndex = perpMarket.quoteSpotMarketIndex;
	const spotMarket = driftClient.getSpotMarketAccount(
		spotMarketIndex
	) as SpotMarketAccount;

	const depositAmount = toQuotePrecision(req.amount);

	const initIxs = (await ensureUserInitIxs(walletPk)) as TransactionInstruction[];
	const userAccount = await fetchUserAccount(walletPk);
	await ensureDriftUserCached(walletPk, userAccount);

	const userStatsPk = getUserStatsAccountPublicKey(
		driftClient.program.programId,
		walletPk
	);

	const tokenProgram = driftClient.getTokenProgramForSpotMarket(spotMarket);
	const userTokenAccount = await driftClient.getAssociatedTokenAccount(
		spotMarketIndex,
		false,
		tokenProgram,
		walletPk
	);

	const userTokenAccountInfo = await connection.getAccountInfo(userTokenAccount);
	const ensureTokenAccountIx =
		userTokenAccountInfo === null
			? driftClient.createAssociatedTokenAccountIdempotentInstruction(
					userTokenAccount,
					walletPk,
					walletPk,
					spotMarket.mint,
					tokenProgram
			  )
			: null;

	const depositIx = await withAuthority(walletPk, async () => {
		logInstruction('depositIntoIsolatedPerpPosition', walletPk, spotMarket.mint);
		return driftClient.getDepositIntoIsolatedPerpPositionIx(
			depositAmount,
			marketConfig.marketIndex,
			userTokenAccount
		);
	});

	const { txBase64, signatures } = await buildTransaction(walletPk, [
		...initIxs,
		...(ensureTokenAccountIx ? [ensureTokenAccountIx] : []),
		depositIx,
	]);

	return { txBase64, signatures };
}

export async function buildClosePositionTx(req: ClosePositionReq) {
	const walletPk = new PublicKey(req.wallet);
	const marketConfig = resolveMarketConfig(req.market);
	const userAccount = await fetchUserAccount(walletPk);
	if (!userAccount) {
		throw new Error('User account not found');
	}
	const perpMarket = driftClient.getPerpMarketAccount(
		marketConfig.marketIndex
	) as PerpMarketAccount;
	const amm = perpMarket.amm as unknown as { basePrecision?: BN };
	const basePrecision = amm.basePrecision ?? BASE_PRECISION;

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
				toBasePrecision(Math.abs(req.size), basePrecision),
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
		return driftClient.getPlacePerpOrderIx(orderParams);
	});

	const { txBase64, signatures } = await buildTransaction(walletPk, [orderIx]);
	return { txBase64, signatures };
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
			return driftClient.getTransferIsolatedPerpPositionDepositIx(
				amount,
				marketConfig.marketIndex
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

	const { txBase64, signatures } = await buildTransaction(walletPk, instructions);
	return { txBase64, signatures };
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
			const isolatedMargin = convertToNumber(
				driftClient.getIsolatedPerpPositionTokenAmount(pos.marketIndex) ?? ZERO,
				QUOTE_PRECISION
			);

			return {
				market: marketCfg?.symbol ?? `MARKET_${pos.marketIndex}`,
				size,
				entryPrice,
				liqPrice: null as number | null,
				leverage,
				unrealizedPnl: convertToNumber(pnl, QUOTE_PRECISION),
				isolatedMargin,
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
	
	// Fetch and cache user account before accessing it
	const userAccount = await fetchUserAccount(walletPk);
	await ensureDriftUserCached(walletPk, userAccount);

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

export function getServerPublicKey(): string {
	return baseWallet.publicKey.toBase58();
}

export async function buildDepositNativeSolTx(req: DepositNativeReq) {
	if (!Number.isFinite(req.amount) || req.amount <= 0) {
		throw new Error('amount must be positive');
	}
	const walletPk = new PublicKey(req.wallet);
	const spotConfig = resolveSpotMarketConfig(req.market ?? 'SOL');
	const lamports = new BN(Math.round(req.amount * LAMPORTS_PER_SOL));
	if (lamports.lte(ZERO)) {
		throw new Error('amount too small');
	}

	const initIxs = await ensureUserInitIxs(walletPk);
	const userAccount = await fetchUserAccount(walletPk);
	await ensureDriftUserCached(walletPk, userAccount);
	const userInitialized = !!userAccount;

	const spotMarket = driftClient.getSpotMarketAccount(
		spotConfig.marketIndex
	) as SpotMarketAccount;

	const instructions: TransactionInstruction[] = [...initIxs];
	let depositAccount = walletPk;
	let wrappedAccount: PublicKey | null = null;

	if (spotMarket.mint.equals(WRAPPED_SOL_MINT)) {
		const wrap = await withAuthority(walletPk, async () => {
			return driftClient.getWrappedSolAccountCreationIxs(lamports, true);
		});
		wrappedAccount = wrap.pubkey;
		depositAccount = wrap.pubkey;
		instructions.push(...wrap.ixs);
	}

	
	const depositIx = await withAuthority(walletPk, async () => {
		debugLog('depositNativeSol user account', userAccount ?? 'not-initialized');
		logInstruction('depositNativeSol', walletPk, spotMarket.mint);
		return driftClient.getDepositInstruction(
			lamports,
			spotConfig.marketIndex,
			depositAccount,
			undefined,
			false,
			userInitialized
		);
	});
	instructions.push(depositIx);

	if (wrappedAccount) {
		instructions.push(createCloseAccountIx(wrappedAccount, walletPk, walletPk));
	}

	const { txBase64, signatures } = await buildTransaction(walletPk, instructions);
	return { txBase64, signatures };
}

export async function getPositionDetails(req: WalletOnlyReq) {
	const walletPk = new PublicKey(req.wallet);
	const userAccount = await fetchUserAccount(walletPk);
	if (!userAccount) {
		return [];
	}

	// Ensure user is cached so getIsolatedPerpPositionTokenAmount works
	await ensureDriftUserCached(walletPk, userAccount);

	if (!marketMaps) {
		marketMaps = buildMarketMaps();
	}

	let userHelper: User | null = null;
	try {
		userHelper = instantiateUserHelper(walletPk, userAccount);
	} catch (err) {
		debugLog('position details: unable to init user helper', err);
	}

	const positions = userAccount.perpPositions.filter(
		(pos) => !pos.baseAssetAmount.eq(new BN(0))
	);

	return Promise.all(
		positions.map(async (pos) => {
			const marketCfg = marketMaps?.byIndex.get(pos.marketIndex);
			const perpMarket = driftClient.getPerpMarketAccount(
				pos.marketIndex
			) as PerpMarketAccount;
			const oracle = driftClient.getOracleDataForPerpMarket(pos.marketIndex);

			const size = convertToNumber(pos.baseAssetAmount, BASE_PRECISION);
			const entryPriceBn = calculateEntryPrice(pos);
			const entryPrice =
				entryPriceBn.isZero() ?
					null :
					convertToNumber(entryPriceBn, PRICE_PRECISION);
			const currentPrice = convertToNumber(oracle.price, PRICE_PRECISION);
			const pnl = calculatePositionPNL(perpMarket, pos, true, oracle);
			const unrealizedPnl = convertToNumber(pnl, QUOTE_PRECISION);

			const margin = convertToNumber(
				pos.isolatedPositionScaledBalance ?? ZERO,
				QUOTE_PRECISION
			);
			const notional = Math.abs(size) * currentPrice;
			const leverage =
				margin > 0 ? Number((notional / margin).toFixed(4)) : null;
			
			// Get isolated margin using the cached user context
			const isolatedMargin = await withAuthority(walletPk, async () => {
				return convertToNumber(
					driftClient.getIsolatedPerpPositionTokenAmount(pos.marketIndex) ?? ZERO,
					QUOTE_PRECISION
				);
			});

			let liquidationPrice: number | null = null;
			if (userHelper) {
				try {
					const liqBn = userHelper.liquidationPrice(
						pos.marketIndex,
						undefined,
						undefined,
						'Maintenance',
						false,
						new BN(0),
						false,
						'Isolated'
					);
					if (liqBn && liqBn.gt(new BN(0))) {
						liquidationPrice = convertToNumber(liqBn, PRICE_PRECISION);
					}
				} catch (err) {
				debugLog('position details: liq price error', err);
				}
			}

			return {
				market: marketCfg?.symbol ?? `MARKET_${pos.marketIndex}`,
				positionSize: size,
				entryPrice,
				currentPrice,
				unrealizedPnl,
				leverage,
				liquidationPrice,
				isolatedMargin,
			};
		})
	);
}

export async function buildDepositTokenTx(req: DepositTokenReq) {
	const walletPk = new PublicKey(req.wallet);
	const spotConfig = resolveSpotMarketConfig(req.market ?? 'USDC');
	const spotMarket = driftClient.getSpotMarketAccount(spotConfig.marketIndex) as SpotMarketAccount;
	const decimals = Number(spotMarket.decimals ?? 6);
	const amount = toTokenAmount(req.amount, decimals);
	if (amount.lte(ZERO)) {
		throw new Error('amount too small');
	}

	const initIxs = await ensureUserInitIxs(walletPk);
	const userAccount = await fetchUserAccount(walletPk);
	await ensureDriftUserCached(walletPk, userAccount);
	const userInitialized = !!userAccount;

	const tokenProgram = driftClient.getTokenProgramForSpotMarket(spotMarket);
	const associatedAccount = await driftClient.getAssociatedTokenAccount(
		spotConfig.marketIndex,
		false,
		tokenProgram,
		walletPk
	);

	const instructions: TransactionInstruction[] = [...initIxs];
	const accountInfo = await connection.getAccountInfo(associatedAccount);
	if (!accountInfo) {
		instructions.push(
			driftClient.createAssociatedTokenAccountIdempotentInstruction(
				associatedAccount,
				walletPk,
				walletPk,
				spotMarket.mint,
				tokenProgram
			)
		);
	}

	const depositIx = await withAuthority(walletPk, async () => {
		logInstruction('depositToken', walletPk, spotMarket.mint);
		return driftClient.getDepositInstruction(
			amount,
			spotConfig.marketIndex,
			associatedAccount,
			undefined,
			false,
			userInitialized
		);
	});
	instructions.push(depositIx);

	const { txBase64, signatures } = await buildTransaction(walletPk, instructions);
	return { txBase64, signatures };
}

export async function getBalances(req: WalletOnlyReq) {
	const walletPk = new PublicKey(req.wallet);
	const walletSummary = await buildAccountSummary(walletPk);

	let driftAccountSummary: AccountBalanceSummary = {
		address: 'not-initialized',
		sol_balance: 0,
		tokens: [],
	};

	try {
		const userPk = getUserAccountPublicKeySync(
			driftClient.program.programId,
			walletPk,
			0
		);
		const userAccount = await fetchUserAccount(walletPk);
		if (userAccount) {
			const lamports = await connection.getBalance(userPk, 'confirmed').catch(() => 0);
			const helper = instantiateUserHelper(walletPk, userAccount);
			driftAccountSummary = {
				address: userPk.toBase58(),
				sol_balance: lamports / LAMPORTS_PER_SOL,
				tokens: getDriftTokenBalancesFromUser(helper, userAccount),
			};
		} else {
			driftAccountSummary = {
				address: userPk.toBase58(),
				sol_balance: 0,
				tokens: [],
			};
		}
	} catch (err) {
		debugLog('fetch drift user balances failed', err);
	}

	return {
		wallet: walletSummary,
		drift_account: driftAccountSummary,
	};
}
function instantiateUserHelper(walletPk: PublicKey, userAccount: UserAccount): User {
	const subscriber = new OneShotUserAccountSubscriber(
		driftClient.program,
		walletPk,
		userAccount
	);
	const user = new User({
		driftClient,
		userAccountPublicKey: walletPk,
		accountSubscription: {
			type: 'custom',
			userAccountSubscriber: subscriber,
		},
	});
	user.isSubscribed = true;
	return user;
}
