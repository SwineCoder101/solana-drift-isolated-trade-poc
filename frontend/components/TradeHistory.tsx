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

export function TradeHistory({ history }: { history: HistoryEntry[] }) {
	return (
		<section className="card history-card tabular-pane">
			<h2>Trade History</h2>
			{history.length === 0 ? (
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
							<th>Token</th>
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
							<td className="numeric">{renderTokenAmount(item.token_amount)}</td>
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
		return `Perp ${item.perp_market_index}`;
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
