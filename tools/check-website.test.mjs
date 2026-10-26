import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  analyzeHtml,
  analyzeJs,
  checkSite,
  formatReport,
  parseSitemap,
} from './check-website.mjs';

// Sample-based tests for the go-live gate (docs/10-testing.md §7, 01 §5.5).
const HOST = 'algovyn.com';
const PAGE = 'https://algovyn.com/';
const sample = (name) =>
  readFileSync(new URL(`./fixtures/website/${name}`, import.meta.url), 'utf8');
const levels = (findings) => findings.map((f) => `${f.level}:${f.rule}`);

describe('analyzeHtml', () => {
  it('fails a page that loads cdn.tailwindcss.com', () => {
    const { findings } = analyzeHtml(sample('tailwind-cdn.html'), PAGE, HOST);
    expect(levels(findings)).toEqual(['fail:third-party-script']);
    expect(findings[0]?.detail).toBe('https://cdn.tailwindcss.com/');
  });

  it("fails a page that calls navigator.serviceWorker.register('/sw.js')", () => {
    const { findings } = analyzeHtml(sample('service-worker.html'), PAGE, HOST);
    expect(levels(findings)).toEqual(['fail:service-worker']);
  });

  it('only warns for a Google Fonts stylesheet', () => {
    const { findings, sameOriginScripts } = analyzeHtml(
      sample('google-fonts.html'),
      PAGE,
      HOST,
    );
    expect(findings.every((f) => f.level === 'warn')).toBe(true);
    expect(findings.length).toBeGreaterThan(0);
    expect(sameOriginScripts).toEqual(['https://algovyn.com/assets/site.js']);
  });

  it('passes a clean page and collects same-host links', () => {
    const { findings, links } = analyzeHtml(sample('clean.html'), PAGE, HOST);
    expect(findings).toEqual([]);
    expect(links).toEqual([
      'https://algovyn.com/',
      'https://algovyn.com/bikri/',
    ]);
  });

  it('fails protocol-relative script hosts', () => {
    const { findings } = analyzeHtml(
      '<script src="//evil.example/x.js"></script>',
      PAGE,
      HOST,
    );
    expect(levels(findings)).toEqual(['fail:third-party-script']);
  });
});

describe('analyzeJs', () => {
  it('fails dynamic import / importScripts / module import of another host', () => {
    const js = [
      "import('https://cdn.example/a.js');",
      "importScripts('https://cdn.example/b.js');",
      "import x from 'https://esm.sh/react';",
      "import y from './local.js';",
    ].join('\n');
    expect(levels(analyzeJs(js, PAGE, HOST))).toEqual([
      'fail:third-party-import',
      'fail:third-party-import',
      'fail:third-party-import',
    ]);
  });

  it('allows a service worker registered under /bikri/', () => {
    expect(
      analyzeJs("navigator.serviceWorker.register('/bikri/sw.js')", PAGE, HOST),
    ).toEqual([]);
    expect(
      levels(analyzeJs('navigator.serviceWorker.register(url)', PAGE, HOST)),
    ).toEqual(['fail:service-worker']);
  });
});

describe('checkSite', () => {
  const site = (pages) => async (url) => {
    const path = new URL(url).pathname;
    const page = pages[path];
    if (!page)
      return new Response('not found', {
        status: 404,
        headers: { 'content-type': 'text/html' },
      });
    return new Response(page.body, {
      status: 200,
      headers: { 'content-type': page.type },
    });
  };

  it('crawls sitemap pages, home links and same-origin JS; skips /bikri/', async () => {
    const fetchImpl = site({
      '/': { type: 'text/html', body: sample('google-fonts.html') },
      '/sitemap.xml': {
        type: 'application/xml',
        body: '<urlset><url><loc>https://algovyn.com/smartgrind</loc></url><url><loc>https://other.example/x</loc></url></urlset>',
      },
      '/smartgrind': { type: 'text/html', body: sample('clean.html') },
      '/marksocial': { type: 'text/html', body: sample('tailwind-cdn.html') },
      '/assets/site.js': {
        type: 'text/javascript',
        body: "import('https://cdn.example/a.js')",
      },
      '/assets/menu.js': {
        type: 'text/javascript',
        body: 'export const init = () => {}',
      },
      '/bikri/': { type: 'text/html', body: sample('service-worker.html') },
    });
    const findings = await checkSite('https://algovyn.com', fetchImpl);
    const fails = findings
      .filter((f) => f.level === 'fail')
      .map((f) => `${f.rule} ${f.page}`);
    expect(fails.sort()).toEqual(
      [
        'third-party-import https://algovyn.com/assets/site.js',
        'third-party-script https://algovyn.com/marksocial',
      ].sort(),
    );
    expect(formatReport(findings)).toContain('FAIL');
  });

  it('fails when /sw.js at the site root is JavaScript', async () => {
    const fetchImpl = site({
      '/': { type: 'text/html', body: sample('clean.html') },
      '/sw.js': {
        type: 'application/javascript',
        body: 'self.addEventListener("fetch", () => {})',
      },
    });
    const findings = await checkSite('https://algovyn.com', fetchImpl);
    expect(levels(findings)).toEqual(['fail:root-service-worker']);
  });

  it('passes a clean site', async () => {
    const fetchImpl = site({
      '/': { type: 'text/html', body: sample('clean.html') },
    });
    const findings = await checkSite('https://algovyn.com', fetchImpl);
    expect(findings).toEqual([]);
    expect(formatReport(findings)).toContain('pass');
  });
});

describe('parseSitemap', () => {
  it('keeps same-host <loc> entries only', () => {
    const xml =
      '<loc>https://algovyn.com/</loc><loc> https://algovyn.com/marksocial </loc><loc>https://x.example/</loc>';
    expect(parseSitemap(xml, HOST)).toEqual([
      'https://algovyn.com/',
      'https://algovyn.com/marksocial',
    ]);
  });
});
