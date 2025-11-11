import { BalancesResponse } from '../types/trading';
import { AddressLink } from './AddressLink';
import { BalancePanel } from './BalancePanel';

interface BalancesCardProps {
  adminWallet: string | null;
  balances: BalancesResponse | null;
  status: string | null;
  loading: boolean;
  onRefresh: () => void;
  onDeposit: () => void;
}

export function BalancesCard({ adminWallet, balances, status, loading, onRefresh, onDeposit }: BalancesCardProps) {
  return (
    <section className="card balances-card">
      <h2>Account Balances</h2>
      <div className="balances-card__header">
        {adminWallet && (
          <p>
            Admin wallet: <AddressLink address={adminWallet} />
          </p>
        )}
        <div className="balances-card__actions">
          <button type="button" onClick={onDeposit} className="secondary" disabled={!adminWallet}>
            Deposit Drift Account
          </button>
          <button type="button" onClick={onRefresh} className="secondary" disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh Balances'}
          </button>
        </div>
      </div>
      {status && <p className="status">{status}</p>}
      {!status && !balances && <p>Unable to load admin wallet balances.</p>}
      {balances && (
        <div className="balance-panels">
          <BalancePanel title="Admin Wallet" summary={balances.wallet} />
          <BalancePanel title="Drift Account" summary={balances.drift_account} />
        </div>
      )}
    </section>
  );
}
