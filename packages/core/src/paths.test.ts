import { describe, expect, it } from 'vitest';
import { API_BASE, BASE_PATH } from './paths.ts';

describe('paths', () => {
  it('defines the public base path and the API base', () => {
    expect(BASE_PATH).toBe('/bikri');
    expect(API_BASE).toBe('/bikri/api');
    expect(API_BASE).toBe(`${BASE_PATH}/api`);
  });
});
