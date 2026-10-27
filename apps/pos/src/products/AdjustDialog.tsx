import { formatQtyFromMilli, type QtyUnit } from '@bikri/core';
import type { MasterRow } from '@bikri/db';
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
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
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div
          role="tablist"
          aria-label={t('adjust.kind')}
          className="grid grid-cols-2 gap-1 sm:grid-cols-4"
        >
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={kind === k}
              className={`${buttonQuiet} ${kind === k ? 'border-primary bg-primary-subtle font-semibold' : ''}`}
              onClick={() => pickKind(k)}
            >
              {t(`adjust.kind_${k}`)}
            </button>
          ))}
        </div>
        {reasons.length > 0 ? (
          <label className="flex flex-col gap-1" htmlFor={reasonId}>
            <span className="text-small font-medium">{t('adjust.reason')}</span>
            <select
              id={reasonId}
              className="h-11 rounded-control border border-border-strong bg-surface px-2"
              value={reason}
              onChange={(e) => setReason(e.target.value as AdjustReason)}
            >
              {reasons.map((r) => (
                <option key={r} value={r}>
                  {t(`stock.reason.${r}`)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {kind === 'fix' ? (
          <fieldset className="flex gap-2">
            <legend className="sr-only">{t('adjust.direction')}</legend>
            {[false, true].map((m) => (
              <label
                key={String(m)}
                className={`${buttonQuiet} gap-2 ${minus === m ? 'border-primary' : ''}`}
              >
                <input
                  type="radio"
                  name="dir"
                  checked={minus === m}
                  onChange={() => setMinus(m)}
                />
                {t(m ? 'adjust.remove' : 'adjust.add')}
              </label>
            ))}
          </fieldset>
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
        <label className="flex flex-col gap-1" htmlFor={noteId}>
          <span className="text-small font-medium">
            {needsNote(effectiveReason)
              ? t('adjust.note_required')
              : t('adjust.note')}
          </span>
          <input
            id={noteId}
            className="h-11 rounded-control border border-border-strong bg-surface px-3"
            maxLength={NOTE_MAX}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <p data-testid="adjust-new" className="font-medium">
          {t('adjust.new_on_hand', {
            qty: qtyWithUnit(t, onHand + delta, unit),
          })}{' '}
          {delta !== 0 ? (
            <bdi dir="ltr" className="text-text-muted">
              ({delta > 0 ? '+' : '−'}
              {formatQtyFromMilli(Math.abs(delta), unit)})
            </bdi>
          ) : null}
        </p>
        {kind === 'in' && can('purchase.create') ? (
          <p className="text-small text-text-muted">
            {t('adjust.delivery_hint')}{' '}
            <Link to="/suppliers" className="text-primary underline">
              {t('adjust.record_delivery')}
            </Link>
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-danger">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonQuiet} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className={buttonPrimary}
            disabled={saving || qty === null}
          >
            {t('form.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
