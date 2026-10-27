import { API_BASE } from '@bikri/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../components/Toast.tsx';
import { adminErrorMessage, listBackups, readBackupManifest } from './api.ts';
import {
  formatBytes,
  formatCount,
  formatWhen,
  manifestKeyFor,
} from './format.ts';
import type { BackupManifest, BackupObject } from './types.ts';

type Row = BackupObject & { manifest: BackupManifest | null | undefined };

function tableSum(tables: Record<string, number> | undefined): number {
  if (tables === undefined) return 0;
  return Object.values(tables).reduce((sum, n) => sum + n, 0);
}

export function BackupsPage() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lang = i18n.language;

  useEffect(() => {
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
        const message = adminErrorMessage(err, t('admin.err_generic'));
        setError(message);
        toast.push(message, 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [t, toast]);

  if (error !== null && rows === null) {
    return <p className="text-text-muted">{error}</p>;
  }
  if (rows === null) return <p className="sr-only">{t('common.loading')}</p>;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-title font-semibold">{t('admin.backups_title')}</h1>
      <p className="text-text-muted">{t('admin.backups_hint')}</p>
      {rows.length === 0 ? (
        <p className="text-text-muted">{t('admin.backups_empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-card border border-border bg-surface">
          <table className="w-full text-left text-small">
            <thead className="border-b border-border text-text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">{t('admin.col_date')}</th>
                <th className="px-3 py-2 text-end font-medium">
                  {t('admin.col_size')}
                </th>
                <th className="px-3 py-2 font-medium">
                  {t('admin.col_counts')}
                </th>
                <th className="px-3 py-2 font-medium">{t('admin.download')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-b border-border align-top">
                  <td className="px-3 py-2">
                    {formatWhen(row.uploaded, lang)}
                  </td>
                  <td className="px-3 py-2 text-end tabular-nums">
                    {formatBytes(row.size, lang)}
                  </td>
                  <td className="px-3 py-2">
                    <Counts manifest={row.manifest} />
                  </td>
                  <td className="px-3 py-2">
                    <a
                      className="inline-flex min-h-11 items-center text-primary underline"
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
      )}
    </div>
  );
}

function Counts({ manifest }: { manifest: BackupManifest | null | undefined }) {
  const { t, i18n } = useTranslation();
  if (manifest === undefined) return <span>{t('common.loading')}</span>;
  const tenants = manifest?.tenants;
  if (manifest === null || tenants === undefined) {
    return <span>{t('admin.counts_missing')}</span>;
  }
  const entries = Object.entries(tenants);
  if (entries.length === 0) return <span>{t('admin.counts_missing')}</span>;
  return (
    <ul>
      {entries.map(([id, tenant]) => (
        <li key={id} className="tabular-nums">
          {tenant.slug ?? id}:{' '}
          {formatCount(tableSum(tenant.tables), i18n.language)}
        </li>
      ))}
    </ul>
  );
}
