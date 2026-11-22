import { describe, expect, it } from 'vitest';
import { i18n, initI18n, pluralRuleCode } from './i18n.ts';

describe('roman-ur plural rules', () => {
  it('maps the invalid BCP-47 tag to English plural categories', async () => {
    expect(pluralRuleCode('roman-ur')).toBe('en');
    expect(pluralRuleCode('roman-UR')).toBe('en');
    expect(pluralRuleCode('ur')).toBe('ur');
    await initI18n('roman-ur');
    const resolver = (
      i18n.services as unknown as {
        pluralResolver: {
          getRule: (code: string) => Intl.PluralRules;
        };
      }
    ).pluralResolver;
    expect(resolver.getRule('roman-ur').resolvedOptions().locale).toBe('en');
    expect(i18n.t('pay.items_count', { count: 2 })).not.toBe('pay.items_count');
  });
});
