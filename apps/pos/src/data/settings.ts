import {
  newId,
  PERMISSIONS,
  type Permission,
  type PinHash,
  type Role,
} from '@bikri/core';
import type { BikriDb, MasterRow, SyncedRow } from '@bikri/db';
import { csvCell } from '../lib/csv.ts';
import { deviceInfo } from './localTenant.ts';
import type { LogoData } from './setup.ts';
import { writeAction } from './write.ts';

const n = (value: unknown): number => Number(value ?? 0);

export const BUSINESS_TYPES = [
  'grocery',
  'general',
  'pharmacy',
  'clothing',
  'electronics',
  'mobile',
  'bakery',
  'hardware',
  'other',
] as const;

export class SettingsError extends Error {
  readonly code:
    | 'name'
    | 'phone'
    | 'tax'
    | 'prefix'
    | 'role'
    | 'pin'
    | 'last_owner'
    | 'discount';
  constructor(code: SettingsError['code']) {
    super(code);
    this.name = 'SettingsError';
    this.code = code;
  }
}

export type ShopSettings = {
  name: string;
  business_type: string;
  phone: string;
  address: string;
  city: string;
  ntn: string;
  strn: string;
  receipt_header: string;
  receipt_footer: string;
  tax_rate_bp: number;
  tax_mode: 'exclusive' | 'inclusive';
  tax_label: string;
  round_total_to: 1 | 100 | 500 | 1000;
  refund_rounding: 'nearest' | 'down' | 'none';
  receipt_language: 'app' | 'en' | 'ur';
  number_grouping: 'intl' | 'lakh';
  show_payment_details: boolean;
  show_cashier_on_receipt: boolean;
  show_you_saved: boolean;
  print_warranty: boolean;
};

export type ShopSettingsPatch = Partial<ShopSettings>;

const SHOP_FIELDS: (keyof ShopSettings)[] = [
  'name',
  'business_type',
  'phone',
  'address',
  'city',
  'ntn',
  'strn',
  'receipt_header',
  'receipt_footer',
  'tax_rate_bp',
  'tax_mode',
  'tax_label',
  'round_total_to',
  'refund_rounding',
  'receipt_language',
  'number_grouping',
  'show_payment_details',
  'show_cashier_on_receipt',
  'show_you_saved',
  'print_warranty',
];

function validationOf(patch: ShopSettingsPatch): void {
  if (patch.name !== undefined && patch.name.trim().length === 0)
    throw new SettingsError('name');
  if (
    patch.phone !== undefined &&
    patch.phone.trim() !== '' &&
    !/^\+?[0-9 -]{7,20}$/u.test(patch.phone.trim())
  )
    throw new SettingsError('phone');
  if (
    patch.tax_rate_bp !== undefined &&
    (!Number.isInteger(patch.tax_rate_bp) ||
      patch.tax_rate_bp < 0 ||
      patch.tax_rate_bp > 5000)
  )
    throw new SettingsError('tax');
}

function shopValues(row: SyncedRow | undefined): ShopSettings {
  return {
    name: String(row?.name ?? ''),
    business_type: String(row?.business_type ?? 'general'),
    phone: String(row?.phone ?? ''),
    address: String(row?.address ?? ''),
    city: String(row?.city ?? ''),
    ntn: String(row?.ntn ?? ''),
    strn: String(row?.strn ?? ''),
    receipt_header: String(row?.receipt_header ?? ''),
    receipt_footer: String(row?.receipt_footer ?? ''),
    tax_rate_bp: n(row?.tax_rate_bp),
    tax_mode: row?.tax_mode === 'inclusive' ? 'inclusive' : 'exclusive',
    tax_label: String(row?.tax_label ?? 'Sales tax'),
    round_total_to: (n(row?.round_total_to) || 100) as 1 | 100 | 500 | 1000,
    refund_rounding:
      row?.refund_rounding === 'down' || row?.refund_rounding === 'none'
        ? row.refund_rounding
        : 'nearest',
    receipt_language:
      row?.receipt_language === 'en' || row?.receipt_language === 'ur'
        ? row.receipt_language
        : 'app',
    number_grouping: row?.number_grouping === 'lakh' ? 'lakh' : 'intl',
    show_payment_details: row?.show_payment_details !== 0,
    show_cashier_on_receipt: row?.show_cashier_on_receipt !== 0,
    show_you_saved: row?.show_you_saved === 1,
    print_warranty: row?.print_warranty === 1,
  };
}

export function shopSettings(row: SyncedRow | undefined): ShopSettings {
  return shopValues(row);
}

