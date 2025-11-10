import { useCallback, useEffect, useRef, useState } from 'react';
import { ServiceStatus } from '../types/trading';

const SERVICE_RETRY_LIMIT = 3;
const SERVICE_RETRY_INTERVAL_MS = 15000;

export function useServiceStatuses(orderExecutionUrl: string, indexerUrl: string) {
  const [executionStatus, setExecutionStatus] = useState<ServiceStatus>('checking');
  const [indexerStatus, setIndexerStatus] = useState<ServiceStatus>('checking');
  const [refreshing, setRefreshing] = useState(false);
  const retryCount = useRef(0);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchServiceStatuses = useCallback(async () => {
    const check = async (url: string, path: string) => {
      try {
        const res = await fetch(`${url}${path}`);
        return res.ok ? 'up' : 'down';
      } catch {
        return 'down';
      }
    };

    const exec = await check(orderExecutionUrl, '/server/public-key');
    setExecutionStatus(exec);

    const indexerHealth = await check(indexerUrl, '/health');
    if (indexerHealth === 'up') {
      setIndexerStatus('up');
    } else {
      const fallback = await check(indexerUrl, '/');
      setIndexerStatus(fallback);
    }
  }, [orderExecutionUrl, indexerUrl]);

  useEffect(() => {
    const runCheck = async () => {
      if (retryCount.current >= SERVICE_RETRY_LIMIT) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        return;
      }
      await fetchServiceStatuses();
      retryCount.current += 1;
      if (retryCount.current >= SERVICE_RETRY_LIMIT && intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };

    runCheck();
    intervalRef.current = setInterval(runCheck, SERVICE_RETRY_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [fetchServiceStatuses]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchServiceStatuses();
    } finally {
      setRefreshing(false);
    }
  }, [fetchServiceStatuses]);

  return { executionStatus, indexerStatus, refreshing, refreshServices: refresh };
}
