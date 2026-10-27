import { hashPin, type PinHash } from '@bikri/core';
import {
  type BikriDb,
  EXPENSE_CATEGORY_TEMPLATES,
  type MasterRow,
} from '@bikri/db';
import { getKv, setKv } from './kv.ts';
import { defaultBranch, deviceInfo } from './localTenant.ts';
import { createProduct, type NewProduct } from './products.ts';
import { writeAction } from './write.ts';

export const BUSINESS_TYPES = [
  'electronics',
  'mobile',
  'grocery',
  'general',
  'pharmacy',
  'clothing',
  'bakery',
  'hardware',
  'other',
] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];
export const ROUND_OPTIONS = [1, 100, 500, 1000] as const;
export const DEFAULT_FOOTER = 'Shukriya! Phir tashreef laiye.';

export type LogoData = {
  /** PNG of the resized logo (≤ 576 px wide). */
  png: Blob;
  sha256: string;
  /** Gray bitmap for the printer (`kv.logo_bitmap`). */
  bitmap: { width: number; height: number; data: Uint8Array; format: 'gray' };
};

export type SetupInput = {
  shop: {
    name: string;
    business_type: BusinessType;
    phone: string;
    address: string;
    city: string;
    ntn: string;
    strn: string;
  };
  owner: { name: string; pin: string };
  receipt: {
    header: string;
    footer: string;
    tax_rate_bp: number;
    inclusive: boolean;
    round_total_to: (typeof ROUND_OPTIONS)[number];
  };
  product: NewProduct | null;
};

/** Wizard progress kept across a refresh (`kv.setup_draft`). Never holds the PIN. */
export type SetupDraft = {
  step: number;
  shop: SetupInput['shop'];
  owner: { name: string };
  receipt: SetupInput['receipt'];
};

export class SetupAlreadyDoneError extends Error {
  constructor() {
    super('this shop is already set up');
    this.name = 'SetupAlreadyDoneError';
  }
}

export async function isSetupDone(db: BikriDb): Promise<boolean> {
  const shop = await db.shop.get('shop');
  return Boolean(shop?.setup_completed_at);
}

export function loadSetupDraft(db: BikriDb): Promise<SetupDraft | null> {
  return getKv<SetupDraft | null>(db, 'setup_draft', null);
}

export function saveSetupDraft(db: BikriDb, draft: SetupDraft): Promise<void> {
  return setKv(db, 'setup_draft', draft);
}

export type SetupResult = { owner: MasterRow; product: MasterRow | null };

/**
 * screens/01 Finish: one Dexie transaction + outbox — shop (setup_completed_at), an upsert of
 * the existing default branch, the owner staff row, missing expense categories, and the
 * optional first product with its opening stock. PIN hashing runs before the transaction.
 */
export async function finishSetup(
  db: BikriDb,
  input: SetupInput,
  options: { now?: number; logo?: LogoData | null; pinHash?: PinHash } = {},
): Promise<SetupResult> {
  const now = options.now ?? Date.now();
  const pin = options.pinHash ?? (await hashPin(input.owner.pin));
  const branch = await defaultBranch(db);
  const device = await deviceInfo(db);
  if (!branch || !device) throw new Error('enrol this till first');
  const logo = options.logo ?? null;
  const logoKey = logo ? `shop/logo-${logo.sha256}.png` : null;

  const result = await writeAction(
    db,
    async (w) => {
      if (await w.table('shop').get('shop')) throw new SetupAlreadyDoneError();
      const owner = await w.create('staff', {
        name: input.owner.name.trim(),
        role: 'owner',
        ...pin,
        pin_length: input.owner.pin.length,
        max_discount_bp: 10000,
        permissions_json: '{}',
        color: 'c1',
        must_change_pin: 0,
        active: 1,
      });
      await w.create('shop', {
        id: 'shop',
        name: input.shop.name.trim(),
        business_type: input.shop.business_type,
        phone: input.shop.phone,
        address: input.shop.address.trim(),
        city: input.shop.city.trim(),
        ntn: input.shop.ntn.trim(),
        strn: input.shop.strn.trim(),
        currency: 'PKR',
        timezone: 'Asia/Karachi',
        receipt_header: input.receipt.header.trim(),
        receipt_footer: input.receipt.footer.trim(),
        tax_rate_bp: input.receipt.tax_rate_bp,
        tax_label: 'Sales tax',
        tax_mode:
          input.receipt.tax_rate_bp > 0 && input.receipt.inclusive
            ? 'inclusive'
            : 'exclusive',
        round_total_to: input.receipt.round_total_to,
        logo_key: logoKey,
        setup_completed_at: now,
      });
      await w.update('branches', branch.id, {
        address: input.shop.address.trim(),
        phone: input.shop.phone,
      });
      const existing = new Set(
        (await w.table('expense_categories').toArray()).map((c) =>
          String(c.code),
        ),
      );
      for (const tpl of EXPENSE_CATEGORY_TEMPLATES) {
        if (existing.has(tpl.code)) continue;
        await w.create('expense_categories', {
          id: tpl.code,
          ...tpl,
          is_system: 1,
        });
      }
      const product = input.product
        ? await createProduct(w, input.product, {
            branch_id: branch.id,
            device_id: device.id,
            staff_id: owner.id,
          })
        : null;
      if (logo) {
        await w.table('file_queue').add({
          kind: 'logo',
          target_id: 'shop',
          blob: logo.png,
          sha256: logo.sha256,
          status: 'pending',
        } as never);
        await w
          .table('kv')
          .put({ key: 'logo_bitmap', value: logo.bitmap } as never);
      }
      await w.table('kv').delete('setup_draft');
      return { owner, product };
    },
    { now, actor: null },
  );
  return result;
}