/** Validated shop/receipt update with an audit row (screens/17). */
export async function updateShopSettings(
  db: BikriDb,
  patch: ShopSettingsPatch,
  actor: string | null,
  now = Date.now(),
): Promise<MasterRow> {
  validationOf(patch);
  const clean: Record<string, unknown> = {};
  for (const field of SHOP_FIELDS) {
    const value = patch[field];
    if (value === undefined) continue;
    clean[field] = typeof value === 'string' ? value.trim() : value;
  }
  if (patch.tax_rate_bp === 0) clean.tax_mode = 'exclusive';
  if (clean.tax_rate_bp !== undefined && clean.tax_rate_bp === 0)
    clean.tax_mode = 'exclusive';
  const device = await deviceInfo(db);
  const deviceId = String(device?.id ?? '');
  return writeAction(
    db,
    async (w) => {
      const current = await w.table<MasterRow, string>('shop').get('shop');
      if (!current) throw new SettingsError('name');
      const before = shopValues(current);
      const updated = await w.update('shop', 'shop', clean);
      await w.insert('audit_log', {
        id: newId(now),
        action: 'shop_change',
        entity: 'shop',
        entity_id: 'shop',
        before_json: JSON.stringify(
          Object.fromEntries(
            Object.keys(clean).map((key) => [
              key,
              before[key as keyof ShopSettings],
            ]),
          ),
        ),
        after_json: JSON.stringify(clean),
        device_id: deviceId,
        staff_id: actor ?? '',
        created_at: now,
      });
      return updated;
    },
    { now, actor },
  );
}

export type BranchSettings = {
  name: string;
  bill_prefix: string;
  address: string;
  phone: string;
};

export async function updateBranchSettings(
  db: BikriDb,
  branchId: string,
  patch: BranchSettings,
  actor: string | null,
  now = Date.now(),
): Promise<MasterRow> {
  if (patch.name.trim().length === 0) throw new SettingsError('name');
  if (!/^[A-Z]{2,6}$/u.test(patch.bill_prefix.trim()))
    throw new SettingsError('prefix');
  const device = await deviceInfo(db);
  const deviceId = String(device?.id ?? '');
  return writeAction(
    db,
    async (w) => {
      const before = await w.table<MasterRow, string>('branches').get(branchId);
      if (!before) throw new SettingsError('name');
      const updated = await w.update('branches', branchId, {
        name: patch.name.trim(),
        bill_prefix: patch.bill_prefix.trim(),
        address: patch.address.trim(),
        phone: patch.phone.trim(),
      });
      await w.insert('audit_log', {
        id: newId(now),
        action: 'branch_change',
        entity: 'branches',
        entity_id: branchId,
        before_json: JSON.stringify({
          name: before.name,
          bill_prefix: before.bill_prefix,
          address: before.address,
          phone: before.phone,
        }),
        after_json: JSON.stringify(patch),
        device_id: deviceId,
        staff_id: actor ?? '',
        created_at: now,
      });
      return updated;
    },
    { now, actor },
  );
}

export type StaffListRow = {
  staff: MasterRow;
  isLastOwner: boolean;
};

export async function staffList(db: BikriDb): Promise<StaffListRow[]> {
  const staff = (await db.staff.toArray()).filter((row) => !row.deleted_at);
  const owners = staff.filter(
    (row) => row.role === 'owner' && row.active === 1,
  );
  return staff
    .sort(
      (a, b) =>
        String(a.name).localeCompare(String(b.name)) ||
        String(a.id).localeCompare(String(b.id)),
    )
    .map((row) => ({
      staff: row,
      isLastOwner:
        row.role === 'owner' && row.active === 1 && owners.length <= 1,
    }));
}

export type StaffInput = {
  id?: string;
  name: string;
  role: Role;
  active: boolean;
  maxDiscountBp: number;
  permissions: Record<string, boolean>;
  pin?: PinHash & { pin_length: number };
};

function permissionsJson(input: Record<string, boolean>): string {
  const clean: Record<string, boolean> = {};
  for (const permission of PERMISSIONS) {
    const value = input[permission];
    if (typeof value === 'boolean') clean[permission] = value;
  }
  return JSON.stringify(clean);
}

