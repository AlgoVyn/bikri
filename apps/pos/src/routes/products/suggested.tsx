import { createFileRoute } from '@tanstack/react-router';
import { SuggestedPage } from '../../products/Suggested.tsx';

export const Route = createFileRoute('/products/suggested')({
  component: SuggestedPage,
});
