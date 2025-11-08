import { z } from 'zod';

export const OpenIsolatedReqSchema = z.object({
	wallet: z.string().min(32),
	market: z.string().min(1),
	size: z.number().finite(),
	leverage: z.number().positive().max(100),
	margin: z.number().positive(),
});

export type OpenIsolatedReq = z.infer<typeof OpenIsolatedReqSchema>;

export const ClosePositionReqSchema = z.object({
	wallet: z.string().min(32),
	market: z.string().min(1),
	size: z.number().finite().optional(),
});

export type ClosePositionReq = z.infer<typeof ClosePositionReqSchema>;

export const TransferMarginReqSchema = z.object({
	wallet: z.string().min(32),
	market: z.string().min(1),
	delta: z.number().finite(),
});

export type TransferMarginReq = z.infer<typeof TransferMarginReqSchema>;

export const WalletOnlySchema = z.object({
	wallet: z.string().min(32),
});

export const MarketQuerySchema = z.object({
	symbol: z.string().min(1),
});

export const IsolatedBalanceSchema = z.object({
	wallet: z.string().min(32),
	market: z.string().min(1),
});

export const EmptyArgsSchema = z.object({}).optional();

export const DepositNativeReqSchema = z.object({
	wallet: z.string().min(32),
	amount: z.number().positive(),
	market: z.string().min(1).optional(),
});

export const DepositTokenReqSchema = z.object({
	wallet: z.string().min(32),
	amount: z.number().positive(),
	market: z.string().min(1).optional(),
});

export type WalletOnlyReq = z.infer<typeof WalletOnlySchema>;
export type MarketQueryReq = z.infer<typeof MarketQuerySchema>;
export type IsolatedBalanceReq = z.infer<typeof IsolatedBalanceSchema>;
export type DepositNativeReq = z.infer<typeof DepositNativeReqSchema>;
export type DepositTokenReq = z.infer<typeof DepositTokenReqSchema>;

export const FnNames = [
	'openIsolated',
	'closePosition',
	'transferMargin',
	'getPositions',
	'getTrades',
	'getMarket',
	'getIsolatedBalance',
	'getServerPublicKey',
	'getPositionDetails',
	'depositNativeSol',
	'depositToken',
	'getBalances',
] as const;

export type FnName = (typeof FnNames)[number];

export const RequestValidators: Record<FnName, z.ZodTypeAny> = {
	openIsolated: OpenIsolatedReqSchema,
	closePosition: ClosePositionReqSchema,
	transferMargin: TransferMarginReqSchema,
	getPositions: WalletOnlySchema,
	getTrades: WalletOnlySchema,
	getMarket: MarketQuerySchema,
	getIsolatedBalance: IsolatedBalanceSchema,
	getServerPublicKey: EmptyArgsSchema,
	getPositionDetails: WalletOnlySchema,
	depositNativeSol: DepositNativeReqSchema,
	depositToken: DepositTokenReqSchema,
	getBalances: WalletOnlySchema,
};

export const FnEnum = z.enum(FnNames);

export const IpcRequestSchema = z.object({
	id: z.string().min(1),
	fn: FnEnum,
	args: z.unknown(),
});

export type IpcRequest = z.infer<typeof IpcRequestSchema>;

export type IpcSuccess<T> = {
	id: string;
	ok: true;
	result: T;
};

export type IpcErrorPayload = {
	code: string;
	message: string;
	stack?: string;
};

export type IpcFailure = {
	id: string;
	ok: false;
	error: IpcErrorPayload;
};
