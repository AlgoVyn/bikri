#!/usr/bin/env node
// Release version guard (AGENTS.md §4, docs/10-testing.md §7):
// the deployed APP_VERSION must agree across the till, Worker, generated types,
// architecture doc, README, changelog and perf seed, and the schema numbers must
// stay ordered. Node 24, no dependencies. Exit code 1 on any problem.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** @param {string} text @param {RegExp} re @returns {string | undefined} */
function first(text, re) {
  return re.exec(text)?.[1];
}

const core = read('packages/core/src/version.ts');
const wrangler = read('apps/api/wrangler.jsonc');
const generated = read('apps/api/worker-configuration.d.ts');
const architecture = read('docs/01-architecture.md');
const readme = read('README.md');
const changelog = read('CHANGELOG.md');
const seed = read('tools/seed/perf-shop.mjs');

const coreApp = first(core, /APP_VERSION\s*=\s*'([^']+)'/u);
const clientSchema = first(core, /CLIENT_SCHEMA_VERSION\s*=\s*(\d+)/u);
const serverApp = first(wrangler, /"APP_VERSION"\s*:\s*"([^"]+)"/u);
const serverSchema = first(wrangler, /"SCHEMA_VERSION"\s*:\s*"(\d+)"/u);
const minClientSchema = first(wrangler, /"MIN_CLIENT_SCHEMA"\s*:\s*"(\d+)"/u);
const generatedApp = first(generated, /APP_VERSION:\s*"([^"]+)"/u);
const generatedSchema = first(generated, /SCHEMA_VERSION:\s*"(\d+)"/u);
const generatedMin = first(generated, /MIN_CLIENT_SCHEMA:\s*"([^"]+)"/u);
const docApp = first(architecture, /"APP_VERSION":\s*"([^"]+)"/u);
const docSchema = first(architecture, /"SCHEMA_VERSION":\s*"(\d+)"/u);
const readmeApp = first(readme, /^v(\d+\.\d+\.\d+)\.\s/mu);
const seedApp = first(seed, /app_version:\s*'([^']+)'/u);

const problems = [];

if (!coreApp || !/^\d+\.\d+\.\d+$/u.test(coreApp)) {
  problems.push(
    `packages/core/src/version.ts APP_VERSION is not semver: ${coreApp ?? 'missing'}`,
  );
} else {
  /** @type {Array<[string, string | undefined]>} */
  const appChecks = [
    ['apps/api/wrangler.jsonc APP_VERSION', serverApp],
    ['apps/api/worker-configuration.d.ts APP_VERSION', generatedApp],
    ['docs/01-architecture.md APP_VERSION', docApp],
    ['README.md Status version', readmeApp],
    ['tools/seed/perf-shop.mjs app_version', seedApp],
  ];
  for (const [label, value] of appChecks) {
    if (value !== coreApp)
      problems.push(`${label}: ${value ?? 'missing'} (expected ${coreApp})`);
  }
  const releaseHeading = new RegExp(
    `^## \\[${coreApp.replaceAll('.', '\\.')}\\]`,
    'mu',
  );
  if (!releaseHeading.test(changelog))
    problems.push(`CHANGELOG.md: no ## [${coreApp}] release heading`);
}

const schemaPairs = [
  [
    'apps/api/worker-configuration.d.ts SCHEMA_VERSION',
    generatedSchema,
    serverSchema,
  ],
  ['docs/01-architecture.md SCHEMA_VERSION', docSchema, serverSchema],
  [
    'apps/api/worker-configuration.d.ts MIN_CLIENT_SCHEMA',
    generatedMin,
    minClientSchema,
  ],
];
for (const [label, value, expected] of schemaPairs) {
  if (!expected || value !== expected)
    problems.push(
      `${label}: ${value ?? 'missing'} (expected ${expected ?? 'a value'})`,
    );
}

const server = Number(serverSchema);
const client = Number(clientSchema);
const minimum = Number(minClientSchema);
if (
  !Number.isInteger(server) ||
  !Number.isInteger(client) ||
  !Number.isInteger(minimum)
) {
  problems.push(
    `schema versions must be integers: min ${minClientSchema ?? '?'}, client ${clientSchema ?? '?'}, server ${serverSchema ?? '?'}`,
  );
} else if (!(minimum <= client && client <= server)) {
  problems.push(
    `schema versions out of order: MIN_CLIENT_SCHEMA ${minimum} <= CLIENT_SCHEMA_VERSION ${client} <= SCHEMA_VERSION ${server}`,
  );
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(`versions check: FAIL (${problems.length})`);
  process.exit(1);
}
console.log(
  `versions check: pass (APP_VERSION ${coreApp}; schema ${minimum}..${client}/${server})`,
);
