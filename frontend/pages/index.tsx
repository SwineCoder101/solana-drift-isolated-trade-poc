import Head from 'next/head';
import dynamic from 'next/dynamic';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
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

type PositionRow = {
  market: string;
  positionSize: number;
  entryPrice: number | null;
  currentPrice: number | null;
  unrealizedPnl: number;
  leverage: number | null;
  liquidationPrice: number | null;
};

type ServiceStatus = 'up' | 'down' | 'checking';

const ORDER_EXECUTION_URL =
  process.env.NEXT_PUBLIC_ORDER_EXECUTION_URL ?? process.env.NEXT_PUBLIC_EXECUTION_API ?? 'http://localhost:8080';
const DRIFT_INDEXER_URL = process.env.NEXT_PUBLIC_DRIFT_INDEXER_URL ?? 'http://localhost:4000';
const SERVICE_RETRY_LIMIT = 3;
const SERVICE_RETRY_INTERVAL_MS = 15000;

const ASSETS = ['PERP_SOL', 'PERP_BTC', 'PERP_ETH'];
const EXPLORER_BASE = 'https://explorer.solana.com/address';

const shortenAddress = (address: string) => {
  if (!address) return '';
  if (address.length <= 8) return address;
  return `${address.slice(0, 3)}...${address.slice(-4)}`;
};

const WalletMultiButtonDynamic = dynamic(
  async () => (await import('@solana/wallet-adapter-react-ui')).WalletMultiButton,
  { ssr: false },
);

