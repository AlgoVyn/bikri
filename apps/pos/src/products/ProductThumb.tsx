import { useEffect, useState } from 'react';
import { getDb } from '../data/db.ts';
import { fileUrlFor, getFile } from '../data/fileCache.ts';
import { fetchRemoteFile } from '../sync/files.ts';
import { TILE_BG, tileBg } from './tiles.ts';

/** Object URL of a cached photo for the active shop, or null (works offline, 01 §PWA). */
export function useFileUrl(key: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!key) {
      setUrl(null);
      return;
    }
    let alive = true;
    const db = getDb();
    void fileUrlFor(db.tenantId, key, () =>
      getFile(db.tenantId, key).then((hit) => hit ?? fetchRemoteFile(db, key)),
    )
      .then((next) => {
        if (alive) setUrl(next);
      })
      .catch(() => {
        if (alive) setUrl(null);
      });
    return () => {
      alive = false;
    };
  }, [key]);
  return url;
}

/** Product photo, or a coloured tile with a two-letter monogram (category colour). */
export function ProductThumb({
  name,
  imageKey,
  color,
  size = 'sm',
}: {
  name: string;
  imageKey: unknown;
  color: unknown;
  size?: 'sm' | 'header' | 'md' | 'lg';
}) {
  const url = useFileUrl(typeof imageKey === 'string' ? imageKey : null);
  const box =
    size === 'lg'
      ? 'size-20 rounded-card text-h1'
      : size === 'md'
        ? 'size-16 rounded-card text-h2'
        : size === 'header'
          ? 'size-10 rounded-control'
          : 'size-8 rounded-control';
  const clean = name.trim();
  const words = clean.split(/\s+/).filter(Boolean);
  const monogram =
    (words.length > 1
      ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`
      : clean.slice(0, 2)) || '?';
  if (url) {
    return (
      <img
        src={url}
        alt=""
        data-testid="product-photo"
        className={`${box} shrink-0 object-cover`}
      />
    );
  }
  const palette = typeof color === 'string' && color in TILE_BG ? color : null;
  const rings = [
    'ring-t1/40',
    'ring-t2/40',
    'ring-t3/40',
    'ring-t4/40',
    'ring-t5/40',
    'ring-t6/40',
    'ring-t7/40',
    'ring-t8/40',
  ] as const;
  let hash = 0;
  for (const char of clean) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const ring = rings[hash % rings.length] ?? rings[0];
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center font-semibold ${box} ${
        palette
          ? `text-tile-ink ${tileBg(palette)}`
          : `bg-surface-2 text-text-muted ring-1 ring-inset ${ring}`
      }`}
    >
      {monogram.toUpperCase()}
    </span>
  );
}
