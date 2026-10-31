import type { MasterRow } from '@bikri/db';
import {
  Box,
  Button,
  Group,
  SimpleGrid,
  Stack,
  TextInput,
} from '@mantine/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoneyInput } from '../components/MoneyInput.tsx';
import { PhoneInput } from '../components/PhoneInput.tsx';
import { useToast } from '../components/Toast.tsx';
import { ledgerContext } from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import { createSupplier, updateSupplier } from '../data/suppliers.ts';
import { Modal } from '../sell/Modal.tsx';
import { useCurrentStaff } from '../state/currentStaff.ts';

/** New / edit supplier (screens/13). */
export function SupplierDialog({
  open,
  onOpenChange,
  supplier,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  supplier?: MasterRow | null;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { staff } = useCurrentStaff();
  const editing = supplier ?? null;
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [note, setNote] = useState('');
  const [opening, setOpening] = useState<number | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(editing ? String(editing.name) : '');
    setPhone(editing ? String(editing.phone ?? '') : '');
    setAddress(editing ? String(editing.address ?? '') : '');
    setNote(editing ? String(editing.note ?? '') : '');
    setOpening(null);
    setPending(false);
  }, [open, editing]);

  const save = async () => {
    if (name.trim() === '' || pending) return;
    setPending(true);
    try {
      const db = getDb();
      const ctx = await ledgerContext(db, staff?.id ?? '');
      if (editing)
        await updateSupplier(
          db,
          editing.id,
          { name, phone, address, note },
          staff?.id ?? null,
        );
      else
        await createSupplier(
          db,
          { name, phone, address, note, opening: opening ?? 0 },
          ctx,
          staff?.id ?? null,
        );
      toast.push(
        editing
          ? t('office.suppliers.supplier_saved')
          : t('office.suppliers.supplier_added'),
      );
      onOpenChange(false);
    } catch (err) {
      toast.push(
        err instanceof Error ? err.message : t('errors.generic'),
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
      title={
        editing
          ? t('office.suppliers.edit_supplier')
          : t('office.suppliers.new_supplier')
      }
    >
      <Stack gap="sm">
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          <Box style={{ gridColumn: '1 / -1' }}>
            <TextInput
              label={t('office.suppliers.name')}
              maxLength={60}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </Box>
          <PhoneInput
            label={t('office.suppliers.phone')}
            value={phone}
            onChange={(next) => setPhone(next ?? '')}
          />
          <TextInput
            label={t('office.suppliers.address')}
            maxLength={120}
            value={address}
            onChange={(event) => setAddress(event.currentTarget.value)}
          />
          <Box style={{ gridColumn: '1 / -1' }}>
            <TextInput
              label={t('office.suppliers.note')}
              maxLength={200}
              value={note}
              onChange={(event) => setNote(event.currentTarget.value)}
            />
          </Box>
          {!editing ? (
            <MoneyInput
              label={t('office.suppliers.opening_balance')}
              value={opening}
              onChange={setOpening}
            />
          ) : null}
        </SimpleGrid>
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
            disabled={name.trim() === '' || pending}
            loading={pending}
            onClick={() => void save()}
          >
            {t('office.suppliers.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
