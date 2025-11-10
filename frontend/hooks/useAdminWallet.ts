import { useCallback, useEffect, useState } from 'react';

export function useAdminWallet(orderExecutionUrl: string) {
  const [adminWallet, setAdminWallet] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAdminWallet = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${orderExecutionUrl}/server/public-key`);
      if (!res.ok) {
        throw new Error('Failed to load admin wallet');
      }
      const payload = await res.json().catch(() => null);
      if (!payload || typeof payload.publicKey !== 'string') {
        throw new Error('Invalid admin wallet response');
      }
      setAdminWallet(payload.publicKey);
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to fetch admin wallet';
      console.error('Unable to fetch admin wallet', err);
      setAdminWallet(null);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [orderExecutionUrl]);

  useEffect(() => {
    fetchAdminWallet();
    const interval = setInterval(fetchAdminWallet, 60000);
    return () => clearInterval(interval);
  }, [fetchAdminWallet]);

  return { adminWallet, loading, error, refreshAdminWallet: fetchAdminWallet };
}
