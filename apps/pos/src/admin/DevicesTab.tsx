import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../components/Toast.tsx';
import {
  adminErrorMessage,
  importOps,
  issueCode,
  listDevices,
  revokeDevice,
} from './api.ts';
import { formatCount, formatWhen, OPS_CHUNK } from './format.ts';
import type { DeviceInfo, IssuedCode, UnsyncedOp } from './types.ts';
import {
  AdminConfirm,
  dangerBtn,
  Field,
  PairingPanel,
  primaryBtn,
} from './ui.tsx';
import { useAdminQuery } from './useAdminQuery.ts';

const inputClass =
  'h-11 w-full rounded-control border border-border-strong bg-surface px-3 text-text';

type Preview = {
  deviceId: string;
  name: string;
  ops: UnsyncedOp[];
};

function parseUnsynced(
  text: string,
): { tenant_id: string; device_id: string; ops: UnsyncedOp[] } | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  if (body.format !== 'bikri-unsynced' || body.version !== 2) return null;
  if (
    typeof body.tenant_id !== 'string' ||
    typeof body.device_id !== 'string'
  ) {
    return null;
  }
  if (!Array.isArray(body.ops) || body.ops.length === 0) return null;
  const ops: UnsyncedOp[] = [];
  for (const item of body.ops) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return null;
    }
    const row = item as Record<string, unknown>;
    if (
      typeof row.op_id !== 'string' ||
      typeof row.tx_id !== 'string' ||
      typeof row.tbl !== 'string' ||
      typeof row.kind !== 'string'
    ) {
      return null;
    }
    const op: UnsyncedOp = {
      op_id: row.op_id,
      tx_id: row.tx_id,
      tbl: row.tbl,
      kind: row.kind,
    };
    if (row.row !== undefined) {
      if (
        row.row === null ||
        typeof row.row !== 'object' ||
        Array.isArray(row.row)
      ) {
        return null;
      }
      op.row = row.row as Record<string, unknown>;
    }
    if (row.row_id !== undefined) {
      if (typeof row.row_id !== 'string') return null;
      op.row_id = row.row_id;
    }
    if (row.base_rev !== undefined) {
      if (typeof row.base_rev !== 'number') return null;
      op.base_rev = row.base_rev;
    }
    if (row.changed_fields !== undefined) {
      if (!Array.isArray(row.changed_fields)) return null;
      const fields: string[] = [];
      for (const field of row.changed_fields) {
        if (typeof field !== 'string') return null;
        fields.push(field);
      }
      op.changed_fields = fields;
    }
    if (row.updated_by !== undefined) {
      if (row.updated_by !== null && typeof row.updated_by !== 'string')
        return null;
      op.updated_by = row.updated_by;
    }
    ops.push(op);
  }
  return { tenant_id: body.tenant_id, device_id: body.device_id, ops };
}

