import { useEffect, useState } from 'react';
import { getDb } from '../data/db.ts';
import { getFile } from '../data/fileCache.ts';
import { fetchRemoteFile } from '../sync/files.ts';
import { tileBg } from './tiles.ts';

/** Object URL of a cached photo for the active shop, or null (works offline, 01 §PWA). */
export function useFileUrl(key: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!key) {
      setUrl(null);
      return;
    }
    let alive = true;
    let made: string | null = null;
    const db = getDb();
    void getFile(db.tenantId, key)
      .then((hit) => hit ?? fetchRemoteFile(db, key))
      .then((blob) => {
        if (!alive || !blob) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      });
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
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
  size?: 'sm' | 'md' | 'lg';
}) {
  const url = useFileUrl(typeof imageKey === 'string' ? imageKey : null);
  const box =
    size === 'lg'
      ? 'size-20 rounded-card text-h1'
      : size === 'md'
        ? 'size-16 rounded-card text-h2'
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
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center font-semibold text-tile-ink ${box} ${tileBg(color)}`}
    >
      {monogram.toUpperCase()}
    </span>
  );
}
