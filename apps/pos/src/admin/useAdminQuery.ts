import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AdminApiError, adminErrorMessage } from './api.ts';

export function useAdminQuery<T>(key: string, query: () => Promise<T>) {
  const { t } = useTranslation();
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
            : err instanceof AdminApiError && err.status >= 500
              ? t('admin.err_server')
              : adminErrorMessage(err, t('admin.err_generic'));
        setError(message);
      });
    return () => {
      cancelled = true;
    };
  }, [key, nonce, t]);

  return {
    data,
    error,
    reload: () => {
      setNonce((n) => n + 1);
    },
  };
}
