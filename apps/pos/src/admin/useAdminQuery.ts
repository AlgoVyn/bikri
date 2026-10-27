import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../components/Toast.tsx';
import { AdminApiError, adminErrorMessage } from './api.ts';

export function useAdminQuery<T>(key: string, query: () => Promise<T>) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryRef = useRef(query);
  queryRef.current = query;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const requestKey = key;
    const requestNonce = nonce;
    let cancelled = false;
    setError(null);
    void queryRef
      .current()
      .then((value) => {
        if (!cancelled && requestKey === key && requestNonce === nonce) {
          setData(value);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof AdminApiError && err.status === 403
            ? t('admin.err_not_operator')
            : adminErrorMessage(err, t('admin.err_generic'));
        setError(message);
        toast.push(message, 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [key, nonce, t, toast]);

  return {
    data,
    error,
    reload: () => {
      setNonce((n) => n + 1);
    },
  };
}
