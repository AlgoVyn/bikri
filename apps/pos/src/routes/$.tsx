import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/$')({
  component: CatchAllPage,
});

function CatchAllPage() {
  return null;
}
