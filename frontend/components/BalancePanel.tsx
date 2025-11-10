import { AccountSummary } from '../types/trading';
import { AddressLink } from './AddressLink';

export function BalancePanel({ title, summary }: { title: string; summary: AccountSummary }) {
  return (
    <div className="balance-panel">
      <h3>{title}</h3>
      <p>
        <strong>Address:</strong> <AddressLink address={summary.address} />
      </p>
      <p>
        <strong>SOL:</strong> {summary.sol_balance.toFixed(3)}
      </p>
      {summary.tokens.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Token</th>
              <th>Mint</th>
              <th>Balance</th>
            </tr>
          </thead>
          <tbody>
            {summary.tokens.map((token) => (
              <tr key={`${summary.address}-${token.mint}`}>
                <td>{token.symbol}</td>
                <td>
                  <AddressLink address={token.mint} />
                </td>
                <td>{token.balance.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>No SPL token balances detected.</p>
      )}
    </div>
  );
}
