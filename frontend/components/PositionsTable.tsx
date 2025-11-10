import { PositionRow } from '../types/trading';

interface PositionsTableProps {
  positions: PositionRow[];
  status: string | null;
  loading: boolean;
  onRefresh: () => void;
  onClose: (market: string) => void;
  onWithdraw: (market: string) => void;
}

export function PositionsTable({ positions, status, loading, onRefresh, onClose, onWithdraw }: PositionsTableProps) {
  return (
    <section className="card positions-card">
      <div className="positions-card__header">
        <h2>Live Position Monitoring</h2>
        <button type="button" className="secondary" onClick={onRefresh} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh Positions'}
        </button>
      </div>
      {status && <p>{status}</p>}
      {!status && positions.length === 0 && <p>No open positions.</p>}
      {positions.length > 0 && (
        <div className="positions-card__table-wrapper">
          <table className="positions-table">
            <thead>
              <tr>
                <th>Market</th>
                <th>Size</th>
                <th>Entry</th>
                <th>Current</th>
                <th>Unrealized PnL</th>
                <th>Leverage</th>
                <th>Liq Price</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((pos) => {
                const pnl = typeof pos.unrealizedPnl === 'number' ? pos.unrealizedPnl : Number(pos.unrealizedPnl ?? 0);
                return (
                  <tr key={`${pos.market}-${pos.positionSize}`}>
                    <td>{pos.market}</td>
                    <td>{pos.positionSize}</td>
                    <td>{pos.entryPrice ?? '—'}</td>
                    <td>{pos.currentPrice ?? '—'}</td>
                    <td>{pnl.toFixed(4)}</td>
                    <td>{pos.leverage ?? '—'}</td>
                    <td>{pos.liquidationPrice ?? '—'}</td>
                    <td>
                      <button onClick={() => onClose(pos.market)} className="secondary">
                        Close
                      </button>
                      <button onClick={() => onWithdraw(pos.market)} className="secondary">
                        Withdraw
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
