import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../components/Toast.tsx';
import { downloadBlob } from '../lib/download.ts';
import { adminErrorMessage } from './api.ts';
import { buildTenantExport, type ExportProgress } from './exportZip.ts';
import { formatCount } from './format.ts';
import { primaryBtn } from './ui.tsx';

export function ExportTab({ tenantId }: { tenantId: string }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [rows, setRows] = useState<ExportProgress[]>([]);
  const [pending, setPending] = useState(false);
  const lang = i18n.language;

  return (
    <div className="flex flex-col gap-3">
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
              const blob = new Blob([built.bytes as Uint8Array<ArrayBuffer>], {
                type: 'application/zip',
              });
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
      {rows.length > 0 ? (
        <ul className="flex flex-col gap-1" aria-live="polite">
          {rows.map((row) => (
            <li key={row.tbl} className="tabular-nums">
              {t('admin.export_progress', {
                table: row.tbl,
                done: formatCount(row.done, lang),
                total: formatCount(row.total, lang),
              })}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
