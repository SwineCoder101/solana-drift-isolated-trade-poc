import { useCallback, useEffect, useState } from 'react';
import { PositionRow } from '../types/trading';

export function usePositions(orderExecutionUrl: string, wallet: string | null) {
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchPositions = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!wallet) {
        setPositions([]);
        if (!options?.silent) {
          setStatus('Connect a wallet to view positions.');
        }
        return false;
      }
      if (!options?.silent) {
        setStatus('Loading positions...');
      }
      setLoading(true);
      try {
        const res = await fetch(`${orderExecutionUrl}/positions/details?wallet=${wallet}`);
        if (!res.ok) {
          const payload = await res.json().catch(() => null);
          throw new Error(payload?.error ?? 'Failed to load positions');
        }
        const data: PositionRow[] = await res.json();
        setPositions(data);
        setStatus(null);
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load positions';
        setPositions([]);
        setStatus(message);
        return false;
      } finally {
        setLoading(false);
      }
    },
    [orderExecutionUrl, wallet],
  );

  useEffect(() => {
    fetchPositions();
  }, [fetchPositions]);

  return { positions, status, loading, refreshPositions: fetchPositions };
}
