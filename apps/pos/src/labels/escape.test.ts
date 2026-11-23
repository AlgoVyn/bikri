import { describe, expect, it } from 'vitest';
import { escapeLabelHtml } from './escape.ts';

describe('label HTML escaping', () => {
  it('escapes quotes (including apostrophes) and markup', () => {
    expect(escapeLabelHtml(`Ali's "Best" <Shop> & Co`)).toBe(
      'Ali&#39;s &quot;Best&quot; &lt;Shop&gt; &amp; Co',
    );
    expect(escapeLabelHtml('&')).toBe('&amp;');
  });
});
