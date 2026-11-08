import { createFileRoute } from '@tanstack/react-router';
import { StockCountPage } from '../../products/StockCount.tsx';

export const Route = createFileRoute('/stock/count')({
  component: StockCountPage,
});
