import { Box, Button, Group, Paper, Text } from '@mantine/core';
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
      <Box
        style={{
          position: 'fixed',
          insetInlineEnd: 16,
          bottom: 16,
          zIndex: 50,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          width: 'min(20rem, calc(100% - 2rem))',
          pointerEvents: 'none',
        }}
      >
        {items.map((item) => (
          <Paper
            key={item.id}
            role={item.tone === 'error' ? 'alert' : 'status'}
            withBorder={item.tone !== 'error'}
            p="xs"
            shadow="sm"
            style={{
              pointerEvents: 'auto',
              background:
                item.tone === 'error'
                  ? 'var(--mantine-color-danger-subtle)'
                  : 'var(--mantine-color-body)',
              color:
                item.tone === 'error'
                  ? 'var(--mantine-color-danger-subtle-ink)'
                  : undefined,
            }}
          >
            <Group gap="sm" wrap="nowrap" align="center">
              <Text size="sm" style={{ flex: 1, minWidth: 0 }}>
                {item.message}
              </Text>
              {item.actions.map((action) => (
                <Button
                  key={action.label}
                  variant="subtle"
                  size="compact-xs"
                  onClick={() => {
                    dismiss(item.id);
                    action.onClick();
                  }}
                >
                  {action.label}
                </Button>
              ))}
              <Button
                variant="subtle"
                size="compact-xs"
                onClick={() => {
                  dismiss(item.id);
                }}
              >
                {t('common.dismiss')}
              </Button>
            </Group>
          </Paper>
        ))}
      </Box>
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
