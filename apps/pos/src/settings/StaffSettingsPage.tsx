import {
  hashPin,
  isWeakPin,
  PERMISSIONS,
  type Permission,
  type Role,
  roleAllows,
} from '@bikri/core';
import type { MasterRow } from '@bikri/db';
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Divider,
  Group,
  NativeSelect,
  NumberInput,
  Paper,
  PasswordInput,
  ScrollArea,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../components/EmptyState.tsx';
import { UsersIcon } from '../components/icons.tsx';
import { useToast } from '../components/Toast.tsx';
import { getDb } from '../data/db.ts';
import { isPinTaken } from '../data/pinLock.ts';
import {
  SettingsError,
  type StaffInput,
  saveStaff,
  staffList,
} from '../data/settings.ts';
import { AreaStrings } from '../i18n/areas.tsx';
import { Modal } from '../sell/Modal.tsx';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import { SettingsGuard } from './Guard.tsx';
import { SettingsPageLayout } from './Layout.tsx';

const ROLES: Role[] = ['owner', 'manager', 'cashier'];

/** Cashiers, roles, PINs and permission overrides (screens/17). */
export function StaffSettingsPage() {
  return (
    <AreaStrings area="office">
      <SettingsGuard permission="settings.staff">
        <StaffList />
      </SettingsGuard>
    </AreaStrings>
  );
}

function StaffList() {
  const { t } = useTranslation();
  const readOnly = useReadOnly();
  const [editing, setEditing] = useState<MasterRow | null>(null);
  const [adding, setAdding] = useState(false);
  const rows = useLiveQuery(() => staffList(getDb()), []) ?? [];
  return (
    <SettingsPageLayout title={t('office.staff.title')} icon={<UsersIcon />}>
      <Group justify="flex-end">
        <Button
          type="button"
          disabled={readOnly}
          onClick={() => setAdding(true)}
        >
          {t('office.staff.add')}
        </Button>
      </Group>
      {rows.length === 0 ? (
        <EmptyState message={t('office.staff.empty')} />
      ) : (
        <Paper withBorder>
          <Box
            component="ul"
            style={{ listStyle: 'none', margin: 0, padding: 0 }}
          >
            {rows.map((row, index) => (
              <Box component="li" key={row.staff.id}>
                {index > 0 ? <Divider /> : null}
                <UnstyledButton
                  w="100%"
                  p="sm"
                  disabled={readOnly}
                  onClick={() => setEditing(row.staff)}
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: 8,
                    textAlign: 'start',
                    minHeight: 56,
                  }}
                >
                  <Box style={{ flex: 1, minWidth: 0 }}>
                    <Text fw={500} truncate>
                      {String(row.staff.name)}
                    </Text>
                    <Text size="sm" c="dimmed">
                      {t(`office.staff.role_${String(row.staff.role)}`)}
                      {' · '}
                      {row.staff.active === 1
                        ? t('office.staff.active')
                        : t('office.staff.inactive')}
                    </Text>
                  </Box>
                  {row.isLastOwner ? (
                    <Badge color="brand" variant="light" radius="xl" tt="none">
                      {t('office.staff.last_owner')}
                    </Badge>
                  ) : null}
                  <Text size="sm" c="dimmed">
                    {row.staff.pin_hash
                      ? t('office.staff.pin_set')
                      : t('office.staff.pin_not_set')}
                  </Text>
                </UnstyledButton>
              </Box>
            ))}
          </Box>
        </Paper>
      )}
      <StaffDialog
        open={adding || editing !== null}
        row={editing}
        isLastOwner={
          rows.find((row) => row.staff.id === editing?.id)?.isLastOwner ?? false
        }
        onOpenChange={(open) => {
          if (!open) {
            setAdding(false);
            setEditing(null);
          }
        }}
      />
    </SettingsPageLayout>
  );
}

