import { createLazyFileRoute } from '@tanstack/react-router';
import { RequestStatusPage } from '../public/RequestStatusPage.tsx';

export const Route = createLazyFileRoute('/request-status')({
  component: RequestStatusPage,
});
