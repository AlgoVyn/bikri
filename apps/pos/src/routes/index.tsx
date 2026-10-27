import { createFileRoute } from '@tanstack/react-router';
import { HomePage } from '../home/HomePage.tsx';

export const Route = createFileRoute('/')({
  component: HomePage,
});
