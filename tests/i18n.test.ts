import { describe, expect, it } from 'vitest';
import { languageKeys, t } from '../src/core/i18n';

describe('Korean copy', () => {
  it('has a Korean string for every English key', () => {
    const keys = languageKeys();
    expect(keys.ko.slice().sort()).toEqual(keys.en.slice().sort());
  });

  it('substitutes placeholders', () => {
    expect(t('drawn', { n: 2 })).toMatch(/2/);
  });
});
