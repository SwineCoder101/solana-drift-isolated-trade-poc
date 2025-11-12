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
		<section className="card history-card">
			<h2>Trade History</h2>
			{history.length === 0 ? (
				<p>No trades recorded yet.</p>
			) : (
				<ul className="history-list">
					{history.map((item) => (
						<li key={`${item.signature}-${item.instruction_index ?? 0}`}>
							[{formatTimestamp(item.block_time ?? item.slot)}] {item.action_type}
							{item.direction ? ` ${item.direction.toUpperCase()}` : ''}
							{item.perp_market_index !== undefined ? ` Market ${item.perp_market_index}` : ''}
							{item.amount ? ` Amount ${item.amount}` : ''}
							{item.token_amount ? ` Token ${item.token_amount}` : ''}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function formatTimestamp(ts: number) {
	return new Date(ts * 1000).toLocaleString();
}
