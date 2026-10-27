import { createLazyFileRoute, useNavigate } from '@tanstack/react-router';
import { RefundDialog } from '../../sales/RefundDialog.tsx';

export const Route = createLazyFileRoute('/sales/$id/refund')({
  component: RefundRoute,
});

function RefundRoute() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  return (
    <RefundDialog
      saleId={id}
      open
      onClose={() => void navigate({ to: '/sales/$id', params: { id } })}
    />
  );
}
