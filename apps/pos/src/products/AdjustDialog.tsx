import { formatQtyFromMilli, type QtyUnit } from '@bikri/core';
import type { MasterRow } from '@bikri/db';
import {
  Box,
  Button,
  Group,
  NativeSelect,
  Radio,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoneyInput } from '../components/MoneyInput.tsx';
import { QtyInput } from '../components/QtyInput.tsx';
import { useToast } from '../components/Toast.tsx';
import { ledgerContext } from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import {
  type AdjustKind,
  type AdjustReason,
  adjustDelta,
  adjustStock,
  IN_REASONS,
  NOTE_MAX,
  needsCost,
  needsNote,
  OUT_REASONS,
  StockAdjustError,
} from '../data/stock.ts';
import { Modal } from '../sell/Modal.tsx';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { qtyWithUnit } from './format.ts';

const KINDS: readonly AdjustKind[] = ['in', 'out', 'count', 'fix'];

/** Stock adjust (screens/09): In / Out / Count / Fix entry; writes one movement. */
export function AdjustDialog({
  product,
  onHand,
  open,
  onClose,
}: {
  product: MasterRow;
  onHand: number;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { staff, can } = useCurrentStaff();
  const unit = String(product.unit ?? 'pc') as QtyUnit;
  const [kind, setKind] = useState<AdjustKind>('in');
  const [reason, setReason] = useState<AdjustReason>('received_godown');
  const [qty, setQty] = useState<number | null>(null);
  const [minus, setMinus] = useState(false);
  const [cost, setCost] = useState<number | null>(
    Number(product.last_cost ?? 0) || null,
  );
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const noteId = useId();
  const reasonId = useId();

  const effectiveReason: string =
    kind === 'count' ? 'count' : kind === 'fix' ? 'entry_fix' : reason;
  const signed = kind === 'fix' && qty !== null ? (minus ? -qty : qty) : qty;
  const delta = signed === null ? 0 : adjustDelta(kind, signed, onHand);
  const pickKind = (k: AdjustKind) => {
    setKind(k);
    setError(null);
    if (k === 'in') setReason('received_godown');
    if (k === 'out') setReason('damaged');
  };

  const save = async () => {
    if (saving || signed === null) return;
    setSaving(true);
    setError(null);
    try {
      const ctx = await ledgerContext(getDb(), staff?.id ?? '');
      const m = await adjustStock(
        getDb(),
        {
          productId: product.id,
          kind,
          reason: kind === 'in' || kind === 'out' ? reason : undefined,
          qtyMilli: signed,
          unitCost: needsCost(effectiveReason) ? cost : null,
          note,
        },
        ctx,
      );
      toast.push(
        m
          ? t('adjust.saved', { qty: qtyWithUnit(t, onHand + delta, unit) })
          : t('adjust.no_change'),
        'info',
      );
      onClose();
    } catch (err) {
      setError(
        err instanceof StockAdjustError
          ? t(`adjust.err_${err.field}`)
          : t('adjust.err_product'),
      );
    } finally {
      setSaving(false);
    }
  };

  const reasons =
    kind === 'in' ? IN_REASONS : kind === 'out' ? OUT_REASONS : [];
  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={t('adjust.title', { name: String(product.name_en) })}
      description={t('adjust.on_hand', { qty: qtyWithUnit(t, onHand, unit) })}
    >
      <Box
        component="form"
        onSubmit={(event: React.FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <SimpleGrid
            cols={{ base: 2, sm: 4 }}
            spacing="xs"
            role="tablist"
            aria-label={t('adjust.kind')}
          >
            {KINDS.map((k) => (
              <Button
                key={k}
                type="button"
                role="tab"
                aria-selected={kind === k}
                variant={kind === k ? 'light' : 'default'}
                onClick={() => pickKind(k)}
              >
                {t(`adjust.kind_${k}`)}
              </Button>
            ))}
          </SimpleGrid>
          {reasons.length > 0 ? (
            <NativeSelect
              id={reasonId}
              label={t('adjust.reason')}
              value={reason}
              onChange={(event) =>
                setReason(event.currentTarget.value as AdjustReason)
              }
              data={reasons.map((r) => ({
                value: r,
                label: t(`stock.reason.${r}`),
              }))}
            />
          ) : null}
          {kind === 'fix' ? (
            <Radio.Group
              label={t('adjust.direction')}
              value={minus ? 'remove' : 'add'}
              onChange={(value) => setMinus(value === 'remove')}
            >
              <Group gap="sm" mt="xs">
                <Radio value="add" label={t('adjust.add')} />
                <Radio value="remove" label={t('adjust.remove')} />
              </Group>
            </Radio.Group>
          ) : null}
          <QtyInput
            label={kind === 'count' ? t('adjust.counted') : t('adjust.qty')}
            unit={unit}
            value={qty}
            onChange={setQty}
          />
          {needsCost(effectiveReason) ? (
            <MoneyInput
              label={t('adjust.unit_cost')}
              value={cost}
              onChange={setCost}
            />
          ) : null}
          <TextInput
            id={noteId}
            label={
              needsNote(effectiveReason)
                ? t('adjust.note_required')
                : t('adjust.note')
            }
            maxLength={NOTE_MAX}
            value={note}
            onChange={(event) => setNote(event.currentTarget.value)}
          />
          <Text fw={500} data-testid="adjust-new">
            {t('adjust.new_on_hand', {
              qty: qtyWithUnit(t, onHand + delta, unit),
            })}{' '}
            {delta !== 0 ? (
              <Text component="bdi" dir="ltr" c="dimmed" size="sm">
                ({delta > 0 ? '+' : '−'}
                {formatQtyFromMilli(Math.abs(delta), unit)})
              </Text>
            ) : null}
          </Text>
          {kind === 'in' && can('purchase.create') ? (
            <Text size="sm" c="dimmed">
              {t('adjust.delivery_hint')}{' '}
              <Link to="/suppliers" className="bikri-link">
                {t('adjust.record_delivery')}
              </Link>
            </Text>
          ) : null}
          {error ? (
            <Text c="danger" role="alert" size="sm">
              {error}
            </Text>
          ) : null}
          <Group justify="flex-end" gap="sm">
            <Button type="button" variant="default" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={saving || qty === null}
              loading={saving}
            >
              {t('form.save')}
            </Button>
          </Group>
        </Stack>
      </Box>
    </Modal>
  );
}
