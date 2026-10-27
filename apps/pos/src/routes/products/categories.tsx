import { createFileRoute } from '@tanstack/react-router';
import { CategoriesPage } from '../../products/Categories.tsx';

export const Route = createFileRoute('/products/categories')({
  component: CategoriesPage,
});