export function DevicesTab({
  tenantId,
  shopName,
}: {
  tenantId: string;
  shopName: string;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const query = useAdminQuery(`devices:${tenantId}`, () =>
    listDevices(tenantId),
  );
  const [name, setName] = useState('');
  const [admin, setAdmin] = useState(false);
  const [pending, setPending] = useState(false);
  const [issued, setIssued] = useState<IssuedCode | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const lang = i18n.language;

  if (query.data === null) {
    return query.error !== null ? (
      <p className="text-text-muted">
        {query.error}{' '}
        <button type="button" className={primaryBtn} onClick={query.reload}>
          {t('admin.retry')}
        </button>
      </p>
    ) : (
      <p className="sr-only">{t('common.loading')}</p>
    );
  }
  const devices = query.data.devices;

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4"
        onSubmit={(event) => {
          event.preventDefault();
          const deviceName = name.trim();
          if (deviceName.length < 1 || pending) return;
          setPending(true);
          void issueCode(tenantId, deviceName, admin)
            .then((code) => {
              setIssued(code);
              setName('');
              query.reload();
            })
            .catch((err: unknown) => {
              toast.push(
                adminErrorMessage(err, t('admin.err_generic')),
                'error',
              );
            })
            .finally(() => {
              setPending(false);
            });
        }}
      >
        <h2 className="font-semibold">{t('admin.issue_code')}</h2>
        <Field id="device-name" label={t('admin.device_name')}>
          <input
            id="device-name"
            className={inputClass}
            value={name}
            maxLength={40}
            required
            autoComplete="off"
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>
        <label
          className="flex min-h-11 items-center gap-2"
          htmlFor="device-admin"
        >
          <input
            id="device-admin"
            type="checkbox"
            checked={admin}
            onChange={(event) => {
              setAdmin(event.target.checked);
            }}
          />
          {t('admin.grants_admin')}
        </label>
        <button
          type="submit"
          className={primaryBtn}
          disabled={pending || name.trim() === ''}
        >
          {t('admin.issue')}
        </button>
      </form>
      {issued !== null ? (
        <PairingPanel
          code={issued.code}
          link={issued.link}
          expiresAt={issued.expires_at}
          shopName={shopName}
        />
      ) : null}
      {devices.length === 0 ? (
        <p className="text-text-muted">{t('admin.devices_empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-card border border-border bg-surface">
          <table className="w-full text-left text-small">
            <thead className="border-b border-border text-text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">{t('admin.col_name')}</th>
                <th className="px-3 py-2 font-medium">{t('admin.col_code')}</th>
                <th className="px-3 py-2 font-medium">
                  {t('admin.col_branch')}
                </th>
                <th className="px-3 py-2 font-medium">
                  {t('admin.col_admin')}
                </th>
                <th className="px-3 py-2 font-medium">{t('admin.col_kind')}</th>
                <th className="px-3 py-2 font-medium">
                  {t('admin.col_last_seen')}
                </th>
                <th className="px-3 py-2 font-medium">
                  {t('admin.col_version')}
                </th>
                <th className="px-3 py-2 font-medium">
                  {t('admin.col_pending')}
                </th>
                <th className="px-3 py-2 font-medium">
                  {t('admin.col_ro_seen')}
                </th>
                <th className="px-3 py-2 font-medium">
                  {t('admin.col_status')}
                </th>
                <th className="px-3 py-2 font-medium">{t('admin.revoke')}</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((device) => (
                <DeviceRow
                  key={device.id}
                  device={device}
                  lang={lang}
                  onRevoke={() => {
                    setRevokeId(device.id);
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <section className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4">
        <h2 className="font-semibold">{t('admin.import_ops')}</h2>
        <Field
          id="unsynced-file"
          label={t('admin.import_choose')}
          hint={t('admin.import_hint')}
        >
          <input
            id="unsynced-file"
            type="file"
            accept="application/json,.json"
            aria-describedby="unsynced-file-hint"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file === undefined) return;
              void file.text().then((text) => {
                const parsed = parseUnsynced(text);
                if (parsed === null) {
                  setPreview(null);
                  toast.push(t('admin.import_bad'), 'error');
                  return;
                }
                if (parsed.tenant_id !== tenantId) {
                  setPreview(null);
                  toast.push(t('admin.import_tenant_mismatch'), 'error');
                  return;
                }
                const device = devices.find(
                  (item) => item.id === parsed.device_id,
                );
                if (device === undefined || device.revoked_at === null) {
                  setPreview(null);
                  toast.push(t('admin.import_not_revoked'), 'error');
                  return;
                }
                setPreview({
                  deviceId: parsed.device_id,
                  name: device.name,
                  ops: parsed.ops,
                });
                setProgress(null);
              });
            }}
          />
        </Field>
        {preview !== null ? (
          <p>
            {t('admin.import_preview', {
              count: formatCount(preview.ops.length, lang),
              device: preview.name,
            })}
          </p>
        ) : null}
        {progress !== null ? <p className="tabular-nums">{progress}</p> : null}
        <button
          type="button"
          className={primaryBtn}
          disabled={preview === null || pending}
          onClick={() => {
            if (preview === null) return;
            const job = preview;
            setPending(true);
            void (async () => {
              let done = 0;
              for (let i = 0; i < job.ops.length; i += OPS_CHUNK) {
                const slice = job.ops.slice(i, i + OPS_CHUNK);
                await importOps(tenantId, job.deviceId, slice);
                done += slice.length;
                setProgress(
                  t('admin.import_progress', {
                    done: formatCount(done, lang),
                    total: formatCount(job.ops.length, lang),
                  }),
                );
              }
              toast.push(t('admin.import_done'), 'info');
              setPreview(null);
              query.reload();
            })()
              .catch((err: unknown) => {
                toast.push(
                  adminErrorMessage(err, t('admin.err_generic')),
                  'error',
                );
              })
              .finally(() => {
                setPending(false);
              });
          }}
        >
          {t('admin.import_run')}
        </button>
      </section>
      <AdminConfirm
        open={revokeId !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeId(null);
        }}
        title={t('admin.revoke_title')}
        body={t('admin.revoke_body')}
        confirmLabel={t('admin.revoke')}
        onConfirm={() => {
          const id = revokeId;
          if (id === null) return;
          setPending(true);
          void revokeDevice(tenantId, id)
            .then(() => {
              toast.push(t('admin.revoked'), 'info');
              query.reload();
            })
            .catch((err: unknown) => {
              toast.push(
                adminErrorMessage(err, t('admin.err_generic')),
                'error',
              );
            })
            .finally(() => {
              setPending(false);
            });
        }}
      />
    </div>
  );
}

function DeviceRow({
  device,
  lang,
  onRevoke,
}: {
  device: DeviceInfo;
  lang: string;
  onRevoke: () => void;
}) {
  const { t } = useTranslation();
  const revoked = device.revoked_at !== null;
  return (
    <tr className="border-b border-border">
      <td className="px-3 py-2">{device.name}</td>
      <td className="px-3 py-2 font-mono">{device.device_code}</td>
      <td className="px-3 py-2 font-mono">{device.branch_id}</td>
      <td className="px-3 py-2">
        {device.is_admin ? t('common.yes') : t('common.no')}
      </td>
      <td className="px-3 py-2">
        {t(
          device.kind === 'support' ? 'admin.kind_support' : 'admin.kind_till',
        )}
      </td>
      <td className="px-3 py-2">
        {device.last_seen_at === null
          ? t('admin.never')
          : formatWhen(device.last_seen_at, lang)}
      </td>
      <td className="px-3 py-2 font-mono">
        {device.app_version ?? t('admin.never')}
      </td>
      <td className="px-3 py-2 text-end tabular-nums">
        {formatCount(device.pending_ops, lang)}
      </td>
      <td className="px-3 py-2">
        {device.read_only_seen_at === null
          ? t('admin.never')
          : formatWhen(device.read_only_seen_at, lang)}
      </td>
      <td className="px-3 py-2">
        {revoked ? t('admin.revoked') : t('admin.active_device')}
      </td>
      <td className="px-3 py-2">
        {revoked ? null : (
          <button type="button" className={dangerBtn} onClick={onRevoke}>
            {t('admin.revoke')}
          </button>
        )}
      </td>
    </tr>
  );
}
