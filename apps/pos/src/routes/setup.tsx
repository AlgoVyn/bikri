import { createFileRoute } from '@tanstack/react-router';
import { SetupWizard } from '../setup/SetupWizard.tsx';

export const Route = createFileRoute('/setup')({
  component: SetupWizard,
});