function StaffDialog({
  open,
  row,
  isLastOwner,
  onOpenChange,
}: {
  open: boolean;
  row: MasterRow | null;
  isLastOwner: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { staff: actor } = useCurrentStaff();
  const readOnly = useReadOnly();
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('cashier');
  const [active, setActive] = useState(true);
  const [maxDiscountBp, setMaxDiscountBp] = useState(500);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    const nextRole = (row?.role as Role | undefined) ?? 'cashier';
    setName(row ? String(row.name) : '');
    setRole(nextRole);
    setActive(row ? row.active === 1 : true);
    setMaxDiscountBp(
      Number(
        row?.max_discount_bp ??
          (nextRole === 'owner' ? 10000 : nextRole === 'manager' ? 2000 : 500),
      ),
    );
    try {
      setOverrides(
        JSON.parse(String(row?.permissions_json ?? '{}')) as Record<
          string,
          boolean
        >,
      );
    } catch {
      setOverrides({});
    }
    setPin('');
    setPin2('');
    setPending(false);
  }, [open, row]);

  const checked = (permission: Permission): boolean =>
    overrides[permission] ?? roleAllows(role, permission);

  const toggle = (permission: Permission, value: boolean) => {
    setOverrides((current) => {
      const next = { ...current };
      if (value === roleAllows(role, permission)) delete next[permission];
      else next[permission] = value;
      return next;
    });
  };

  const save = async () => {
    if (pending) return;
    if (pin !== '' && (pin !== pin2 || isWeakPin(pin))) {
      toast.push(t('office.staff.pin_invalid'), 'error');
      return;
    }
    if (
      pin !== '' &&
      (await isPinTaken(getDb(), pin, row ? String(row.id) : null))
    ) {
      toast.push(t('office.staff.pin_taken'), 'error');
      return;
    }
    if (!row && pin === '') {
      toast.push(t('office.staff.pin_required'), 'error');
      return;
    }
    setPending(true);
    try {
      const pinHash = pin === '' ? undefined : await hashPin(pin);
      const input: StaffInput = {
        ...(row ? { id: String(row.id) } : {}),
        name,
        role,
        active,
        maxDiscountBp,
        permissions: overrides,
        ...(pinHash ? { pin: { ...pinHash, pin_length: pin.length } } : {}),
      };
      await saveStaff(getDb(), input, actor?.id ?? null);
      toast.push(t('office.staff.saved'));
      onOpenChange(false);
    } catch (err) {
      const code = err instanceof SettingsError ? err.code : 'generic';
      toast.push(
        code === 'generic'
          ? t('errors.generic')
          : t(`office.staff.error_${code}`),
        'error',
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={row ? t('office.staff.edit') : t('office.staff.add')}
      wide
    >
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
        <TextInput
          label={t('office.staff.name')}
          maxLength={40}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <NativeSelect
          label={t('office.staff.role')}
          value={role}
          disabled={isLastOwner}
          onChange={(event) => setRole(event.currentTarget.value as Role)}
          data={ROLES.map((item) => ({
            value: item,
            label: t(`office.staff.role_${item}`),
          }))}
        />
        <NumberInput
          label={t('office.staff.max_discount')}
          min={0}
          max={100}
          step={0.5}
          decimalScale={2}
          value={maxDiscountBp / 100}
          onChange={(value) =>
            setMaxDiscountBp(
              Math.round(Math.max(0, Math.min(100, Number(value) || 0)) * 100),
            )
          }
        />
        <Checkbox
          label={t('office.staff.active')}
          checked={active}
          disabled={isLastOwner}
          onChange={(event) => setActive(event.currentTarget.checked)}
          style={{ alignSelf: 'end' }}
        />
        <PasswordInput
          label={row ? t('office.staff.new_pin') : t('office.staff.pin')}
          inputMode="numeric"
          autoComplete="new-password"
          maxLength={6}
          value={pin}
          onChange={(event) =>
            setPin(event.currentTarget.value.replace(/[^0-9]/gu, ''))
          }
        />
        <PasswordInput
          label={t('office.staff.pin_again')}
          inputMode="numeric"
          autoComplete="new-password"
          maxLength={6}
          value={pin2}
          onChange={(event) =>
            setPin2(event.currentTarget.value.replace(/[^0-9]/gu, ''))
          }
        />
      </SimpleGrid>
      {isLastOwner ? (
        <Paper p="sm" bg="var(--mantine-color-warning-subtle)">
          <Text size="sm" fw={500}>
            {t('office.staff.last_owner')}
          </Text>
          <Text size="sm">{t('office.staff.last_owner_hint')}</Text>
        </Paper>
      ) : null}
      <Box component="fieldset" style={{ border: 0, margin: 0, padding: 0 }}>
        <Group justify="space-between" gap="sm" mb={4}>
          <Text component="legend" size="sm">
            {t('office.staff.permissions')}
          </Text>
          <Button
            type="button"
            variant="transparent"
            size="compact-sm"
            onClick={() => setOverrides({})}
          >
            {t('office.staff.reset_permissions')}
          </Button>
        </Group>
        <ScrollArea.Autosize mah={256}>
          <Paper withBorder p="xs">
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing={4}>
              {PERMISSIONS.map((permission) => (
                <Checkbox
                  key={permission}
                  size="sm"
                  checked={checked(permission)}
                  onChange={(event) =>
                    toggle(permission, event.currentTarget.checked)
                  }
                  label={
                    <Group gap={6} wrap="nowrap">
                      <Text size="sm" style={{ flex: 1, minWidth: 0 }}>
                        {t(
                          `office.staff.perm_${permission.replaceAll('.', '_')}`,
                        )}
                      </Text>
                      {overrides[permission] !== undefined ? (
                        <Text size="xs" c="dimmed">
                          {t('office.staff.override')}
                        </Text>
                      ) : null}
                    </Group>
                  }
                />
              ))}
            </SimpleGrid>
          </Paper>
        </ScrollArea.Autosize>
      </Box>
      <Group justify="flex-end" gap="sm">
        <Button
          type="button"
          variant="default"
          onClick={() => onOpenChange(false)}
        >
          {t('common.cancel')}
        </Button>
        <Button
          type="button"
          disabled={pending || name.trim() === '' || readOnly}
          loading={pending}
          onClick={() => void save()}
        >
          {t('office.staff.save')}
        </Button>
      </Group>
    </Modal>
  );
}
