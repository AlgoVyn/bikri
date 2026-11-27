import type { Cart } from '@bikri/db';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { DateField } from '../components/DateField.tsx';
import { DialogFooter } from '../components/DialogFooter.tsx';
import { Modal } from '../components/Modal.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { useAreaStrings } from '../i18n/areas.tsx';
import { useHotkey } from '../lib/hotkeys.ts';

export function QuoteDialog({
  open,
  onOpenChange,
  cart,
  total,
  itemCount,
  customerName,
  defaultValidUntil,
  minDate,
  maxDate,
  defaultTerms,
  editing,
  saving,
  onSave,
  onCustomer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cart: Cart;
  total: number;
  itemCount: number;
  customerName: string;
  defaultValidUntil: string;
  minDate: string;
  maxDate: string;
  defaultTerms: string;
  editing: boolean;
  saving?: boolean;
  onSave: (input: { validUntil: string; terms: string }) => void;
  onCustomer: () => void;
}) {
  const { t } = useTranslation();
  const officeReady = useAreaStrings('office');
  const [validUntil, setValidUntil] = useState(defaultValidUntil);
  const [terms, setTerms] = useState(defaultTerms);

  useEffect(() => {
    if (!open) return;
    setValidUntil(defaultValidUntil);
    setTerms(defaultTerms);
  }, [open, defaultValidUntil, defaultTerms]);

  useHotkey(
    (event) =>
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      event.key.toLowerCase() === 's',
    () => {
      if (validUntil) onSave({ validUntil, terms });
    },
    { enabled: open, inFields: true, inDialog: true },
  );

  if (!officeReady) return null;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={
        editing
          ? t('office.quotations.update_title')
          : t('office.quotations.save_title')
      }
      description={t('office.quotations.save_hint')}
      sheet
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (validUntil) onSave({ validUntil, terms });
        }}
      >
        <div className="rounded-control border border-divider bg-surface-2/60 px-3 py-2 text-small">
          <div className="flex items-center justify-between gap-2">
            <span>
              <span className="text-text-muted">
                {t('office.quotations.customer')}:{' '}
              </span>
              {cart.customer_id
                ? customerName || t('office.quotations.customer_selected')
                : t('sell.walk_in')}
            </span>
            <button
              type="button"
              className="min-h-11 px-2 text-primary"
              onClick={onCustomer}
            >
              {t('sell.change_customer')}
            </button>
          </div>
        </div>
        <DateField
          label={t('office.quotations.valid_until')}
          value={validUntil}
          min={minDate}
          max={maxDate}
          onChange={setValidUntil}
        />
        <p className="-mt-2 text-caption text-text-muted">
          {t('office.quotations.valid_until_hint')}
        </p>
        <label className="flex flex-col gap-1 text-small">
          <span>{t('office.quotations.terms_label')}</span>
          <textarea
            className="min-h-24 w-full rounded-control border border-border-strong bg-surface px-3 py-2"
            maxLength={500}
            value={terms}
            placeholder={t('office.quotations.terms_placeholder')}
            onChange={(event) => setTerms(event.target.value)}
          />
        </label>
        <div className="flex items-center justify-between rounded-control border border-divider bg-surface-2/60 px-3 py-2 text-small">
          <span>{t('office.quotations.items', { count: itemCount })}</span>
          <b className="text-title">
            <MoneyText paisa={total} />
          </b>
        </div>
        <DialogFooter>
          <button
            type="button"
            className={buttonQuiet}
            onClick={() => onOpenChange(false)}
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            data-testid="save-quote-dialog"
            className={buttonPrimary}
            disabled={saving || validUntil.length === 0}
          >
            {editing
              ? t('office.quotations.update')
              : t('office.quotations.save')}
          </button>
        </DialogFooter>
      </form>
    </Modal>
  );
}
