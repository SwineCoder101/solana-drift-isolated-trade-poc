import { DevnetPerpMarkets } from '../lib/perpMarkets';

const DEVNET_EXPLORER_BASE = 'https://explorer.solana.com/tx';
const PERP_INDEX_TO_SYMBOL = new Map(
	DevnetPerpMarkets.map(({ marketIndex, symbol }) => [marketIndex, symbol] as const)
);

export interface HistoryEntry {
	signature: string;
	slot: number;
	block_time: number | null;
	action_type: string;
	market_index?: number;
	perp_market_index?: number;
	spot_market_index?: number;
	direction?: string;
	amount?: number;
	token_account?: string;
	token_mint?: string;
	token_amount?: number;
	leverage?: number;
	instruction_index?: number;
}

interface TradeHistoryProps {
	history: HistoryEntry[];
	refreshing?: boolean;
	error?: string | null;
	onRefresh?: () => void;
}

export function TradeHistory({
	history,
	refreshing = false,
	error = null,
	onRefresh,
}: TradeHistoryProps) {
	return (
		<section className="card history-card tabular-pane">
			<header className="card-header">
				<h2>Trade History</h2>
				{onRefresh ? (
					<button
						type="button"
						onClick={onRefresh}
						disabled={refreshing}
						className="secondary"
					>
						{refreshing ? 'Refreshing…' : 'Refresh'}
					</button>
				) : null}
			</header>
			{error ? (
				<p className="error-text">
					{error}
					{onRefresh ? ' — please try refreshing.' : ''}
				</p>
			) : history.length === 0 ? (
				<p>No trades recorded yet.</p>
			) : (
				<div className="table-wrapper">
				<table className="history-table">
					<thead>
						<tr>
							<th>Date</th>
							<th>Action</th>
							<th>Direction</th>
							<th>Market</th>
							<th>Amount</th>
							<th>Signature</th>
						</tr>
					</thead>
					<tbody>
					{history.map((item) => (
						<tr key={`${item.signature}-${item.instruction_index ?? 0}`}>
							<td>{formatTimestamp(item.block_time ?? item.slot)}</td>
							<td>{formatAction(item.action_type)}</td>
							<td>{item.direction ? item.direction.toUpperCase() : '—'}</td>
							<td>{renderMarket(item)}</td>
							<td className="numeric">{renderTokenAmount(item.amount)}</td>
							<td className="signature-cell">{renderSignature(item.signature)}</td>
						</tr>
					))}
					</tbody>
				</table>
				</div>
			)}
		</section>
	);
}

function formatTimestamp(ts: number) {
	return new Date(ts * 1000).toLocaleString();
}

function formatAction(action: string) {
	if (action.includes('withdraw')) return 'Withdraw';
	if (action.includes('deposit')) return 'Deposit';
	if (action.includes('placePerpOrder')) return 'Place Order';
	return action;
}

function renderMarket(item: HistoryEntry) {
	if (item.perp_market_index !== undefined) {
		const mapped = PERP_INDEX_TO_SYMBOL.get(item.perp_market_index);
		return mapped ?? `Perp ${item.perp_market_index}`;
	}
	if (item.spot_market_index !== undefined) {
		return `Spot ${item.spot_market_index}`;
	}
	return '—';
}

function renderAmount(value?: number) {
	if (!value) return '—';
	if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
	return value.toString();
}

function renderTokenAmount(value?: number) {
	if (!value) return '—';
	return (value / 1_000_000).toFixed(2);
}

function renderSignature(signature?: string) {
	if (!signature) return '—';
	const href = `${DEVNET_EXPLORER_BASE}/${signature}?cluster=devnet`;
	return (
		<a href={href} target="_blank" rel="noreferrer" title={signature}>
			{shorten(signature)}
		</a>
	);
}

function shorten(value: string) {
	if (value.length <= 10) return value;
	return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
