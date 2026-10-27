import { useEffect, useState } from 'react';
import { PermissionGate } from '../components/PermissionGate.tsx';
import { AreaStrings } from '../i18n/areas.tsx';
import { type LabelSeed, LabelsDialog } from './LabelsDialog.tsx';

type Seed = { rows: LabelSeed[]; returnTo: string };

/** `/labels` opened from a toast (delivery saved); the dialog closes back to the caller. */
export function LabelsRoutePage() {
  return (
    <AreaStrings area="office">
      <PermissionGate permission="catalog.edit">
        <LabelsRouteContent />
      </PermissionGate>
    </AreaStrings>
  );
}

function LabelsRouteContent() {
  const [seed, setSeed] = useState<Seed>({ rows: [], returnTo: '/' });
  const [open, setOpen] = useState(true);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('bikri.label_seed');
      if (!raw) return;
      sessionStorage.removeItem('bikri.label_seed');
      const parsed = JSON.parse(raw) as Partial<Seed>;
      if (Array.isArray(parsed.rows))
        setSeed({
          rows: parsed.rows.filter(
            (row): row is LabelSeed =>
              typeof row.productId === 'string' &&
              typeof row.copies === 'number',
          ),
          returnTo:
            typeof parsed.returnTo === 'string' &&
            parsed.returnTo.startsWith('/')
              ? parsed.returnTo
              : '/',
        });
    } catch {
      // Ignore a malformed seed; the dialog still opens empty.
    }
  }, []);
  const close = () => {
    setOpen(false);
    window.location.assign(
      `${import.meta.env.BASE_URL || '/'}${seed.returnTo.replace(/^\//u, '')}`,
    );
  };
  return (
    <div className="p-4">
      <LabelsDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        initial={seed.rows}
      />
    </div>
  );
}
