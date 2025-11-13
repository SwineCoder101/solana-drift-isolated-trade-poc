import Head from 'next/head';
import dynamic from 'next/dynamic';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { DevnetPerpMarkets } from '../lib/perpMarkets';

import { BalancesCard } from '../components/BalancesCard';
import { OrderForm } from '../components/OrderForm';
import { PositionsTable } from '../components/PositionsTable';
import { ServiceStatusCard } from '../components/ServiceStatusCard';
import { TradeHistory, HistoryEntry } from '../components/TradeHistory';
import { useAdminWallet } from '../hooks/useAdminWallet';
import { useBalances } from '../hooks/useBalances';
import { usePositions } from '../hooks/usePositions';
import { useServiceStatuses } from '../hooks/useServiceStatuses';
import { OrderSide } from '../types/trading';

const ORDER_EXECUTION_URL =
  process.env.NEXT_PUBLIC_ORDER_EXECUTION_URL ?? process.env.NEXT_PUBLIC_EXECUTION_API ?? 'http://localhost:8080';
const DRIFT_INDEXER_URL = process.env.NEXT_PUBLIC_DRIFT_INDEXER_URL ?? 'http://localhost:4000';
const TRADE_HISTORY_LIMIT = 150;

const MARKET_OPTIONS = DevnetPerpMarkets.map((cfg) => ({
	value: `PERP_${cfg.baseAssetSymbol.toUpperCase()}`,
	label: cfg.symbol,
}));

const WalletMultiButtonDynamic = dynamic(
  async () => (await import('@solana/wallet-adapter-react-ui')).WalletMultiButton,
  { ssr: false },
);

