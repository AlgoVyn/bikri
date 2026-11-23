import {
  createLazyFileRoute,
  useLocation,
  useNavigate,
  useRouter,
} from '@tanstack/react-router';
import { RefundDialog } from '../../sales/RefundDialog.tsx';

export const Route = createLazyFileRoute('/sales/$id/refund')({
  component: RefundRoute,
});

function RefundRoute() {
  const { id } = Route.useParams();
  const router = useRouter();
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <RefundDialog
      saleId={id}
      open
      onClose={() => {
        const state = location.state as unknown as
          | Record<string, unknown>
          | undefined;
        if (state?.bikriChild === 'bill') {
          router.history.back();
          return;
        }
        void navigate({
          to: '/sales/$id',
          params: { id },
          state: true,
          replace: true,
        });
      }}
    />
  );
}
