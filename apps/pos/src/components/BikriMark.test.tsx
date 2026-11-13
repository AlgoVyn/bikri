import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BikriMark } from './BikriMark.tsx';

afterEach(cleanup);

describe('BikriMark (D-216)', () => {
  it('is decorative and follows the theme by default', () => {
    const { container } = render(<BikriMark className="size-8" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('class')).toContain('size-8');
    const [book, total] = Array.from(container.querySelectorAll('path'));
    expect(book?.getAttribute('class')).toBe('fill-brand-mark');
    expect(total?.getAttribute('class')).toBe('fill-accent');
    // Two distinct shapes: the book (with the tick cut) and the total line beneath it.
    expect(book?.getAttribute('d')).toMatch(/^M11\.26 /);
    expect(total?.getAttribute('d')).toMatch(/^M6\.23 /);
    expect(svg?.getAttribute('data-testid')).toBe('bikri-mark');
  });

  it('uses the rail ink for the book on navy surfaces', () => {
    const { container } = render(<BikriMark tone="reversed" />);
    const book = container.querySelector('path');
    expect(book?.getAttribute('class')).toBe('fill-rail-ink');
  });
});