function HomePage() {
  const { publicKey } = useWallet();
	const [asset, setAsset] = useState<string>(MARKET_OPTIONS[0]?.value ?? '');
  const [side, setSide] = useState<OrderSide>('long');
  const [leverage, setLeverage] = useState<number>(5);
  const [initialAmount, setInitialAmount] = useState<string>('1');
  const [status, setStatus] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [tradeHistory, setTradeHistory] = useState<HistoryEntry[]>([]);
  const [tradeHistoryRefreshing, setTradeHistoryRefreshing] = useState(false);
  const [tradeHistoryError, setTradeHistoryError] = useState<string | null>(null);

  const { adminWallet } = useAdminWallet(ORDER_EXECUTION_URL);
  const { balances, status: balancesStatus, loading: balancesLoading, refreshBalances } = useBalances(
    ORDER_EXECUTION_URL,
    adminWallet,
  );
  const { executionStatus, indexerStatus, refreshing: serviceRefreshPending, refreshServices } = useServiceStatuses(
    ORDER_EXECUTION_URL,
    DRIFT_INDEXER_URL,
  );

  const resolvedWallet = useMemo(() => adminWallet ?? publicKey?.toBase58() ?? null, [adminWallet, publicKey]);

  const { positions, status: positionsStatus, loading: positionsLoading, refreshPositions } = usePositions(
    ORDER_EXECUTION_URL,
    resolvedWallet,
  );

  const fetchTradeHistory = useCallback(async () => {
    setTradeHistoryRefreshing(true);
    setTradeHistoryError(null);
    try {
      const res = await fetch(`${ORDER_EXECUTION_URL}/actions/history?limit=${TRADE_HISTORY_LIMIT}`);
      if (!res.ok) {
        const payload = await res
          .json()
          .catch(() => ({ error: `HTTP ${res.status}` }));
        const message =
          typeof payload?.error === 'string'
            ? payload.error
            : `Failed to load trade history (HTTP ${res.status})`;
        setTradeHistoryError(message);
        console.warn('Trade history fetch returned non-OK status', {
          status: res.status,
          body: payload,
        });
        setTradeHistory([]);
        return;
      }
      const data: HistoryEntry[] = await res.json();
      setTradeHistory(data);
      setTradeHistoryError(null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unable to load trade history';
      setTradeHistoryError(message);
      console.error('Failed to fetch trade history', err);
      setTradeHistory([]);
    } finally {
      setTradeHistoryRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchTradeHistory();
  }, [fetchTradeHistory]);

  const addHistory = useCallback((entry: Partial<HistoryEntry>) => {
    setTradeHistory((prev) => [{
      signature: entry.signature ?? crypto.randomUUID(),
      slot: entry.slot ?? Date.now(),
      block_time: entry.block_time ?? Math.floor(Date.now() / 1000),
      action_type: entry.action_type ?? 'order',
      direction: entry.direction,
      amount: entry.amount,
      token_amount: entry.token_amount,
    }, ...prev.slice(0, 49)]);
  }, []);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setStatus(null);

    if (!resolvedWallet) {
      setStatus('Admin wallet unavailable. Please retry.');
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
          wallet: resolvedWallet,
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
      await refreshPositions();
      await refreshBalances();
      await fetchTradeHistory();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unexpected error';
      setStatus(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleClosePosition = async (market: string) => {
    if (!resolvedWallet) {
      setStatus('Admin wallet unavailable.');
      return;
    }
    setStatus('Closing position...');
    try {
      const res = await fetch(`${ORDER_EXECUTION_URL}/orders/close/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: resolvedWallet, market }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.error ?? 'Close failed');
      }
      const payload = await res.json().catch(() => ({}));
      setStatus(`Close submitted: ${payload.txSignature ?? 'pending signature'}`);
      await refreshPositions();
      await refreshBalances();
      await fetchTradeHistory();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Close failed';
      setStatus(message);
    }
  };

  const handleWithdrawMargin = async (market: string) => {
    if (!resolvedWallet) {
      setStatus('Admin wallet unavailable.');
      return;
    }
    const input = prompt('Withdraw margin amount', '0.1');
    const amt = input ? Number(input) : NaN;
    if (!Number.isFinite(amt) || amt <= 0) return;

    setStatus('Submitting withdrawal...');
    try {
      const res = await fetch(`${ORDER_EXECUTION_URL}/margin/transfer/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: resolvedWallet,
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
      await refreshPositions();
      await refreshBalances();
      await fetchTradeHistory();
      addHistory({ action_type: 'withdraw', amount: amt });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Withdraw failed';
      setStatus(message);
    }
  };

  const handleDepositIsolated = async (market: string) => {
    if (!resolvedWallet) {
      setStatus('Admin wallet unavailable.');
      return;
    }
    const input = prompt('Deposit margin amount', '1');
    const amt = input ? Number(input) : NaN;
    if (!Number.isFinite(amt) || amt <= 0) return;

    setStatus('Depositing margin...');
    try {
      const res = await fetch(`${ORDER_EXECUTION_URL}/margin/transfer/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: resolvedWallet,
          market,
          delta: Math.abs(amt),
        }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.error ?? 'Deposit failed');
      }
      const payload = await res.json().catch(() => ({}));
      setStatus(`Margin deposited: ${payload.txSignature ?? 'signature unavailable'}`);
      await refreshPositions();
      await refreshBalances();
      await fetchTradeHistory();
      addHistory({ action_type: 'deposit', amount: amt });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Deposit failed';
      setStatus(message);
    }
  };

  const handleDepositDriftAccount = async () => {
    if (!adminWallet) {
      setStatus('Admin wallet unavailable.');
      return;
    }
    const input = prompt('Deposit amount (SOL)', '0.1');
    const amt = input ? Number(input) : NaN;
    if (!Number.isFinite(amt) || amt <= 0) return;
    setStatus('Depositing to Drift account...');
    try {
      const res = await fetch(`${ORDER_EXECUTION_URL}/margin/deposit-native/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: adminWallet, amount: amt, market: 'SOL' }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.error ?? 'Deposit failed');
      }
      const payload = await res.json().catch(() => ({}));
      setStatus(`Deposit submitted: ${payload.txSignature ?? 'signature unavailable'}`);
      await refreshBalances();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Deposit failed';
      setStatus(message);
    }
  };

  const address = useMemo(() => publicKey?.toBase58() ?? 'Not connected', [publicKey]);

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
            <ServiceStatusCard
              executionStatus={executionStatus}
              indexerStatus={indexerStatus}
              refreshing={serviceRefreshPending}
              onRefresh={() => {
                void refreshServices();
              }}
            />
            <BalancesCard
              adminWallet={adminWallet}
              balances={balances}
              status={balancesStatus}
              loading={balancesLoading}
              onRefresh={() => {
                void refreshBalances();
              }}
              onDeposit={() => {
                void handleDepositDriftAccount();
              }}
            />
          </div>

	<OrderForm
		assets={MARKET_OPTIONS}
            asset={asset}
            side={side}
            leverage={leverage}
            initialAmount={initialAmount}
            submitting={submitting}
            status={status}
            address={address}
            onAssetChange={setAsset}
            onSideChange={setSide}
            onLeverageChange={setLeverage}
            onAmountChange={setInitialAmount}
            onSubmit={handleSubmit}
          />

          <PositionsTable
            positions={positions}
            status={positionsStatus}
            loading={positionsLoading}
            onRefresh={() => {
              void refreshPositions();
            }}
            onClose={handleClosePosition}
            onWithdraw={handleWithdrawMargin}
            onDeposit={handleDepositIsolated}
          />

          <TradeHistory
            history={tradeHistory}
            refreshing={tradeHistoryRefreshing}
            error={tradeHistoryError}
            onRefresh={() => {
              void fetchTradeHistory();
            }}
          />
        </main>
      </div>
    </>
  );
}

export default dynamic(() => Promise.resolve(HomePage), { ssr: false });
