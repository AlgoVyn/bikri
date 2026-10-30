import type { MasterRow } from '@bikri/db';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { MoneyText } from '../components/MoneyText.tsx';
import { useToast } from '../components/Toast.tsx';
import { addProduct, CartFullError } from '../data/cart.ts';
import { getDb } from '../data/db.ts';
import {
  type PriceCheckResult,
  priceCard,
  priceCheck,
} from '../data/priceCheck.ts';
import { marginText, qtyWithUnit } from '../products/format.ts';
import { ProductThumb } from '../products/ProductThumb.tsx';
import { Modal } from '../sell/Modal.tsx';
import { useSellStore } from '../sell/sellStore.ts';
import { mutateCart, useShopMoney } from '../sell/useSell.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { usePriceCheck } from './priceCheckStore.ts';

/** Price check (screens/18): look up a price by scan or name; reads only. */
export function PriceCheck() {
  const open = usePriceCheck((s) => s.open);
  const setOpen = usePriceCheck((s) => s.setOpen);
  const { t } = useTranslation();
  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      title={t('pricecheck.title')}
      wide
    >
      {open ? <PriceCheckBody onClose={() => setOpen(false)} /> : null}
    </Modal>
  );
}

function PriceCheckBody({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { can } = useCurrentStaff();
  const money = useShopMoney();
  const active = useSellStore((s) => s.active);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState<{
    q: string;
    result: PriceCheckResult;
  } | null>(null);
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Typed names search as you type; scanners still commit on Enter. A stale response is
  // dropped through the sequence number so fast typing never flashes an old card.
  useEffect(() => {
    const q = query.trim();
    if (q === '') {
      setShown(null);
      setSearching(false);
      return;
    }
    if (q.length < 2) {
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      seq.current += 1;
      const mine = seq.current;
      void priceCheck(getDb(), q)
        .then((result) => {
          if (mine !== seq.current) return;
          setShown({ q, result });
        })
        .finally(() => {
          if (mine === seq.current) setSearching(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const lookup = async (q: string) => {
    seq.current += 1;
    const mine = seq.current;
    const result = await priceCheck(getDb(), q);
    if (mine !== seq.current) return;
    setShown({ q: q.trim(), result });
    inputRef.current?.select();
  };

  const pick = async (product: MasterRow) => {
    seq.current += 1;
    const card = await priceCard(getDb(), product);
    setShown({ q: query.trim(), result: { kind: 'found', card } });
    inputRef.current?.focus();
    inputRef.current?.select();
  };

  const card = shown?.result.kind === 'found' ? shown.result.card : null;
  const canSell = can('sale.create');

  const addToCart = async () => {
    if (!card) return;
    try {
      await mutateCart(active, (c) =>
        addProduct(c, card.product, 1000, money.cost_method),
      );
      toast.push(
        t('pricecheck.added', { name: String(card.product.name_en) }),
        'info',
      );
      onClose();
    } catch (error) {
      if (error instanceof CartFullError)
        toast.push(t('sell.cart_full'), 'error');
      else throw error;
    }
  };

  const scanAnother = () => {
    seq.current += 1;
    setQuery('');
    setShown(null);
    inputRef.current?.focus();
  };

  const product = card?.product;
  const unit = String(product?.unit ?? 'pc');
  const price = Number(product?.price ?? 0);
  const avg = Number(product?.avg_cost ?? 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor={inputId} className="font-medium">
          {t('pricecheck.search')}
        </label>
        <input
          ref={inputRef}
          id={inputId}
          type="search"
          autoComplete="off"
          enterKeyHint="search"
          className="h-14 rounded-control border border-border-strong bg-surface px-3 text-title"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (card && shown?.q === query.trim() && canSell) void addToCart();
            else void lookup(query);
          }}
        />
      </div>

      {query.trim() !== '' && shown?.q !== query.trim() ? (
        <p className="text-small text-text-muted" role="status">
          {searching ? t('common.loading') : t('pricecheck.press_enter')}
        </p>
      ) : null}

      {shown?.result.kind === 'none' ? (
        <div role="status" className="flex flex-col items-start gap-2">
          <p className="text-title">{t('pricecheck.not_found')}</p>
          {can('catalog.edit') ? (
            <Link
              to="/products/new"
              search={/^\d{4,}$/u.test(shown.q) ? { barcode: shown.q } : {}}
              className={buttonPrimary}
              onClick={onClose}
            >
              {t('pricecheck.add_product')}
            </Link>
          ) : null}
        </div>
      ) : null}

      {shown?.result.kind === 'matches' ? (
        <ul
          aria-label={t('pricecheck.matches')}
          className="flex flex-col gap-1"
        >
          {shown.result.products.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="flex min-h-11 w-full items-center justify-between gap-2 rounded-control border border-border px-3 text-start"
                onClick={() => void pick(p)}
              >
                <span className="ltr-name">{String(p.name_en)}</span>
                <MoneyText paisa={Number(p.price ?? 0)} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {card && product ? (
        <section
          aria-label={String(product.name_en)}
          data-testid="price-card"
          className="flex gap-4 rounded-card border border-border p-4"
        >
          <ProductThumb
            name={String(product.name_en)}
            imageKey={product.image_key}
            color={product.color}
            size="lg"
          />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <p className="text-title font-semibold">
              {String(product.name_en)}
            </p>
            {product.name_ur ? (
              <p lang="ur" dir="rtl" className="text-title">
                {String(product.name_ur)}
              </p>
            ) : null}
            <p className="text-price font-bold" data-testid="price-card-price">
              <MoneyText paisa={price} />
            </p>
            {card.onHandMilli === null ? null : (
              <p
                data-testid="price-card-stock"
                className={card.onHandMilli > 0 ? '' : 'text-danger'}
              >
                {card.onHandMilli > 0
                  ? t('pricecheck.in_stock', {
                      qty: qtyWithUnit(t, card.onHandMilli, unit),
                    })
                  : t('pricecheck.out_of_stock')}
              </p>
            )}
            {card.barcodes.length > 0 ? (
              <p className="text-small text-text-muted">
                {t('pricecheck.barcodes')}{' '}
                <bdi dir="ltr">{card.barcodes.join(', ')}</bdi>
              </p>
            ) : null}
            {can('cost.view') ? (
              <p
                className="text-small text-text-muted"
                data-testid="price-card-cost"
              >
                {t('pricecheck.cost')} <MoneyText paisa={avg} /> ·{' '}
                {t('pricecheck.margin')}{' '}
                <bdi dir="ltr">{marginText(price, avg) ?? '—'}</bdi>
              </p>
            ) : null}
          </div>
        </section>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={buttonQuiet} onClick={onClose}>
          {t('pricecheck.close')}
        </button>
        {shown ? (
          <button type="button" className={buttonQuiet} onClick={scanAnother}>
            {t('pricecheck.scan_another')}
          </button>
        ) : null}
        {card && canSell ? (
          <button
            type="button"
            className={buttonPrimary}
            onClick={() => void addToCart()}
          >
            {t('pricecheck.add_to_cart')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
