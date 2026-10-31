import { DirectionProvider, MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import type { ReactNode } from 'react';
import { bikriColorSchemeManager } from './colorScheme.ts';
import { bikriCssVariables, bikriTheme } from './theme.ts';

/** Mantine providers shared by the till, admin console, setup and lock screens. */
export function MantineRoot({ children }: { children: ReactNode }) {
  return (
    <DirectionProvider detectDirection>
      <MantineProvider
        theme={bikriTheme}
        defaultColorScheme="auto"
        colorSchemeManager={bikriColorSchemeManager}
        cssVariablesResolver={bikriCssVariables}
      >
        <Notifications position="bottom-center" limit={3} />
        {children}
      </MantineProvider>
    </DirectionProvider>
  );
}
