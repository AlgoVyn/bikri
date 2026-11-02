import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { gcTenantFiles } from '../../src/platform/filesGc.ts';
import { tenantById } from '../../src/platform/tenantAdmin.ts';
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
  staffId: string = IDS.owner,
) {
  return api(`/files/${path}`, {
    method: 'PUT',
    token,
    body,
    headers: { 'content-type': type, 'x-bikri-staff': staffId },
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

    // A JPEG keeps its extension so the stored object is served with the right type.
    const jpeg = new Uint8Array([255, 216, 255, 224, 1, 2, 3, 4]);
    const jpegDigest = await sha(jpeg);
    const jpegUp = await upload(
      a.admin.token,
      `product_image/${IDS.product}/${jpegDigest}`,
      jpeg,
      'image/jpeg',
    );
    expect(jpegUp.status).toBe(201);
    const { key: jpegKey } = await json<{ key: string }>(jpegUp);
    expect(jpegKey).toBe(`products/${IDS.product}/${jpegDigest}.jpg`);
    expect(
      (await api(`/files/${jpegKey}`, { token: a.till.token })).status,
    ).toBe(200);

    const bUp = await upload(
      b.admin.token,
      `product_image/${IDS.product}/${digest}`,
      IMG,
    );
    expect(bUp.status).toBe(201);
    expect(await env.FILES.head(`t/${b.tenantId}/${key}`)).not.toBeNull();
  });

  it('checks digest, type and size; permissions, read-only shops and support devices', async () => {
    const a = await seedShop('Files C');
    const digest = await sha(IMG);
    // A cashier lacks catalog.edit, so the photo upload is refused.
    expect(
      (
        await upload(
          a.till.token,
          `product_image/${IDS.product}/${digest}`,
          IMG,
          'image/webp',
          IDS.cashier,
        )
      ).status,
    ).toBe(403);
    // The logo needs shop settings, not just any unlocked staff member.
    expect(
      (
        await upload(
          a.admin.token,
          `logo/shop/${digest}`,
          IMG,
          'image/png',
          IDS.cashier,
        )
      ).status,
    ).toBe(403);
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
    expect(
      (
        await upload(
          a.admin.token,
          `product_image/01JC0000000000000000000099/${digest}`,
          IMG,
        )
      ).status,
    ).toBe(404);
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
    expect(
      (await upload(a.admin.token, `logo/shop/${digest}`, IMG, 'image/webp'))
        .status,
    ).toBe(415);
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

  it('GC removes only unreferenced A objects and never touches B', async () => {
    const a = await seedShop('Files GC A');
    const b = await seedShop('Files GC B');
    const digest = await sha(IMG);
    const up = await upload(
      a.admin.token,
      `product_image/${IDS.product}/${digest}`,
      IMG,
    );
    const { key } = await json<{ key: string }>(up);
    await env.DB.prepare(
      'UPDATE products SET image_key = ?3 WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(a.tenantId, IDS.product, key)
      .run();
    const orphanA = `products/${IDS.product}/${'a'.repeat(64)}.webp`;
    const orphanB = `shop/logo-${'b'.repeat(64)}.png`;
    await env.FILES.put(`t/${a.tenantId}/${orphanA}`, IMG);
    await env.FILES.put(`t/${b.tenantId}/${orphanB}`, IMG);
    const tenant = await tenantById(env, a.tenantId);
    if (!tenant) throw new Error('tenant missing');
    const result = await gcTenantFiles(env, tenant, {
      now: Date.now() + 2 * 24 * 60 * 60 * 1000,
      dryRun: false,
    });
    expect(result).toMatchObject({ unreferenced: 1, deleted: 1 });
    expect(await env.FILES.head(`t/${a.tenantId}/${key}`)).not.toBeNull();
    expect(await env.FILES.head(`t/${a.tenantId}/${orphanA}`)).toBeNull();
    expect(await env.FILES.head(`t/${b.tenantId}/${orphanB}`)).not.toBeNull();
  });
});
