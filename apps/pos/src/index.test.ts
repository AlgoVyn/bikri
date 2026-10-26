import { API_BASE, BASE_PATH } from '@bikri/core';
import { describe, expect, it } from 'vitest';

describe('@bikri/pos', () => {
  it('uses the shared base path', () => {
    expect(BASE_PATH).toBe('/bikri');
    expect(API_BASE).toBe(`${BASE_PATH}/api`);
  });
});
