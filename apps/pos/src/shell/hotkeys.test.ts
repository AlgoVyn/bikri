import { afterEach, describe, expect, it } from 'vitest';
import { dialogOpen } from './hotkeys.ts';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('dialogOpen', () => {
  it('is false when nothing modal is mounted', () => {
    expect(dialogOpen()).toBe(false);
  });

  it('matches a Radix dialog by data-state, not only aria-modal', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('data-state', 'open');
    document.body.append(dialog);
    expect(dialogOpen()).toBe(true);
    dialog.setAttribute('data-state', 'closed');
    expect(dialogOpen()).toBe(false);
  });

  it('matches an alertdialog with aria-modal and a native open dialog', () => {
    const alert = document.createElement('div');
    alert.setAttribute('role', 'alertdialog');
    alert.setAttribute('aria-modal', 'true');
    document.body.append(alert);
    expect(dialogOpen()).toBe(true);
    alert.remove();

    const native = document.createElement('dialog');
    native.open = true;
    document.body.append(native);
    expect(dialogOpen()).toBe(true);
  });
});
