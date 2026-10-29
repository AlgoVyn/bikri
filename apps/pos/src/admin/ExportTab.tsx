import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../components/Toast.tsx';
import { downloadBlob } from '../lib/download.ts';
import { adminErrorMessage } from './api.ts';
import { buildTenantExport, type ExportProgress } from './exportZip.ts';
import { barPercent, formatCount } from './format.ts';
import { Panel, primaryBtn } from './ui.tsx';

export function ExportTab({ tenantId }: { tenantId: string }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [rows, setRows] = useState<ExportProgress[]>([]);
  const [pending, setPending] = useState(false);
  const lang = i18n.language;

  return (
    <Panel
      title={t('admin.tab_export')}
      description={t('admin.export_hint')}
      className="max-w-2xl"
    >
      <div className="flex flex-col gap-4">
        <p className="text-small text-text-muted">{t('admin.export_intro')}</p>
        <div>
          <button
            type="button"
            className={primaryBtn}
            disabled={pending}
            onClick={() => {
              setPending(true);
              setRows([]);
              void buildTenantExport(tenantId, (progress) => {
                setRows((current) => {
                  const index = current.findIndex(
                    (row) => row.tbl === progress.tbl,
                  );
                  if (index === -1) return [...current, progress];
                  const next = current.slice();
                  next[index] = progress;
                  return next;
                });
              })
                .then((built) => {
                  const blob = new Blob(
                    [built.bytes as Uint8Array<ArrayBuffer>],
                    {
                      type: 'application/zip',
                    },
                  );
                  downloadBlob(built.filename, blob);
                  toast.push(t('admin.export_done'), 'info');
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
            {t('admin.export_start')}
          </button>
        </div>
        {rows.length > 0 ? (
          <ul className="flex flex-col gap-3" aria-live="polite">
            {rows.map((row) => (
              <li key={row.tbl}>
                <div className="flex flex-wrap items-center justify-between gap-2 text-small">
                  <span className="font-medium">{row.tbl}</span>
                  <span className="text-text-muted tabular-nums">
                    {t('admin.of_limit', {
                      value: formatCount(row.done, lang),
                      limit: formatCount(row.total, lang),
                    })}
                  </span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-2">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${barPercent(row.done, row.total)}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Panel>
  );
}
