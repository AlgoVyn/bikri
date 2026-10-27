import { createFileRoute } from '@tanstack/react-router';
import { SellPage } from '../sell/SellPage.tsx';

export const Route = createFileRoute('/sell')({
  component: SellPage,
});
