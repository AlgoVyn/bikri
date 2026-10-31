import {
  Box,
  Button,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
} from '@mantine/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../components/Toast.tsx';
import {
  AdminApiError,
  adminErrorMessage,
  deleteTenant,
  getTenant,
} from './api.ts';
import { adminHref, formatWhen, statusLabelKey } from './format.ts';
import type { Tenant } from './types.ts';
import { Panel, ReasonDialog } from './ui.tsx';

export function DeleteTab({
  tenant,
  onChanged,
  onExport,
}: {
  tenant: Tenant;
  onChanged: () => void;
  onExport: () => void;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const lang = i18n.language;
  const deleting = tenant.status === 'deleting';

  useEffect(() => {
    if (!deleting) return;
    let stop = false;
    let timer = 0;
    const tick = () => {
      if (stop) return;
      void getTenant(tenant.id)
        .then((detail) => {
          if (stop) return;
          if (detail.tenant.status === 'deleted') {
            window.location.assign(adminHref('/admin/tenants'));
            return;
          }
          timer = window.setTimeout(tick, 5000);
        })
        .catch((err: unknown) => {
          if (stop) return;
          if (err instanceof AdminApiError && err.status === 404) {
            window.location.assign(adminHref('/admin/tenants'));
            return;
          }
          timer = window.setTimeout(tick, 5000);
        });
    };
    timer = window.setTimeout(tick, 5000);
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [deleting, tenant.id]);

  return (
    <>
      <Panel
        title={t('admin.delete_zone')}
        description={t('admin.delete_zone_hint')}
      >
        <Stack gap="md">
          <Paper p="sm" bg="var(--mantine-color-danger-subtle)">
            <Text size="sm" c="var(--mantine-color-danger-subtle-ink)">
              {t('admin.delete_warning')}
            </Text>
          </Paper>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <Box>
              <Text size="sm" c="dimmed">
                {t('admin.last_export')}
              </Text>
              <Text fw={500}>
                {tenant.last_owner_export_at === null
                  ? t('admin.never')
                  : formatWhen(tenant.last_owner_export_at, lang)}
              </Text>
            </Box>
            <Box>
              <Text size="sm" c="dimmed">
                {t('admin.col_status')}
              </Text>
              <Text fw={500}>{t(statusLabelKey(tenant.status))}</Text>
            </Box>
          </SimpleGrid>
          <Text size="sm" c="dimmed">
            {t('admin.delete_offer')}
          </Text>
          {deleting ? (
            <Paper
              p="sm"
              role="status"
              bg="var(--mantine-color-warning-subtle)"
            >
              <Text size="sm" c="var(--mantine-color-warning-subtle-ink)">
                {t('admin.delete_progress')}
              </Text>
            </Paper>
          ) : null}
          <Group
            gap="sm"
            pt="md"
            style={{
              borderTop: '1px solid var(--mantine-color-default-border)',
            }}
          >
            <Button type="button" variant="default" onClick={onExport}>
              {t('admin.tab_export')}
            </Button>
            {tenant.status !== 'deleted' && !deleting ? (
              <Button
                type="button"
                color="danger"
                onClick={() => setOpen(true)}
              >
                {t('admin.delete_go')}
              </Button>
            ) : null}
          </Group>
        </Stack>
      </Panel>
      <ReasonDialog
        open={open}
        title={t('admin.delete')}
        body={t('admin.delete_warning')}
        confirmLabel={t('admin.delete_go')}
        danger
        slug={tenant.slug}
        pending={pending}
        onOpenChange={setOpen}
        onConfirm={async ({ reason, slug }) => {
          setPending(true);
          try {
            await deleteTenant(tenant.id, slug, reason);
            toast.push(t('admin.delete_progress'), 'info');
            onChanged();
            return true;
          } catch (err: unknown) {
            toast.push(adminErrorMessage(err, t('admin.err_generic')), 'error');
            return false;
          } finally {
            setPending(false);
          }
        }}
      />
    </>
  );
}
