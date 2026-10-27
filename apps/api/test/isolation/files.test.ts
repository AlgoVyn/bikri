import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  addSupportDevice,
  api,
  IDS,
  json,
  seedShop,
  setStatus,
} from '../helpers/fixtures.ts';

async function sha(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const IMG = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 87, 69, 66, 80]);

function upload(
  token: string,
  path: string,
  body: Uint8Array,
  type = 'image/webp',
) {
  return api(`/files/${path}`, {
    method: 'PUT',
    token,
    body,
    headers: { 'content-type': type },
  });
}

describe('files (T-033, I7)', () => {
  it('uploads land under t/<tenant>/; B cannot read A’s relative key (404, same as unknown)', async () => {
    const a = await seedShop('Files A');
    const b = await seedShop('Files B');
    const digest = await sha(IMG);
    const up = await upload(
      a.admin.token,
      `product_image/${IDS.product}/${digest}`,
      IMG,
    );
    expect(up.status).toBe(201);
    const { key } = await json<{ key: string }>(up);
    expect(key).toBe(`products/${IDS.product}/${digest}.webp`);
    expect(await env.FILES.head(`t/${a.tenantId}/${key}`)).not.toBeNull();
    expect(
      (
        await upload(
          a.admin.token,
          `product_image/${IDS.product}/${digest}`,
          IMG,
        )
      ).status,
    ).toBe(200);

    const own = await api(`/files/${key}`, { token: a.till.token });
    expect(own.status).toBe(200);
    expect(own.headers.get('cache-control')).toBe(
      'private, max-age=31536000, immutable',
    );
    expect(new Uint8Array(await own.arrayBuffer())).toEqual(IMG);

    const other = await api(`/files/${key}`, { token: b.till.token });
    const unknown = await api(
      `/files/products/${IDS.product}/${'0'.repeat(64)}.webp`,
      { token: b.till.token },
    );
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual(await unknown.json());
    for (const bad of [
      `../t/${a.tenantId}/${key}`,
      `t/${a.tenantId}/${key}`,
      'd1/2026-10-27.sql.gz',
    ]) {
      expect(
        (await api(`/files/${bad}`, { token: b.till.token })).status,
        bad,
      ).toBe(404);
    }

    const bUp = await upload(
      b.admin.token,
      `product_image/${IDS.product}/${digest}`,
      IMG,
    );
    expect(bUp.status).toBe(201);
    expect(await env.FILES.head(`t/${b.tenantId}/${key}`)).not.toBeNull();
  });

  it('checks digest, type and size; read-only shops and support devices cannot upload', async () => {
    const a = await seedShop('Files C');
    const digest = await sha(IMG);
    expect(
      (
        await upload(
          a.admin.token,
          `product_image/${IDS.product}/${'a'.repeat(64)}`,
          IMG,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await upload(
          a.admin.token,
          `product_image/${IDS.product}/${digest}`,
          IMG,
          'image/gif',
        )
      ).status,
    ).toBe(415);
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    expect(
      (
        await upload(
          a.admin.token,
          `product_image/${IDS.product}/${await sha(big)}`,
          big,
        )
      ).status,
    ).toBe(413);
    const logo = await upload(
      a.admin.token,
      `logo/shop/${digest}`,
      IMG,
      'image/png',
    );
    expect(await json(logo)).toMatchObject({ key: `shop/logo-${digest}.png` });
    const support = await addSupportDevice(a, Date.now() + 60_000);
    expect(
      (
        await upload(
          support.token,
          `product_image/${IDS.product}/${digest}`,
          IMG,
        )
      ).status,
    ).toBe(403);
    await setStatus(a.tenantId, 'read_only');
    const ro = await upload(
      a.admin.token,
      `product_image/${IDS.product}/${digest}`,
      IMG,
    );
    expect(ro.status).toBe(403);
    expect((await json<{ error: { code: string } }>(ro)).error.code).toBe(
      'TENANT_READ_ONLY',
    );
    expect(
      (await api(`/files/shop/logo-${digest}.png`, { token: a.till.token }))
        .status,
    ).toBe(200);
  });
});