export async function saveStaff(
  db: BikriDb,
  input: StaffInput,
  actor: string | null,
  now = Date.now(),
): Promise<MasterRow> {
  const name = input.name.trim().slice(0, 40);
  if (name.length === 0) throw new SettingsError('name');
  if (
    !Number.isInteger(input.maxDiscountBp) ||
    input.maxDiscountBp < 0 ||
    input.maxDiscountBp > 10000
  )
    throw new SettingsError('discount');
  if (input.pin && ![4, 5, 6].includes(Number(input.pin.pin_length)))
    throw new SettingsError('pin');
  const existing = input.id ? await db.staff.get(input.id) : undefined;
  const owners = (await db.staff.toArray()).filter(
    (row) => !row.deleted_at && row.role === 'owner' && row.active === 1,
  );
  const wasOwner =
    existing?.role === 'owner' && existing.active === 1 && !existing.deleted_at;
  const willBeOwner = input.role === 'owner' && input.active;
  if (wasOwner && !willBeOwner && owners.length <= 1)
    throw new SettingsError('last_owner');
  const device = await deviceInfo(db);
  const deviceId = String(device?.id ?? '');
  return writeAction(
    db,
    async (w) => {
      const before = existing;
      const fields: Record<string, unknown> = {
        name,
        role: input.role,
        active: input.active ? 1 : 0,
        max_discount_bp: input.maxDiscountBp,
        permissions_json: permissionsJson(input.permissions),
      };
      if (input.pin) {
        fields.pin_hash = input.pin.pin_hash;
        fields.pin_salt = input.pin.pin_salt;
        fields.pin_iterations = input.pin.pin_iterations;
        fields.pin_length = input.pin.pin_length;
        fields.must_change_pin = 0;
      }
      let row: MasterRow;
      if (before) row = await w.update('staff', before.id, fields);
      else {
        if (!input.pin) throw new SettingsError('pin');
        row = await w.create('staff', {
          ...fields,
          pin_hash: input.pin.pin_hash,
          pin_salt: input.pin.pin_salt,
          pin_iterations: input.pin.pin_iterations,
          pin_length: input.pin.pin_length,
          must_change_pin: 0,
          color: 'c1',
        });
      }
      await w.insert('audit_log', {
        id: newId(now),
        action: 'staff_change',
        entity: 'staff',
        entity_id: row.id,
        before_json: before
          ? JSON.stringify({
              name: before.name,
              role: before.role,
              active: before.active,
              max_discount_bp: before.max_discount_bp,
              permissions_json: before.permissions_json,
            })
          : null,
        after_json: JSON.stringify({
          name,
          role: input.role,
          active: input.active ? 1 : 0,
          max_discount_bp: input.maxDiscountBp,
          permissions_json: permissionsJson(input.permissions),
          pin_changed: Boolean(input.pin),
        }),
        device_id: deviceId,
        staff_id: actor ?? '',
        created_at: now,
      });
      return row;
    },
    { now, actor },
  );
}

export type AuditFilters = {
  from: string;
  to: string;
  action?: string;
  staffId?: string;
  deviceId?: string;
};

export type AuditRow = {
  row: SyncedRow;
  staffName: string;
  deviceName: string;
  summary: string;
};

const ACTION_LABELS: Record<string, string> = {};
for (const action of [
  'shop_change',
  'staff_change',
  'branch_change',
  'price_change',
  'cost_change',
  'credit_limit_change',
  'override',
  'void',
  'refund',
  'stock_count',
  'supplier_return',
  'drawer_open',
  'device_change',
  'device_enrol_code',
  'device_revoke',
  'ops_import',
  'pin_reset',
  'day_close_difference',
  'sync_ops_discarded',
  'cache_rebuilt',
  'owner_signin',
  'owner_export',
  'operator_export',
  'operator_import',
  'tenant_restore',
  'tenant_status_change',
  'owner_email_change',
  'support_access_start',
  'support_access_end',
]) {
  ACTION_LABELS[action] = action;
}

export const AUDIT_ACTIONS = Object.keys(ACTION_LABELS);

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Short human summary of the before/after JSON (screens/17 Activity). */
export function auditSummary(row: SyncedRow): string {
  const before = asObject(row.before_json);
  const after = asObject(row.after_json);
  if (after) {
    const keys = Object.keys(after);
    const parts = keys
      .filter((key) => !before || before[key] !== after[key])
      .slice(0, 4)
      .map(
        (key) =>
          `${key}: ${displayValue(before?.[key])} → ${displayValue(after[key])}`,
      );
    if (parts.length > 0) return parts.join(' · ').slice(0, 240);
  }
  if (before) return JSON.stringify(before).slice(0, 240);
  return '';
}

function zoneOffsetMs(at: number, timeZone: string): number {
  const name =
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'longOffset',
    })
      .formatToParts(new Date(at))
      .find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  const match = /GMT([+-])(\d{2}):(\d{2})/u.exec(name);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3])) * 60_000;
}

