import { createFileRoute } from '@tanstack/react-router';
import { ImportPage } from '../../products/ImportPage.tsx';

export const Route = createFileRoute('/products/import')({
  component: ImportPage,
});
