import { createFileRoute } from '@tanstack/react-router';

// Operator console (T-031, screens/19): the shell and pages load lazily, outside the till bundle.
export const Route = createFileRoute('/admin')({});
