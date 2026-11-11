import { useEffect, useRef, useState } from 'react';
import { PageLoading } from '../components/PageLoading.tsx';
import { seedDemoShop } from './seed.ts';

/**
 * Dev-only body of `/dev/demo`: reset the local dev shop to a demo catalogue, then
 * reload into Sell. Loaded lazily so production never ships the seed code.
 */
export default function DemoPage() {
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);
  // StrictMode mounts effects twice in dev; the ref keeps the reset idempotent.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        await seedDemoShop();
        window.location.replace(`${import.meta.env.BASE_URL}sell`);
      } catch (err) {
        console.error(err);
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);
  if (error) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6 text-center">
        <p className="text-danger">{error}</p>
      </main>
    );
  }
  return <PageLoading />;
}
