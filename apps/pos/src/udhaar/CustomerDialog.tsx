import type { MasterRow } from '@bikri/db';
import {
  Box,
  Button,
  Checkbox,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { MoneyInput } from '../components/MoneyInput.tsx';
import { PhoneInput } from '../components/PhoneInput.tsx';
import { useToast } from '../components/Toast.tsx';
import { ledgerContext } from '../data/catalog.ts';
import {
  CustomerBalanceError,
  createCustomerAccount,
  customerBalance,
  DuplicatePhoneError,
  deleteCustomer,
  updateCustomer,
} from '../data/customers.ts';
import { getDb } from '../data/db.ts';
import { Modal } from '../sell/Modal.tsx';
import { useCurrentStaff } from '../state/currentStaff.ts';

type Duplicate = { id: string; name: string };

/** New / edit customer (screens/12). */
export function CustomerDialog({
  open,
  onOpenChange,
  customer,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customer?: MasterRow | null;
  onSaved?: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { staff, role, can } = useCurrentStaff();
  const editing = customer ?? null;
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [note, setNote] = useState('');
  const [limit, setLimit] = useState<number | null>(null);
  const [hard, setHard] = useState(false);
  const [opening, setOpening] = useState<number | null>(null);
  const [duplicate, setDuplicate] = useState<Duplicate | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, setPending] = useState(false);
  const balance = useLiveQuery(
    () => (editing ? customerBalance(getDb(), editing.id) : 0),
    [editing?.id],
  );

  useEffect(() => {
    if (!open) return;
    setName(editing ? String(editing.name) : '');
    setPhone(editing ? String(editing.phone ?? '') : '');
    setAddress(editing ? String(editing.address ?? '') : '');
    setNote(editing ? String(editing.note ?? '') : '');
    setLimit(
      editing &&
        editing.credit_limit !== null &&
        editing.credit_limit !== undefined
        ? Number(editing.credit_limit)
        : null,
    );
    setHard(Number(editing?.hard_limit ?? 0) === 1);
    setOpening(null);
    setDuplicate(null);
    setPending(false);
  }, [open, editing]);

  const save = async () => {
    if (name.trim() === '' || pending) return;
    setPending(true);
    setDuplicate(null);
    try {
      const db = getDb();
      const ctx = await ledgerContext(db, staff?.id ?? '');
      const fields = {
        name,
        phone,
        address,
        note,
        // 05 §6: cashiers may create a customer but never set or change a credit limit.
        ...(role === 'cashier'
          ? editing
            ? {
                credit_limit:
                  editing.credit_limit == null
                    ? null
                    : Number(editing.credit_limit),
                hard_limit: Number(editing.hard_limit ?? 0) === 1,
              }
            : {}
          : {
              credit_limit: limit ?? null,
              // Only an owner may change the hard limit; a manager's edit preserves it.
              hard_limit:
                role === 'owner'
                  ? hard
                  : Number(editing?.hard_limit ?? 0) === 1,
            }),
      };
      if (editing) await updateCustomer(db, editing.id, fields, ctx);
      else
        await createCustomerAccount(
          db,
          { ...fields, opening: opening ?? 0 },
          ctx,
          staff?.id ?? null,
        );
      toast.push(
        editing
          ? t('office.udhaar.customer_saved')
          : t('office.udhaar.customer_added'),
      );
      onSaved?.();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof DuplicatePhoneError)
        setDuplicate({ id: err.ownerId, name: err.ownerName });
      else
        toast.push(
          err instanceof Error ? err.message : t('errors.generic'),
          'error',
        );
    } finally {
      setPending(false);
    }
  };

  const remove = async () => {
    if (!editing) return;
    try {
      const db = getDb();
      await deleteCustomer(db, editing.id, staff?.id ?? null);
      toast.push(t('office.udhaar.customer_deleted'));
      onOpenChange(false);
    } catch (err) {
      toast.push(
        err instanceof CustomerBalanceError
          ? t('office.udhaar.delete_balance')
          : t('errors.generic'),
        'error',
      );
    }
  };

  const canDelete =
    editing !== null && can('party.delete') && (balance ?? 0) === 0;

  return (
    <>
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title={
          editing
            ? t('office.udhaar.edit_customer')
            : t('office.udhaar.new_customer')
        }
      >
        <Stack gap="sm">
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <Box style={{ gridColumn: '1 / -1' }}>
              <TextInput
                label={t('office.udhaar.name')}
                value={name}
                maxLength={60}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </Box>
            <PhoneInput
              label={t('office.udhaar.phone')}
              value={phone}
              onChange={(next) => setPhone(next ?? '')}
            />
            <TextInput
              label={t('office.udhaar.address')}
              value={address}
              maxLength={120}
              onChange={(event) => setAddress(event.currentTarget.value)}
            />
            <Box style={{ gridColumn: '1 / -1' }}>
              <TextInput
                label={t('office.udhaar.note')}
                value={note}
                maxLength={200}
                onChange={(event) => setNote(event.currentTarget.value)}
              />
            </Box>
            {role !== 'cashier' ? (
              <MoneyInput
                label={t('office.udhaar.credit_limit')}
                value={limit}
                onChange={setLimit}
              />
            ) : null}
            {role === 'owner' ? (
              <Checkbox
                label={t('office.udhaar.hard_limit')}
                checked={hard}
                onChange={(event) => setHard(event.currentTarget.checked)}
                style={{ alignSelf: 'end', marginBottom: 10 }}
              />
            ) : null}
            {!editing ? (
              <MoneyInput
                label={t('office.udhaar.opening_balance')}
                value={opening}
                onChange={setOpening}
              />
            ) : null}
          </SimpleGrid>
          <Text size="sm" c="dimmed">
            {t('office.udhaar.credit_hint')}
          </Text>
          {duplicate ? (
            <Paper p="sm" bg="var(--mantine-color-warning-subtle)">
              <Text
                role="alert"
                size="sm"
                c="var(--mantine-color-warning-subtle-ink)"
              >
                {t('office.udhaar.duplicate_phone', {
                  name: duplicate.name,
                })}{' '}
                <Link
                  to="/udhaar/$customerId"
                  params={{ customerId: duplicate.id }}
                  className="bikri-link"
                >
                  {t('office.udhaar.open_existing')}
                </Link>
              </Text>
            </Paper>
          ) : null}
          <Group justify="space-between" gap="sm">
            <Box>
              {canDelete ? (
                <Button
                  type="button"
                  color="danger"
                  onClick={() => setConfirmDelete(true)}
                >
                  {t('office.udhaar.delete')}
                </Button>
              ) : null}
            </Box>
            <Group gap="sm">
              <Button
                type="button"
                variant="default"
                onClick={() => onOpenChange(false)}
              >
                {t('common.cancel')}
              </Button>
              <Button
                type="button"
                disabled={name.trim() === '' || pending}
                loading={pending}
                onClick={() => void save()}
              >
                {t('office.udhaar.save')}
              </Button>
            </Group>
          </Group>
        </Stack>
      </Modal>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('office.udhaar.delete_title', { name: editing?.name ?? '' })}
        body={t('office.udhaar.delete_body')}
        confirmLabel={t('office.udhaar.delete')}
        onConfirm={() => void remove()}
      />
    </>
  );
}
