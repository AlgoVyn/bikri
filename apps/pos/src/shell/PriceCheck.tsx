import type { MasterRow } from '@bikri/db';
import {
  Box,
  Button,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
    <Stack gap="md">
      <TextInput
        ref={inputRef}
        id={inputId}
        data-autofocus
        type="search"
        autoComplete="off"
        enterKeyHint="search"
        label={t('pricecheck.search')}
        size="lg"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          if (card && shown?.q === query.trim() && canSell) void addToCart();
          else void lookup(query);
        }}
      />

      {query.trim() !== '' && shown?.q !== query.trim() ? (
        <Text size="sm" c="dimmed" role="status">
          {searching ? t('common.loading') : t('pricecheck.press_enter')}
        </Text>
      ) : null}

      {shown?.result.kind === 'none' ? (
        <Stack gap="sm" role="status">
          <Text fz="lg">{t('pricecheck.not_found')}</Text>
          {can('catalog.edit') ? (
            <Link
              to="/products/new"
              search={/^\d{4,}$/u.test(shown.q) ? { barcode: shown.q } : {}}
              style={{ textDecoration: 'none', alignSelf: 'flex-start' }}
              onClick={onClose}
            >
              <Button component="span">{t('pricecheck.add_product')}</Button>
            </Link>
          ) : null}
        </Stack>
      ) : null}

      {shown?.result.kind === 'matches' ? (
        <Box
          component="ul"
          aria-label={t('pricecheck.matches')}
          style={{ listStyle: 'none', margin: 0, padding: 0 }}
        >
          {shown.result.products.map((p) => (
            <Box component="li" key={p.id}>
              <Button
                type="button"
                variant="default"
                fullWidth
                justify="space-between"
                mb={4}
                onClick={() => void pick(p)}
              >
                <Text component="span" size="sm" className="ltr-name">
                  {String(p.name_en)}
                </Text>
                <MoneyText paisa={Number(p.price ?? 0)} />
              </Button>
            </Box>
          ))}
        </Box>
      ) : null}

      {card && product ? (
        <Paper
          component="section"
          withBorder
          p="md"
          aria-label={String(product.name_en)}
          data-testid="price-card"
        >
          <Group align="flex-start" gap="md" wrap="nowrap">
            <ProductThumb
              name={String(product.name_en)}
              imageKey={product.image_key}
              color={product.color}
              size="lg"
            />
            <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
              <Text fz="lg" fw={600}>
                {String(product.name_en)}
              </Text>
              {product.name_ur ? (
                <Text lang="ur" dir="rtl" fz="lg">
                  {String(product.name_ur)}
                </Text>
              ) : null}
              <Text fz={28} fw={700} data-testid="price-card-price">
                <MoneyText paisa={price} />
              </Text>
              {card.onHandMilli === null ? null : (
                <Text
                  size="sm"
                  c={card.onHandMilli > 0 ? undefined : 'danger'}
                  data-testid="price-card-stock"
                >
                  {card.onHandMilli > 0
                    ? t('pricecheck.in_stock', {
                        qty: qtyWithUnit(t, card.onHandMilli, unit),
                      })
                    : t('pricecheck.out_of_stock')}
                </Text>
              )}
              {card.barcodes.length > 0 ? (
                <Text size="sm" c="dimmed">
                  {t('pricecheck.barcodes')}{' '}
                  <Text component="bdi" dir="ltr" inherit>
                    {card.barcodes.join(', ')}
                  </Text>
                </Text>
              ) : null}
              {can('cost.view') ? (
                <Text size="sm" c="dimmed" data-testid="price-card-cost">
                  {t('pricecheck.cost')} <MoneyText paisa={avg} /> ·{' '}
                  {t('pricecheck.margin')}{' '}
                  <Text component="bdi" dir="ltr" inherit>
                    {marginText(price, avg) ?? '—'}
                  </Text>
                </Text>
              ) : null}
            </Stack>
          </Group>
        </Paper>
      ) : null}

      <Group justify="flex-end" gap="sm">
        <Button type="button" variant="default" onClick={onClose}>
          {t('pricecheck.close')}
        </Button>
        {shown ? (
          <Button type="button" variant="default" onClick={scanAnother}>
            {t('pricecheck.scan_another')}
          </Button>
        ) : null}
        {card && canSell ? (
          <Button type="button" onClick={() => void addToCart()}>
            {t('pricecheck.add_to_cart')}
          </Button>
        ) : null}
      </Group>
    </Stack>
  );
}
