import { API_BASE } from '@bikri/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CloudIcon } from '../components/icons.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { adminErrorMessage, listBackups, readBackupManifest } from './api.ts';
import {
  formatBytes,
  formatCount,
  formatWhen,
  manifestKeyFor,
} from './format.ts';
import type { BackupManifest, BackupObject } from './types.ts';
import { AdminErrorState, Panel, quietBtn, StatCard } from './ui.tsx';

type Row = BackupObject & { manifest: BackupManifest | null | undefined };

function tableSum(tables: Record<string, number> | undefined): number {
  if (tables === undefined) return 0;
  return Object.values(tables).reduce((sum, n) => sum + n, 0);
}

function manifestTotals(manifest: BackupManifest | null | undefined): {
  rows: number;
  shops: number;
} {
  const tenants = manifest?.tenants;
  if (tenants === undefined) return { rows: 0, shops: 0 };
  const entries = Object.values(tenants);
  return {
    rows: entries.reduce((sum, tenant) => sum + tableSum(tenant.tables), 0),
    shops: entries.length,
  };
}

export function BackupsPage() {
  const { t, i18n } = useTranslation();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const lang = i18n.language;
  const retryLoad = () => {
    setError(null);
    setRetry((value) => value + 1);
  };

  useEffect(() => {
    // `retry` is only a trigger; reading it keeps the dependency honest.
    void retry;
    setError(null);
    let cancelled = false;
    void listBackups()
      .then(async (list) => {
        const sql = list.objects
          .filter((object) => object.key.endsWith('.sql.gz'))
          .sort((a, b) => b.uploaded - a.uploaded)
          .slice(0, 30);
        const keys = new Set(list.objects.map((object) => object.key));
        if (!cancelled) {
          setRows(sql.map((object) => ({ ...object, manifest: undefined })));
        }
        const filled = await Promise.all(
          sql.map(async (object) => {
            const key = manifestKeyFor(object.key);
            const manifest =
              key !== null && keys.has(key)
                ? await readBackupManifest(key)
                : null;
            return { ...object, manifest };
          }),
        );
        if (!cancelled) setRows(filled);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(adminErrorMessage(err, t('admin.err_generic')));
      });
    return () => {
      cancelled = true;
    };
  }, [t, retry]);

  if (error !== null && rows === null) {
    return <AdminErrorState message={error} onRetry={retryLoad} />;
  }
  if (rows === null) return <p className="sr-only">{t('common.loading')}</p>;

  const latest = rows[0];
  const totalBytes = rows.reduce((sum, row) => sum + row.size, 0);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={<CloudIcon />}
        title={t('admin.backups_title')}
        subtitle={t('admin.backups_subtitle')}
      />

      {error !== null ? (
        <div
          role="alert"
          data-testid="backups-error"
          className="flex flex-wrap items-center gap-3 rounded-card border border-danger-subtle bg-danger-subtle p-3 text-small text-danger-subtle-ink"
        >
          <p className="min-w-0 flex-1">{error}</p>
          <button type="button" className={quietBtn} onClick={retryLoad}>
            {t('admin.retry')}
          </button>
        </div>
      ) : null}

      <div className="flex items-start gap-3 rounded-card border border-info-subtle bg-info-subtle p-4 text-info-subtle-ink">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-control bg-surface/70"
        >
          <CloudIcon />
        </span>
        <div>
          <p className="font-medium">{t('admin.backups_info_title')}</p>
          <p className="mt-0.5 text-small">{t('admin.backups_info_body')}</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label={t('admin.backup_latest')}
          value={
            latest === undefined
              ? t('admin.never')
              : formatWhen(latest.uploaded, lang)
          }
        />
        <StatCard
          label={t('admin.backup_count')}
          value={formatCount(rows.length, lang)}
        />
        <StatCard
          label={t('admin.backup_total')}
          value={formatBytes(totalBytes, lang)}
        />
      </div>

      {rows.length === 0 ? (
        <Panel bodyClassName="flex flex-col items-center gap-3 px-4 py-10 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-primary-subtle text-primary-subtle-ink">
            <CloudIcon />
          </span>
          <p className="font-medium">{t('admin.backups_empty')}</p>
          <p className="max-w-md text-small text-text-muted">
            {t('admin.backups_empty_hint')}
          </p>
        </Panel>
      ) : (
        <Panel bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-start text-small">
              <caption className="sr-only">{t('admin.backups_title')}</caption>
              <thead className="border-b border-divider bg-surface-2 text-text-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 text-start font-medium">
                    {t('admin.col_date')}
                  </th>
                  <th scope="col" className="px-4 py-3 text-start font-medium">
                    {t('admin.col_size')}
                  </th>
                  <th scope="col" className="px-4 py-3 text-start font-medium">
                    {t('admin.col_counts')}
                  </th>
                  <th scope="col" className="px-4 py-3 text-start font-medium">
                    {t('admin.download')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.key}
                    className="border-b border-divider align-top last:border-b-0 hover:bg-surface-2/60"
                  >
                    <td className="px-4 py-3 whitespace-nowrap">
                      {formatWhen(row.uploaded, lang)}
                    </td>
                    <td className="px-4 py-3 text-start tabular-nums">
                      {formatBytes(row.size, lang)}
                    </td>
                    <td className="px-4 py-3">
                      <Counts manifest={row.manifest} />
                    </td>
                    <td className="px-4 py-3">
                      <a
                        className="inline-flex min-h-11 items-center rounded-control border border-border-strong bg-surface px-3 font-medium text-text hover:bg-surface-2"
                        href={`${API_BASE}/admin/backups/download?key=${encodeURIComponent(row.key)}`}
                      >
                        {t('admin.download')}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}

function Counts({ manifest }: { manifest: BackupManifest | null | undefined }) {
  const { t, i18n } = useTranslation();
  if (manifest === undefined) {
    return <span className="text-text-muted">{t('common.loading')}</span>;
  }
  const tenants = manifest?.tenants;
  if (manifest === null || tenants === undefined) {
    return <span className="text-text-muted">{t('admin.counts_missing')}</span>;
  }
  const entries = Object.entries(tenants);
  if (entries.length === 0) {
    return <span className="text-text-muted">{t('admin.counts_missing')}</span>;
  }
  const totals = manifestTotals(manifest);
  return (
    <details>
      <summary className="cursor-pointer text-start font-medium text-primary">
        {t('admin.counts_summary', {
          rows: formatCount(totals.rows, i18n.language),
          shops: formatCount(totals.shops, i18n.language),
        })}
      </summary>
      <ul className="mt-1 max-h-48 overflow-y-auto">
        {entries.map(([id, tenant]) => (
          <li key={id} className="tabular-nums">
            {tenant.slug ?? id}:{' '}
            {formatCount(tableSum(tenant.tables), i18n.language)}
          </li>
        ))}
      </ul>
    </details>
  );
}
