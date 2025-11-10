import { useCallback, useEffect, useState } from 'react';
import { BalancesResponse } from '../types/trading';

export function useBalances(orderExecutionUrl: string, adminWallet: string | null) {
  const [balances, setBalances] = useState<BalancesResponse | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchBalances = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!adminWallet) {
        setBalances(null);
        if (!options?.silent) {
          setStatus('Waiting for admin wallet...');
        }
        return false;
      }
      if (!options?.silent) {
        setStatus('Loading balances...');
      }
      setLoading(true);
      try {
        const res = await fetch(`${orderExecutionUrl}/balances?wallet=${adminWallet}`);
        if (!res.ok) {
          const payload = await res.json().catch(() => null);
          throw new Error(payload?.error ?? 'Failed to fetch balances');
        }
        const data: BalancesResponse = await res.json();
        setBalances(data);
        setStatus(null);
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to fetch balances';
        setStatus(message);
        setBalances(null);
        return false;
      } finally {
        setLoading(false);
      }
    },
    [adminWallet, orderExecutionUrl],
  );

  useEffect(() => {
    fetchBalances();
  }, [fetchBalances]);

  return { balances, status, loading, refreshBalances: fetchBalances };
}