function rangeEpochs(
  filters: AuditFilters,
  timeZone: string,
): { start: number; end: number } {
  const from = Date.parse(`${filters.from}T12:00:00Z`);
  const to = Date.parse(`${filters.to}T12:00:00Z`);
  // The shop's local day boundaries, not a fixed +05:00 (screens/17 Activity).
  const start =
    Date.parse(`${filters.from}T00:00:00Z`) - zoneOffsetMs(from, timeZone);
  const end =
    Date.parse(`${filters.to}T23:59:59.999Z`) - zoneOffsetMs(to, timeZone);
  return { start, end };
}

export async function auditList(
  db: BikriDb,
  filters: AuditFilters,
): Promise<AuditRow[]> {
  const shop = await db.shop.get('shop');
  const timeZone = String(shop?.timezone ?? 'Asia/Karachi');
  const { start, end } = rangeEpochs(filters, timeZone);
  const rows = (
    await db.audit_log
      .where('created_at')
      .between(start, end, true, true)
      .toArray()
  ).filter(
    (row) =>
      (!filters.action || row.action === filters.action) &&
      (!filters.staffId || row.staff_id === filters.staffId) &&
      (!filters.deviceId || row.device_id === filters.deviceId),
  );
  const staff = await db.staff.bulkGet([
    ...new Set(rows.map((row) => String(row.staff_id))),
  ]);
  const devices = await db.devices.bulkGet([
    ...new Set(rows.map((row) => String(row.device_id))),
  ]);
  const staffMap = new Map(
    staff
      .filter((row): row is MasterRow => row !== undefined)
      .map((row) => [row.id, row]),
  );
  const deviceMap = new Map(
    devices
      .filter((row): row is SyncedRow => row !== undefined)
      .map((row) => [row.id, row]),
  );
  const localDevice = await deviceInfo(db);
  return rows
    .sort((a, b) => n(b.created_at) - n(a.created_at))
    .map((row) => ({
      row,
      staffName: String(staffMap.get(String(row.staff_id))?.name ?? ''),
      deviceName: String(
        deviceMap.get(String(row.device_id))?.name ??
          deviceMap.get(String(row.device_id))?.code ??
          (String(row.device_id) === String(localDevice?.id ?? '')
            ? localDevice?.name
            : '') ??
          '',
      ),
      summary: auditSummary(row),
    }));
}

export function auditCsv(rows: readonly AuditRow[], timeZone: string): string {
  const time = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const header = ['time', 'staff', 'device', 'action', 'entity', 'summary'];
  return `${[header.join(',')]
    .concat(
      rows.map((entry) =>
        [
          time.format(n(entry.row.created_at)).replace(', ', ' '),
          entry.staffName || String(entry.row.staff_id ?? ''),
          entry.deviceName || String(entry.row.device_id ?? ''),
          String(entry.row.action),
          String(entry.row.entity),
          entry.summary,
        ]
          .map(csvCell)
          .join(','),
      ),
    )
    .join('\r\n')}\r\n`;
}

export type { Permission };

/** Replace or remove the shop logo and queue the PNG for R2 (screens/17). */
export async function updateShopLogo(
  db: BikriDb,
  logo: LogoData | null,
  actor: string | null,
  now = Date.now(),
): Promise<void> {
  const device = await deviceInfo(db);
  const deviceId = String(device?.id ?? '');
  const logoKey = logo ? `shop/logo-${logo.sha256}.png` : null;
  await writeAction(
    db,
    async (w) => {
      const current = await w.table<MasterRow, string>('shop').get('shop');
      if (!current) throw new SettingsError('name');
      await w.update('shop', 'shop', { logo_key: logoKey });
      if (logo) {
        await w.table('file_queue').add({
          kind: 'logo',
          target_id: 'shop',
          blob: logo.png,
          sha256: logo.sha256,
          status: 'pending',
        } as never);
        await w
          .table<{ key: string; value: unknown }, string>('kv')
          .put({ key: 'logo_bitmap', value: logo.bitmap });
      } else {
        await w
          .table<{ key: string; value: unknown }, string>('kv')
          .delete('logo_bitmap');
      }
      await w.insert('audit_log', {
        id: newId(now),
        action: 'shop_change',
        entity: 'shop',
        entity_id: 'shop',
        before_json: JSON.stringify({ logo_key: current.logo_key ?? null }),
        after_json: JSON.stringify({ logo_key: logoKey }),
        device_id: deviceId,
        staff_id: actor ?? '',
        created_at: now,
      });
    },
    { now, actor },
  );
}
