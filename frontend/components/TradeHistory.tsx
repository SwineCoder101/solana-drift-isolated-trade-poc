export interface HistoryEntry {
  ts: number;
  action: string;
  market: string;
  amount?: number;
  size?: number;
  side?: string;
}

export function TradeHistory({ history }: { history: HistoryEntry[] }) {
  return (
    <section className="card history-card">
      <h2>Trade History (Mocked)</h2>
      {history.length === 0 ? (
        <p>No trades recorded yet.</p>
      ) : (
        <ul className="history-list">
          {history.map((item, idx) => (
            <li key={`${item.ts}-${idx}`}>
              [{new Date(item.ts).toLocaleTimeString()}] {item.action} {item.market}{' '}
              {item.amount ?? item.size ?? ''}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
