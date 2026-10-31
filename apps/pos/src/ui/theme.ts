import {
  type CSSVariablesResolver,
  createTheme,
  type MantineColorsTuple,
} from '@mantine/core';

/**
 * Mantine is the UI chassis, not the brand. These scales intentionally mirror the
 * Algovyn tokens in styles/tokens.css: keep the two in sync when the palette changes.
 * Mantine needs ten shades per colour; the Algovyn 50–900 scale maps directly.
 */
const brand: MantineColorsTuple = [
  '#f0f9ff',
  '#e0f2fe',
  '#bae6fd',
  '#7dd3fc',
  '#4da6ff',
  '#2389d9',
  '#006bb3',
  '#005a96',
  '#00497a',
  '#00385d',
];

const dark: MantineColorsTuple = [
  '#f8fafc',
  '#e2e8f0',
  '#cbd5e1',
  '#94a3b8',
  '#64748b',
  '#475569',
  '#334155',
  '#1e293b',
  '#0f172a',
  '#020617',
];

const accent: MantineColorsTuple = [
  '#e6fbfa',
  '#c7f5f3',
  '#95ece8',
  '#5fdcd7',
  '#4bc2bf',
  '#2fa9a6',
  '#218a88',
  '#1c6d6b',
  '#1a5756',
  '#0d3f3f',
];

const success: MantineColorsTuple = [
  '#ecfdf5',
  '#d1fae5',
  '#a7f3d0',
  '#6ee7b7',
  '#34d399',
  '#10b981',
  '#047857',
  '#065f46',
  '#064e3b',
  '#022c22',
];

const warning: MantineColorsTuple = [
  '#fffbeb',
  '#fef3c7',
  '#fde68a',
  '#fcd34d',
  '#fbbf24',
  '#f59e0b',
  '#b45309',
  '#92400e',
  '#78350f',
  '#451a03',
];

const danger: MantineColorsTuple = [
  '#fef2f2',
  '#fee2e2',
  '#fecaca',
  '#fca5a5',
  '#f87171',
  '#ef4444',
  '#dc2626',
  '#991b1b',
  '#7f1d1d',
  '#450a0a',
];

const sans = 'Inter, ui-sans-serif, system-ui, sans-serif';
const mono = 'JetBrains Mono, ui-monospace, monospace';

export const bikriTheme = createTheme({
  primaryColor: 'brand',
  primaryShade: { light: 6, dark: 4 },
  colors: { brand, dark, success, warning, danger, accent },
  fontFamily: sans,
  fontFamilyMonospace: mono,
  headings: {
    fontFamily: sans,
    fontWeight: '600',
    sizes: {
      h1: { fontSize: '1.6rem', lineHeight: '1.25' },
      h2: { fontSize: '1.2rem', lineHeight: '1.35' },
      h3: { fontSize: '1.0667rem', lineHeight: '1.4' },
      h4: { fontSize: '1rem', lineHeight: '1.45' },
      h5: { fontSize: '0.9333rem', lineHeight: '1.5' },
      h6: { fontSize: '0.8667rem', lineHeight: '1.5' },
    },
  },
  fontSizes: {
    xs: '0.7333rem',
    sm: '0.8667rem',
    md: '1rem',
    lg: '1.2rem',
    xl: '1.6rem',
  },
  lineHeights: {
    xs: '1.35',
    sm: '1.45',
    md: '1.55',
    lg: '1.6',
    xl: '1.65',
  },
  spacing: {
    xs: '4px',
    sm: '8px',
    md: '12px',
    lg: '16px',
    xl: '24px',
  },
  radius: {
    xs: '4px',
    sm: '6px',
    md: '10px',
    lg: '14px',
    xl: '18px',
  },
  defaultRadius: 'md',
  shadows: {
    xs: '0 1px 2px rgb(15 23 42 / 0.04)',
    sm: '0 1px 2px rgb(15 23 42 / 0.04), 0 1px 3px rgb(15 23 42 / 0.06)',
    md: '0 4px 12px rgb(15 23 42 / 0.08)',
    lg: '0 12px 32px rgb(15 23 42 / 0.14)',
    xl: '0 20px 48px rgb(15 23 42 / 0.18)',
  },
  components: {
    Button: {
      defaultProps: { size: 'md' },
      styles: {
        root: {
          minHeight: 44,
          fontWeight: 550,
          letterSpacing: '0.005em',
        },
      },
    },
    ActionIcon: {
      defaultProps: { size: 'lg', radius: 'md' },
      styles: {
        root: { minWidth: 44, minHeight: 44 },
      },
    },
    TextInput: {
      defaultProps: { size: 'md' },
      styles: {
        input: { minHeight: 44 },
      },
    },
    Select: {
      defaultProps: { size: 'md' },
      styles: {
        input: { minHeight: 44 },
      },
    },
    NumberInput: {
      defaultProps: { size: 'md' },
      styles: {
        input: { minHeight: 44 },
      },
    },
    Textarea: {
      defaultProps: { size: 'md' },
      styles: {
        input: { minHeight: 88 },
      },
    },
    Checkbox: { defaultProps: { size: 'md' } },
    Switch: { defaultProps: { size: 'md' } },
    Modal: { defaultProps: { radius: 'lg', centered: true } },
    Drawer: { defaultProps: { radius: 'lg' } },
    Badge: {
      defaultProps: { radius: 'xl', tt: 'none' },
      styles: { root: { fontWeight: 550 } },
    },
    Card: { defaultProps: { radius: 'lg', withBorder: true } },
    Paper: { defaultProps: { radius: 'lg' } },
    Table: {
      defaultProps: {
        verticalSpacing: 'sm',
        horizontalSpacing: 'md',
        highlightOnHover: true,
        fz: 'sm',
      },
    },
  },
  other: {
    rail: '#182e55',
    railDark: '#1d3357',
    accent: '#4bc2bf',
    navy: '#182e55',
  },
});

/** Align Mantine's body/surface variables with the Algovyn slate palette. */
export const bikriCssVariables: CSSVariablesResolver = () => ({
  variables: {
    '--bikri-surface-radius': '14px',
  },
  light: {
    '--mantine-color-body': '#f8fafc',
    '--mantine-color-text': '#0f172a',
    '--mantine-color-dimmed': '#475569',
    '--mantine-color-placeholder': '#64748b',
    '--mantine-color-default': '#ffffff',
    '--mantine-color-default-hover': '#f1f5f9',
    '--mantine-color-default-border': '#e2e8f0',
    '--mantine-color-anchor': '#006bb3',
    '--mantine-color-error': '#dc2626',
    '--mantine-color-success': '#047857',
  },
  dark: {
    '--mantine-color-body': '#0f172a',
    '--mantine-color-text': '#f1f5f9',
    '--mantine-color-dimmed': '#94a3b8',
    '--mantine-color-placeholder': '#64748b',
    '--mantine-color-default': '#1e293b',
    '--mantine-color-default-hover': '#273449',
    '--mantine-color-default-border': '#334155',
    '--mantine-color-anchor': '#4da6ff',
    '--mantine-color-error': '#f87171',
    '--mantine-color-success': '#34d399',
  },
});
