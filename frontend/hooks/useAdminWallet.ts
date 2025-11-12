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
        let errorMessage = `Server returned ${res.status} ${res.statusText}`;
        try {
          const errorText = await res.text();
          if (errorText) {
            const errorPayload = JSON.parse(errorText);
            if (errorPayload?.error) {
              errorMessage = errorPayload.error;
            }
          }
        } catch {
          // Ignore JSON parsing errors, use default message
        }
        console.warn('Admin wallet endpoint returned error', errorMessage);
        setError(`Failed to load admin wallet: ${errorMessage}`);
        setAdminWallet(null);
        return;
      }
      const payload = await res.json().catch(() => null);
      if (!payload || typeof payload.publicKey !== 'string') {
        const errorMessage = 'Invalid admin wallet response: missing or invalid publicKey';
        console.warn(errorMessage, payload);
        setError(errorMessage);
        setAdminWallet(null);
        return;
      }
      setAdminWallet(payload.publicKey);
      setError(null);
    } catch (err) {
      let message = 'Unable to fetch admin wallet';
      if (err instanceof TypeError && err.message.includes('fetch')) {
        message = `Cannot connect to server at ${orderExecutionUrl}. Is the server running?`;
      } else if (err instanceof Error) {
        message = err.message;
      }
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
