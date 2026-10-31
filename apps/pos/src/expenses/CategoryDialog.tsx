import { Button, Group, SimpleGrid, Stack, TextInput } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../components/Toast.tsx';
import { getDb } from '../data/db.ts';
import { createExpenseCategory } from '../data/expenses.ts';
import { Modal } from '../sell/Modal.tsx';
import { useCurrentStaff } from '../state/currentStaff.ts';

/** Owner-only `+ Category` for expenses (screens/14). */
export function CategoryDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { staff } = useCurrentStaff();
  const [name, setName] = useState('');
  const [nameUr, setNameUr] = useState('');
  const [pending, setPending] = useState(false);
  const save = async () => {
    if (name.trim() === '' || pending) return;
    setPending(true);
    try {
      await createExpenseCategory(getDb(), { name, nameUr }, staff?.id ?? null);
      toast.push(t('office.expenses.category_saved'));
      onSaved?.();
      setName('');
      setNameUr('');
      onOpenChange(false);
    } catch (err) {
      toast.push(
        err instanceof Error
          ? t('office.expenses.category_exists')
          : t('errors.generic'),
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
      title={t('office.expenses.category_add')}
    >
      <Stack gap="sm">
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          <TextInput
            label={t('office.expenses.category_name')}
            maxLength={40}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <TextInput
            label={t('office.expenses.category_name_ur')}
            maxLength={40}
            value={nameUr}
            onChange={(event) => setNameUr(event.currentTarget.value)}
          />
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
            {t('office.expenses.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
