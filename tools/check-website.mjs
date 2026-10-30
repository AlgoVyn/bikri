#!/usr/bin/env node
// Release gate for path-based hosting at https://algovyn.com/bikri/ (docs/01-architecture.md §5.5, D-049).
// Bikri shares the algovyn.com origin with the website, so no page on the origin may load
// third-party JavaScript or register a service worker outside /bikri/.
// Node 24, no dependencies. Exit code 1 on any failure.
//
//   node tools/check-website.mjs                 # checks https://algovyn.com
//   node tools/check-website.mjs --site=https://example.test

const MAX_PAGES = 50;
const ROOT_SW_PATHS = [
  '/sw.js',
  '/service-worker.js',
  '/serviceworker.js',
  '/worker.js',
];
const BIKRI_PREFIX = '/bikri/';

/** @typedef {{ level: 'fail' | 'warn', page: string, rule: string, detail: string }} Finding */

/**
 * Resolve a URL found in a page. Returns null for non-http(s) URLs (data:, blob:, javascript:).
 * @param {string} raw
 * @param {string} base
 * @returns {URL | null}
 */
function resolveUrl(raw, base) {
  try {
    const url = new URL(raw.trim(), base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** @param {string} tag @param {string} name */
function attr(tag, name) {
  const m = tag.match(
    new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'),
  );
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
}

/**
 * Checks JavaScript source (inline or a same-origin file) for imports of other hosts and
 * service worker registrations outside /bikri/.
 * @param {string} js
 * @param {string} sourceUrl
 * @param {string} host
 * @returns {Finding[]}
 */
export function analyzeJs(js, sourceUrl, host) {
  /** @type {Finding[]} */
  const findings = [];
  const importRe =
    /\b(?:import\s*\(\s*|importScripts\s*\(\s*|import\s+(?:[\w*{}\s,]+\s+from\s+)?|export\s+[\w*{}\s,]+\s+from\s+)["'`]([^"'`]+)["'`]/g;
  for (const m of js.matchAll(importRe)) {
    const spec = m[1] ?? '';
    if (!/^(?:https?:)?\/\//i.test(spec)) continue;
    const url = resolveUrl(spec, sourceUrl);
    if (url && url.host !== host) {
      findings.push({
        level: 'fail',
        page: sourceUrl,
        rule: 'third-party-import',
        detail: url.href,
      });
    }
  }
  const swRe = /serviceWorker\s*\.\s*register\s*\(\s*(?:["'`]([^"'`]*)["'`])?/g;
  for (const m of js.matchAll(swRe)) {
    const spec = m[1];
    const url = spec === undefined ? null : resolveUrl(spec, sourceUrl);
    if (!url?.pathname.startsWith(BIKRI_PREFIX)) {
      findings.push({
        level: 'fail',
        page: sourceUrl,
        rule: 'service-worker',
        detail: `serviceWorker.register(${spec === undefined ? '<dynamic>' : JSON.stringify(spec)})`,
      });
    }
  }
  return findings;
}

/**
 * Checks one HTML page.
 * @param {string} html
 * @param {string} pageUrl
 * @param {string} host  e.g. "algovyn.com"
 * @returns {{ findings: Finding[], sameOriginScripts: string[], links: string[] }}
 */
export function analyzeHtml(html, pageUrl, host) {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {string[]} */
  const sameOriginScripts = [];
  /** @type {string[]} */
  const links = [];

  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const m of html.matchAll(scriptRe)) {
    const tag = `<script${m[1] ?? ''}>`;
    const src = attr(tag, 'src');
    if (src !== null) {
      const url = resolveUrl(src, pageUrl);
      if (url && url.host !== host) {
        findings.push({
          level: 'fail',
          page: pageUrl,
          rule: 'third-party-script',
          detail: url.href,
        });
      } else if (url) {
        sameOriginScripts.push(url.href);
      }
    }
    const body = m[2] ?? '';
    const type = (attr(tag, 'type') ?? '').toLowerCase();
    if (
      body.trim() !== '' &&
      type !== 'application/ld+json' &&
      type !== 'application/json'
    ) {
      findings.push(...analyzeJs(body, pageUrl, host));
    }
  }

  // Inline event handlers and other markup can also register a service worker.
  const withoutScripts = html.replace(scriptRe, '');
  if (/serviceWorker\s*\.\s*register/.test(withoutScripts)) {
    findings.push(...analyzeJs(withoutScripts, pageUrl, host));
  }

  const linkRe = /<link\b[^>]*>/gi;
  for (const m of html.matchAll(linkRe)) {
    const tag = m[0];
    const rel = (attr(tag, 'rel') ?? '').toLowerCase();
    const href = attr(tag, 'href');
    const url = href === null ? null : resolveUrl(href, pageUrl);
    if (!url || url.host === host) continue;
    if (rel.includes('modulepreload')) {
      findings.push({
        level: 'fail',
        page: pageUrl,
        rule: 'third-party-script',
        detail: url.href,
      });
    } else if (
      rel.includes('stylesheet') ||
      rel.includes('preload') ||
      rel.includes('preconnect')
    ) {
      findings.push({
        level: 'warn',
        page: pageUrl,
        rule: 'third-party-style-or-font',
        detail: url.href,
      });
    }
  }
  for (const m of html.matchAll(/@import\s+(?:url\()?["']?([^"')\s;]+)/gi)) {
    const url = resolveUrl(m[1] ?? '', pageUrl);
    if (url && url.host !== host) {
      findings.push({
        level: 'warn',
        page: pageUrl,
        rule: 'third-party-style-or-font',
        detail: url.href,
      });
    }
  }

  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = attr(m[0], 'href');
    const url = href === null ? null : resolveUrl(href, pageUrl);
    if (url && url.host === host) links.push(url.origin + url.pathname);
  }

  return { findings, sameOriginScripts, links };
}

/**
 * <loc> entries of a sitemap that are on the same host.
 * @param {string} xml @param {string} host
 */
export function parseSitemap(xml, host) {
  /** @type {string[]} */
  const out = [];
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    const url = resolveUrl(m[1] ?? '', `https://${host}/`);
    if (url && url.host === host) out.push(url.origin + url.pathname);
  }
  return out;
}

/** @param {string} pathname */
export function isBikriPath(pathname) {
  return pathname === '/bikri' || pathname.startsWith(BIKRI_PREFIX);
}

/**
 * Root service worker check: fail when a common SW path answers 200 with JavaScript.
 * @param {string} path @param {number} status @param {string | null} contentType
 * @returns {Finding | null}
 */
export function rootServiceWorkerFinding(path, status, contentType) {
  if (status === 200 && /javascript|ecmascript/i.test(contentType ?? '')) {
    return {
      level: 'fail',
      page: path,
      rule: 'root-service-worker',
      detail: `${path} returns ${status} ${contentType}`,
    };
  }
  return null;
}

/** @param {Finding[]} findings */
export function formatReport(findings) {
  if (findings.length === 0)
    return 'website check: pass (no third-party scripts, no service worker)';
  const rows = findings.map(
    (f) => `| ${f.level.toUpperCase()} | ${f.rule} | ${f.page} | ${f.detail} |`,
  );
  const fails = findings.filter((f) => f.level === 'fail').length;
  const warns = findings.length - fails;
  return [
    '| Level | Rule | Page | Detail |',
    '|---|---|---|---|',
    ...rows,
    '',
    `website check: ${fails > 0 ? 'FAIL' : 'pass'} (${fails} failure(s), ${warns} warning(s))`,
  ].join('\n');
}

/**
 * Crawl and check a site.
 * @param {string} site e.g. "https://algovyn.com"
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<Finding[]>}
 */
export async function checkSite(site, fetchImpl = fetch) {
  const origin = new URL(site);
  const host = origin.host;
  /** @type {Finding[]} */
  const findings = [];

  /** @param {string} url */
  const get = async (url) => {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'bikri-check-website/1' },
    });
    return {
      status: res.status,
      type: res.headers.get('content-type'),
      text: res.ok ? await res.text() : '',
    };
  };

  const home = new URL('/', origin).href;
  const queue = [home];
  try {
    const sm = await get(new URL('/sitemap.xml', origin).href);
    if (sm.status === 200) queue.push(...parseSitemap(sm.text, host));
  } catch {
    // no sitemap is fine
  }

  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Set<string>} */
  const seenJs = new Set();
  while (queue.length > 0 && seen.size < MAX_PAGES) {
    const url = /** @type {string} */ (queue.shift());
    const u = new URL(url);
    if (isBikriPath(u.pathname) || seen.has(u.href)) continue;
    seen.add(u.href);
    let page;
    try {
      page = await get(u.href);
    } catch (err) {
      findings.push({
        level: 'warn',
        page: u.href,
        rule: 'fetch-error',
        detail: String(err),
      });
      continue;
    }
    if (page.status !== 200 || !/html/i.test(page.type ?? '')) continue;
    const result = analyzeHtml(page.text, u.href, host);
    findings.push(...result.findings);
    // Follow every page, not just Home: a third-party script can live on a page
    // reached only through a sitemap or a second-level link.
    queue.push(...result.links);
    for (const js of result.sameOriginScripts) {
      if (seenJs.has(js) || isBikriPath(new URL(js).pathname)) continue;
      seenJs.add(js);
      try {
        const file = await get(js);
        if (file.status === 200)
          findings.push(...analyzeJs(file.text, js, host));
      } catch {
        // unreachable script: the browser would not run it either
      }
    }
  }

  for (const path of ROOT_SW_PATHS) {
    try {
      const res = await fetchImpl(new URL(path, origin).href, {
        redirect: 'manual',
      });
      const f = rootServiceWorkerFinding(
        path,
        res.status,
        res.headers.get('content-type'),
      );
      if (f) findings.push(f);
    } catch {
      // network error: nothing served
    }
  }
  return findings;
}

const isCli =
  import.meta.url === new URL(`file://${process.argv[1] ?? ''}`).href;
if (isCli) {
  const siteArg = process.argv.find((a) => a.startsWith('--site='));
  const site = siteArg
    ? siteArg.slice('--site='.length)
    : 'https://algovyn.com';
  const findings = await checkSite(site);
  const report = formatReport(findings);
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## Website check (${site})\n\n${report}\n`,
    );
  }
  process.exit(findings.some((f) => f.level === 'fail') ? 1 : 0);
}
