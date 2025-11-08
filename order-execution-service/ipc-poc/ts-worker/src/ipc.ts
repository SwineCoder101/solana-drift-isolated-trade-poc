import readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import {
	OpenIsolatedReqSchema,
	ClosePositionReqSchema,
	TransferMarginReqSchema,
	WalletOnlySchema,
	MarketQuerySchema,
	IsolatedBalanceSchema,
	DepositNativeReqSchema,
	DepositTokenReqSchema,
	EmptyArgsSchema,
	RequestValidators,
	IpcRequestSchema,
	type FnName,
	type IpcFailure,
	type IpcSuccess,
} from './types.js';
import {
	buildOpenIsolatedTx,
	buildClosePositionTx,
	buildTransferIsolatedMarginTx,
	getPositions,
	getTrades,
	getMarket,
	getIsolatedBalance,
	getServerPublicKey,
	getPositionDetails,
	buildDepositNativeSolTx,
	buildDepositTokenTx,
	getBalances,
} from './drift.js';

type HandlerMap = {
	[K in FnName]: (args: unknown) => Promise<unknown>;
};

const handlers: HandlerMap = {
	openIsolated: async (args) => {
		const parsed = OpenIsolatedReqSchema.parse(args);
		return buildOpenIsolatedTx(parsed);
	},
	closePosition: async (args) => {
		const parsed = ClosePositionReqSchema.parse(args);
		return buildClosePositionTx(parsed);
	},
	transferMargin: async (args) => {
		const parsed = TransferMarginReqSchema.parse(args);
		return buildTransferIsolatedMarginTx(parsed);
	},
	getPositions: async (args) => {
		const parsed = WalletOnlySchema.parse(args);
		return getPositions(parsed);
	},
	getTrades: async (args) => {
		const parsed = WalletOnlySchema.parse(args);
		return getTrades(parsed);
	},
	getMarket: async (args) => {
		const parsed = MarketQuerySchema.parse(args);
		return getMarket(parsed);
	},
	getIsolatedBalance: async (args) => {
		const parsed = IsolatedBalanceSchema.parse(args);
		return getIsolatedBalance(parsed);
	},
	getServerPublicKey: async (args) => {
		EmptyArgsSchema.parse(args);
		return { publicKey: getServerPublicKey() };
	},
	getPositionDetails: async (args) => {
		const parsed = WalletOnlySchema.parse(args);
		return getPositionDetails(parsed);
	},
	depositNativeSol: async (args) => {
		const parsed = DepositNativeReqSchema.parse(args);
		return buildDepositNativeSolTx(parsed);
	},
	depositToken: async (args) => {
		const parsed = DepositTokenReqSchema.parse(args);
		return buildDepositTokenTx(parsed);
	},
	getBalances: async (args) => {
		const parsed = WalletOnlySchema.parse(args);
		return getBalances(parsed);
	},
};

function writeResponse(payload: IpcSuccess<unknown> | IpcFailure) {
	output.write(`${JSON.stringify(payload)}\n`);
}

async function processLine(line: string) {
	const trimmed = line.trim();
	if (!trimmed) return;
	let request;
	try {
		request = IpcRequestSchema.parse(JSON.parse(trimmed));
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Invalid JSON';
		writeResponse({
			id: '',
			ok: false,
			error: { code: 'BAD_REQUEST', message },
		});
		return;
	}

	const validator = RequestValidators[request.fn];
	if (!validator) {
		writeResponse({
			id: request.id,
			ok: false,
			error: { code: 'NOT_IMPLEMENTED', message: `Unsupported fn ${request.fn}` },
		});
		return;
	}

	try {
		const result = await handlers[request.fn](request.args);
		writeResponse({ id: request.id, ok: true, result });
	} catch (error) {
		const err =
			error instanceof Error
				? { message: error.message, stack: error.stack }
				: { message: 'Unknown error' };
		writeResponse({
			id: request.id,
			ok: false,
			error: {
				code: 'INTERNAL',
				message: err.message,
				stack: err.stack,
			},
		});
	}
}

export function startIpc() {
	const rl = readline.createInterface({ input });
	rl.on('line', (line) => {
		void processLine(line);
	});
	rl.on('close', () => {
		process.exit(0);
	});
}
