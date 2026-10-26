import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { useTranslation } from 'react-i18next';
import { buttonQuiet } from './classes.ts';

const itemClass =
  'flex min-h-11 cursor-pointer items-center rounded-control px-3 text-text outline-none data-[highlighted]:bg-surface-2';

export function ExportMenu({
  onCsv,
  onPdf,
  onShare,
}: {
  onCsv: () => void;
  onPdf: () => void;
  onShare: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dropdown.Root>
      <Dropdown.Trigger className={buttonQuiet}>
        {t('ui.export')}
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          className="z-50 min-w-40 rounded-control border border-border bg-surface p-1 shadow-card"
          sideOffset={4}
          align="end"
        >
          <Dropdown.Item className={itemClass} onSelect={onCsv}>
            {t('ui.export_csv')}
          </Dropdown.Item>
          <Dropdown.Item className={itemClass} onSelect={onPdf}>
            {t('ui.export_pdf')}
          </Dropdown.Item>
          <Dropdown.Item className={itemClass} onSelect={onShare}>
            {t('ui.export_share')}
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