function HomePage() {
  const { publicKey } = useWallet();
  const [asset, setAsset] = useState<string>(ASSETS[0]);
  const [side, setSide] = useState<OrderSide>('long');
  const [leverage, setLeverage] = useState<number>(5);
  const [initialAmount, setInitialAmount] = useState<string>('1');
  const [status, setStatus] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [balances, setBalances] = useState<BalancesResponse | null>(null);
  const [balanceStatus, setBalanceStatus] = useState<string | null>(null);
  const [adminWallet, setAdminWallet] = useState<string | null>(null);
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [positionsStatus, setPositionsStatus] = useState<string | null>(null);
  const [tradeHistory, setTradeHistory] = useState<any[]>([]);
  const [executionStatus, setExecutionStatus] = useState<ServiceStatus>('checking');
  const [indexerStatus, setIndexerStatus] = useState<ServiceStatus>('checking');
  const [serviceRefreshPending, setServiceRefreshPending] = useState(false);

  const address = useMemo(() => publicKey?.toBase58() ?? 'Not connected', [publicKey]);

  const addHistory = useCallback((entry: any) => {
    setTradeHistory((prev) => [{ ts: Date.now(), ...entry }, ...prev.slice(0, 49)]);
  }, []);

  const fetchServiceStatuses = useCallback(async () => {
    const check = async (url: string, path: string) => {
      try {
        const res = await fetch(`${url}${path}`);
        return res.ok ? 'up' : 'down';
      } catch {
        return 'down';
      }
    };
    setExecutionStatus(await check(ORDER_EXECUTION_URL, '/server/public-key'));
    const indexerHealth = await check(DRIFT_INDEXER_URL, '/health');
    if (indexerHealth === 'up') {
      setIndexerStatus('up');
    } else {
      setIndexerStatus(await check(DRIFT_INDEXER_URL, '/'));
    }
  }, []);

  useEffect(() => {
    let attempts = 0;
    let cancelled = false;
    let interval: NodeJS.Timeout | null = null;

    const runCheck = async () => {
      if (cancelled || attempts >= SERVICE_RETRY_LIMIT) {
        return;
      }
      await fetchServiceStatuses();
      attempts += 1;
      if (attempts >= SERVICE_RETRY_LIMIT && interval) {
        clearInterval(interval);
        interval = null;
      }
    };

    runCheck();
    interval = setInterval(runCheck, SERVICE_RETRY_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (interval) {
        clearInterval(interval);
      }
    };
  }, [fetchServiceStatuses]);

  const handleServiceRefresh = useCallback(async () => {
    setServiceRefreshPending(true);
    try {
      await fetchServiceStatuses();
    } finally {
      setServiceRefreshPending(false);
    }
  }, [fetchServiceStatuses]);

  const fetchAdminWallet = useCallback(async () => {
    try {
      const res = await fetch(`${ORDER_EXECUTION_URL}/server/public-key`);
      if (!res.ok) {
        throw new Error('Failed to load admin wallet');
      }
      const payload = await res.json().catch(() => null);
      if (!payload || typeof payload.publicKey !== 'string') {
        throw new Error('Invalid admin wallet response');
      }
      setAdminWallet(payload.publicKey);
    } catch (err) {
      console.error('Unable to fetch admin wallet', err);
      setAdminWallet(null);
      setBalanceStatus('Unable to load admin wallet.');
    }
  }, []);

  const fetchBalances = useCallback(async () => {
    if (!adminWallet) {
      setBalances(null);
      setBalanceStatus('Waiting for admin wallet...');
      return;
    }
    // setBalanceStatus('Loading balances...');
    try {
      const res = await fetch(`${ORDER_EXECUTION_URL}/balances?wallet=${adminWallet}`);
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.error ?? 'Failed to fetch balances');
      }
      const data: BalancesResponse = await res.json();
      setBalances(data);
      setBalanceStatus(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch balances';
      setBalanceStatus(message);
      setBalances(null);
    }
  }, [adminWallet]);

  useEffect(() => {
    if (!adminWallet) {
      return;
    }
    fetchBalances();
    const interval = setInterval(fetchBalances, 15000);
    return () => clearInterval(interval);
  }, [fetchBalances, adminWallet]);

  useEffect(() => {
    fetchAdminWallet();
    const interval = setInterval(fetchAdminWallet, 60000);
    return () => clearInterval(interval);
  }, [fetchAdminWallet]);

  const fetchPositions = useCallback(async () => {
    if (!publicKey) {
      setPositions([]);
      setPositionsStatus(null);
      return;
    }
    setPositionsStatus('Loading positions...');
    try {
      const res = await fetch(`${ORDER_EXECUTION_URL}/positions/details?wallet=${publicKey.toBase58()}`);
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.error ?? 'Failed to load positions');
      }
      const data: PositionRow[] = await res.json();
      setPositions(data);
      setPositionsStatus(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load positions';
      setPositions([]);
      setPositionsStatus(message);
    }
  }, [publicKey]);

  useEffect(() => {
    fetchPositions();
    const interval = setInterval(fetchPositions, 10000);
    return () => clearInterval(interval);
  }, [fetchPositions]);

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
      const res = await fetch(`${ORDER_EXECUTION_URL}/orders/open-isolated/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: publicKey.toBase58(),
          market: asset,
          size: parsedAmount * (side === 'long' ? 1 : -1),
          leverage,
          margin: parsedAmount,
        }),
      });

      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.error ?? 'Order submission failed');
      }
      const payload = await res.json().catch(() => ({}));
      setStatus(`Order submitted: ${payload.txSignature ?? 'pending signature'}`);
      await fetchPositions();
      await fetchBalances();
      addHistory({ action: 'open', market: asset, amount: parsedAmount, side });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unexpected error';
      setStatus(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleClosePosition = async (market: string) => {
    if (!publicKey) return;
    setStatus('Closing position...');
    try {
      const res = await fetch(`${ORDER_EXECUTION_URL}/orders/close/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: publicKey.toBase58(), market }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.error ?? 'Close failed');
      }
      const payload = await res.json().catch(() => ({}));
      setStatus(`Close submitted: ${payload.txSignature ?? 'pending signature'}`);
      await fetchPositions();
      await fetchBalances();
      addHistory({ action: 'close', market });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Close failed';
      setStatus(message);
    }
  };

  const handleWithdrawMargin = async (market: string) => {
    if (!publicKey) return;
    const input = prompt('Withdraw margin amount', '0.1');
    const amt = input ? Number(input) : NaN;
    if (!Number.isFinite(amt) || amt <= 0) return;

    setStatus('Submitting withdrawal...');
    try {
      const res = await fetch(`${ORDER_EXECUTION_URL}/margin/transfer/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: publicKey.toBase58(),
          market,
          delta: -Math.abs(amt),
        }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.error ?? 'Withdraw failed');
      }
      const payload = await res.json().catch(() => ({}));
      setStatus(`Withdraw submitted: ${payload.txSignature ?? 'pending signature'}`);
      await fetchPositions();
      await fetchBalances();
      addHistory({ action: 'withdraw', market, amount: amt });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Withdraw failed';
      setStatus(message);
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
          <WalletMultiButtonDynamic className="wallet-button" />
        </header>
        <main className="content">
          <div className="card-row">
            <section className="card status-card">
              <h2>Services</h2>
              <button type="button" onClick={handleServiceRefresh} disabled={serviceRefreshPending} className="secondary">
                {serviceRefreshPending ? 'Refreshing...' : 'Refresh'}
              </button>
              <div className="status-grid">
                <ServiceStatus label="Order Execution" status={executionStatus} />
                <ServiceStatus label="Indexer" status={indexerStatus} />
              </div>
            </section>
            <section className="card balances-card">
              <h2>Account Balances</h2>
              {balanceStatus && <p className="status">{balanceStatus}</p>}
              {!balanceStatus && !balances && <p>Unable to load admin wallet balances.</p>}
              {balances && (
                <div className="balance-panels">
                  <BalancePanel title="Admin Wallet" summary={balances.wallet} />
                  <BalancePanel title="Drift Account" summary={balances.drift_account} />
                </div>
              )}
            </section>
          </div>
          <section className="card">
            <h2>Order Parameters (Admin Wallet)</h2>
            <form onSubmit={handleSubmit} className="form-grid">
              <label>
                Market
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
                  max="25"
                  step="0.1"
                  value={leverage}
                  onChange={(e) => setLeverage(Number(e.target.value))}
                />
              </label>

              <label>
                Margin Amount
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

          <section className="card">
            <h2>Live Position Monitoring</h2>
            {positionsStatus && <p>{positionsStatus}</p>}
            {!positionsStatus && positions.length === 0 && <p>No open positions.</p>}
            {positions.length > 0 && (
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
                    const pnl =
                      typeof pos.unrealizedPnl === 'number'
                        ? pos.unrealizedPnl
                        : Number(pos.unrealizedPnl ?? 0);
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
                          <button onClick={() => handleClosePosition(pos.market)} className="secondary">
                            Close
                          </button>
                          <button onClick={() => handleWithdrawMargin(pos.market)} className="secondary">
                            Withdraw
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          <section className="card">
            <h2>Trade History (Mocked)</h2>
            {tradeHistory.length === 0 ? (
              <p>No trades recorded yet.</p>
            ) : (
              <ul className="history-list">
                {tradeHistory.map((item, idx) => (
                  <li key={`${item.ts}-${idx}`}>
                    [{new Date(item.ts).toLocaleTimeString()}] {item.action} {item.market}{' '}
                    {item.amount ?? item.size ?? ''}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </main>
      </div>
    </>
  );
}

function ServiceStatus({ label, status }: { label: string; status: ServiceStatus }) {
  const color = status === 'up' ? 'green' : status === 'down' ? 'red' : 'gray';
  return (
    <div className="service-status">
      <span className="dot" style={{ backgroundColor: color }} />
      {label}: {status}
    </div>
  );
}

function BalancePanel({ title, summary }: { title: string; summary: AccountSummary }) {
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

function AddressLink({ address }: { address: string }) {
  const href = `${EXPLORER_BASE}/${address}?cluster=devnet`;
  return (
    <a href={href} target="_blank" rel="noreferrer" title={address}>
      {shortenAddress(address)}
    </a>
  );
}

export default dynamic(() => Promise.resolve(HomePage), { ssr: false });
