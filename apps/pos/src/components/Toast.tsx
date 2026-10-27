import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

const TOAST_MS = 4000;
const TOAST_LIMIT = 3;

export type ToastTone = 'info' | 'error';

export type ToastAction = { label: string; onClick: () => void };

type ToastItem = {
  id: number;
  message: string;
  tone: ToastTone;
  actions: readonly ToastAction[];
};

type ToastApi = {
  push: (
    message: string,
    tone?: ToastTone,
    actions?: readonly ToastAction[],
  ) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const push = useCallback(
    (
      message: string,
      tone: ToastTone = 'info',
      actions: readonly ToastAction[] = [],
    ) => {
      const id = nextId.current;
      nextId.current += 1;
      setItems((current) => {
        const next = [...current, { id, message, tone, actions }];
        const overflow = next.length - TOAST_LIMIT;
        if (overflow <= 0) {
          return next;
        }
        for (const dropped of next.slice(0, overflow)) {
          const timer = timers.current.get(dropped.id);
          if (timer !== undefined) {
            clearTimeout(timer);
            timers.current.delete(dropped.id);
          }
        }
        return next.slice(overflow);
      });
      if (tone === 'info') {
        const timer = setTimeout(() => {
          dismiss(id);
        }, TOAST_MS);
        timers.current.set(id, timer);
      }
    },
    [dismiss],
  );

  useEffect(() => {
    const active = timers.current;
    return () => {
      for (const timer of active.values()) {
        clearTimeout(timer);
      }
      active.clear();
    };
  }, []);

  const api = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed end-4 bottom-4 z-50 flex w-[min(20rem,calc(100%-2rem))] flex-col gap-2">
        {items.map((item) => (
          <div
            key={item.id}
            role={item.tone === 'error' ? 'alert' : 'status'}
            className={
              item.tone === 'error'
                ? 'pointer-events-auto flex min-h-11 items-center gap-3 rounded-control bg-danger-subtle px-3 py-2 text-danger-subtle-ink shadow-card'
                : 'pointer-events-auto flex min-h-11 items-center gap-3 rounded-control border border-border bg-surface px-3 py-2 text-text shadow-card'
            }
          >
            <span className="min-w-0 flex-1">{item.message}</span>
            {item.actions.map((action) => (
              <button
                key={action.label}
                type="button"
                className="min-h-11 shrink-0 px-2 font-medium underline"
                onClick={() => {
                  dismiss(item.id);
                  action.onClick();
                }}
              >
                {action.label}
              </button>
            ))}
            <button
              type="button"
              className="min-h-11 shrink-0 px-2"
              onClick={() => {
                dismiss(item.id);
              }}
            >
              {t('common.dismiss')}
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) {
    throw new Error('ToastProvider is missing');
  }
  return api;
}
