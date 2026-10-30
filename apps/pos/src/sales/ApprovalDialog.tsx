import { can as canDo, type Permission, type Role } from '@bikri/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { OverrideDialog } from '../components/OverrideDialog.tsx';
import { approversFor } from '../data/cart.ts';
import { getDb } from '../data/db.ts';
import { verifyPinWithLockout } from '../data/pinLock.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';

/**
 * Manager PIN for one action (05 §4.1). The screen decides what to do with the approval; the
 * repository writes the `override` audit row together with the action's rows.
 */
export function ApprovalDialog({
  open,
  onOpenChange,
  permission,
  body,
  onApproved,
  roles,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  permission: Permission;
  body?: string;
  onApproved: (approvedBy: string) => void;
  /** Restrict who may approve (e.g. expense limits are manager/owner only). */
  roles?: readonly Role[];
}) {
  const { t } = useTranslation();
  const { staff } = useCurrentStaff();
  const everyone = useLiveQuery(() => getDb().staff.toArray(), []) ?? [];
  const profiles = approversFor(
    everyone,
    (s) =>
      s.id !== staff?.id &&
      (!roles || roles.includes(s.role as Role)) &&
      canDo(s.role as Role, String(s.permissions_json ?? '{}'), permission),
  ).map((s) => ({ id: s.id, label: String(s.name) }));

  const verify = async (pin: string, profileId: string) => {
    const s = everyone.find((x) => x.id === profileId);
    if (!s) return false;
    const result = await verifyPinWithLockout(getDb(), s.id, pin);
    const ok = result.kind === 'ok';
    if (ok) setTimeout(() => onApproved(s.id), 0);
    return ok;
  };

  return (
    <OverrideDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('ui.override_title')}
      body={body ?? t('ui.override_body')}
      profiles={profiles}
      verify={verify}
    />
  );
}
