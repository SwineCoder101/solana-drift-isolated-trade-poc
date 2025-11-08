import Head from 'next/head';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useWallet } from '@solana/wallet-adapter-react';

type OrderSide = 'long' | 'short';

type TokenBalance = {
  symbol: string;
  mint: string;
  balance: number;
};

type AccountSummary = {
  address: string;
  sol_balance: number;
  tokens: TokenBalance[];
};

type BalancesResponse = {
  wallet: AccountSummary;
  drift_account: AccountSummary;
};

const EXECUTION_API = process.env.NEXT_PUBLIC_EXECUTION_API ?? 'http://localhost:8080';

const ASSETS = ['BTC-PERP', 'ETH-PERP', 'SOL-PERP', 'APT-PERP'];

export default function Home() {
  const { publicKey } = useWallet();
  const [asset, setAsset] = useState<string>(ASSETS[0]);
  const [side, setSide] = useState<OrderSide>('long');
  const [leverage, setLeverage] = useState<number>(5);
  const [initialAmount, setInitialAmount] = useState<string>('1');
  const [status, setStatus] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [balances, setBalances] = useState<BalancesResponse | null>(null);
  const [balanceStatus, setBalanceStatus] = useState<string | null>(null);

  const address = useMemo(() => publicKey?.toBase58() ?? 'Not connected', [publicKey]);

  useEffect(() => {
    if (!publicKey) {
      setBalances(null);
      setBalanceStatus(null);
      return;
    }

    let cancelled = false;

    const fetchBalances = async () => {
      try {
        setBalanceStatus('Loading balances...');
        const res = await fetch(`${EXECUTION_API}/balances?wallet=${publicKey.toBase58()}`);
        if (!res.ok) {
          const payload = await res.json().catch(() => null);
          throw new Error(payload?.error ?? 'Failed to fetch balances');
        }
        const data: BalancesResponse = await res.json();
        if (!cancelled) {
          setBalances(data);
          setBalanceStatus(null);
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : 'Failed to fetch balances';
          setBalanceStatus(message);
          setBalances(null);
        }
      }
    };

    fetchBalances();
    const interval = setInterval(fetchBalances, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [publicKey]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setStatus(null);

    if (!publicKey) {
      setStatus('Connect a wallet before submitting an order.');
      return;
    }

    const parsedAmount = parseFloat(initialAmount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setStatus('Enter a valid initial amount greater than 0.');
      return;
    }

    if (!Number.isFinite(leverage) || leverage <= 0) {
      setStatus('Leverage must be greater than 0.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('http://localhost:4000/api/orders/perp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: address,
          asset,
          side,
          leverage,
          initialAmount: parsedAmount,
        }),
      });

      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.error ?? 'Order submission failed');
      }

      setStatus('Order submitted to backend');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unexpected error';
      setStatus(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Head>
        <title>Drift Perpetual Trade</title>
      </Head>
      <div className="page">
        <header className="hero">
          <div>
            <h1>Solana Drift Perp Trade</h1>
            <p>Connect your wallet and configure a perpetual order.</p>
          </div>
          <WalletMultiButton className="wallet-button" />
        </header>
        <main className="content">
          <section className="card">
            <h2>Order Parameters</h2>
            <form onSubmit={handleSubmit} className="form-grid">
              <label>
                Asset
                <select value={asset} onChange={(e) => setAsset(e.target.value)}>
                  {ASSETS.map((symbol) => (
                    <option key={symbol} value={symbol}>
                      {symbol}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Side
                <select value={side} onChange={(e) => setSide(e.target.value as OrderSide)}>
                  <option value="long">Long</option>
                  <option value="short">Short</option>
                </select>
              </label>

              <label>
                Leverage
                <input
                  type="number"
                  min="1"
                  max="20"
                  step="0.1"
                  value={leverage}
                  onChange={(e) => setLeverage(Number(e.target.value))}
                />
              </label>

              <label>
                Initial Amount
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={initialAmount}
                  onChange={(e) => setInitialAmount(e.target.value)}
                />
              </label>

              <button type="submit" disabled={submitting}>
                {submitting ? 'Submitting...' : 'Submit Order'}
              </button>
            </form>
            <div className="status">
              <span>Wallet: {address}</span>
              {status && <p>{status}</p>}
            </div>
          </section>
          {balanceStatus && <p className="status">{balanceStatus}</p>}
          {balances && (
            <section className="card">
              <h2>Balances</h2>
              <BalancePanel title="Wallet" summary={balances.wallet} />
              <BalancePanel title="Drift Account" summary={balances.drift_account} />
            </section>
          )}
        </main>
      </div>
    </>
  );
}

function BalancePanel({ title, summary }: { title: string; summary: AccountSummary }) {
  return (
    <div className="balance-panel">
      <h3>{title}</h3>
      <p>
        <strong>Address:</strong> {summary.address}
      </p>
      <p>
        <strong>SOL:</strong> {summary.sol_balance.toFixed(6)}
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
                <td>{token.mint}</td>
                <td>{token.balance.toFixed(6)}</td>
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
