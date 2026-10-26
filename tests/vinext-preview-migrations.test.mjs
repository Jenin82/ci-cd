import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepare, sanitizeConfig } from '../scripts/vinext/config.mjs';
import { projectFromSource } from '../scripts/vinext/source.mjs';
import { build, validateBundle } from '../scripts/vinext/build.mjs';
import { deploymentArgs } from '../scripts/vinext/deploy.mjs';

const migrations = [{ tag: 'vkg-mail-v1', new_sqlite_classes: ['MailDispatcher'] }];
const durableObjects = { bindings: [{ name: 'MAIL_DISPATCHER', class_name: 'MailDispatcher' }] };
function fixture() {
  const payload = {
    repo: 'Jenin82/example', branch: 'dev', sha: 'a'.repeat(40),
    source_run_url: 'https://github.com/Jenin82/example/actions/runs/1', project_slug: '',
  };
  const source = {
    submodule_repos: [],
    pkg: { packageManager: 'pnpm@10.15.0', devDependencies: { wrangler: '4.151.0' }, scripts: { 'check:deploy': 'true', 'build:vinext': 'true' } },
    wrangler: {
      name: 'example', account_id: 'a'.repeat(32), main: 'vinext/server/fetch-handler',
      compatibility_date: '2026-10-15', compatibility_flags: ['nodejs_compat'], workers_dev: true, preview_urls: true,
      assets: { directory: 'dist/client', binding: 'ASSETS' },
      env: { staging: { name: 'example', durable_objects: structuredClone(durableObjects) }, production: { name: 'example' } },
      previews: { durable_objects: structuredClone(durableObjects) }, migrations: structuredClone(migrations),
    },
  };
  return { payload, source };
}
function planFor(payload, source) { return prepare(payload, projectFromSource(payload, source, {})); }
function generated(source, target = 'staging') {
  const config = {
    ...structuredClone(source.wrangler), ...structuredClone(source.wrangler.env[target]),
    no_bundle: true, targetEnvironment: target, main: 'index.js',
    assets: { directory: '../client', binding: 'ASSETS' },
  };
  delete config.env;
  return config;
}

test('source-owned SQLite Preview migrations survive both artifact sanitization passes without production bindings', () => {
  const { payload, source } = fixture(), plan = planFor(payload, source);
  assert.deepEqual(plan.project.preview_migrations, migrations);
  assert.notEqual(plan.project.preview_migrations, source.wrangler.migrations);
  const config = sanitizeConfig(generated(source), plan);
  assert.deepEqual(config.migrations, migrations);
  assert.deepEqual(config.previews.durable_objects, durableObjects);
  assert.equal(config.durable_objects, undefined);
  assert.equal(config.env, undefined);
  assert.deepEqual(sanitizeConfig(config, plan), config);
  const args = deploymentArgs(plan, '/bundle/wrangler.json', '/private/secrets.json', 'test-tag');
  assert.deepEqual(args.slice(0, 3), ['preview', '--name', 'stg']);
  assert.ok(args.includes('--ignore-base-config'));
  assert.equal(args.includes('deploy'), false);
});

for (const [name, value] of [
  ['legacy class creation', [{ tag: 'v1', new_classes: ['MailDispatcher'] }]],
  ['class deletion', [{ tag: 'v1', deleted_classes: ['MailDispatcher'] }]],
  ['class rename', [{ tag: 'v1', renamed_classes: [{ from: 'Old', to: 'MailDispatcher' }] }]],
  ['class transfer', [{ tag: 'v1', transferred_classes: [{ from: 'Old', from_script: 'production', to: 'MailDispatcher' }] }]],
  ['SQL injection field', [{ tag: 'v1', new_sqlite_classes: ['MailDispatcher'], sql: 'DROP TABLE secrets' }]],
  ['empty classes', [{ tag: 'v1', new_sqlite_classes: [] }]],
  ['unbound class', [{ tag: 'v1', new_sqlite_classes: ['Unbound'] }]],
  ['duplicate classes', [{ tag: 'v1', new_sqlite_classes: ['MailDispatcher', 'MailDispatcher'] }]],
  ['duplicate tags', [...migrations, { tag: 'vkg-mail-v1', new_sqlite_classes: ['Other'] }]],
  ['duplicate class across migrations', [...migrations, { tag: 'v2', new_sqlite_classes: ['MailDispatcher'] }]],
  ['invalid tag', [{ tag: '../v1', new_sqlite_classes: ['MailDispatcher'] }]],
  ['wrong shape', { tag: 'v1', new_sqlite_classes: ['MailDispatcher'] }],
  ['null migrations', null],
  ['oversized list', Array.from({ length: 101 }, (_, index) => ({ tag: `v${index}`, new_sqlite_classes: ['MailDispatcher'] }))],
]) {
  test(`source rejects ${name}`, () => {
    const { payload, source } = fixture();
    source.wrangler.migrations = value;
    assert.throws(() => planFor(payload, source), /migration|Migrated|SQLite/);
  });
}

for (const forbidden of ['script_name', 'environment', 'namespace_id', 'id']) {
  test(`source rejects a migrated binding with ${forbidden}`, () => {
    const { payload, source } = fixture();
    source.wrangler.previews.durable_objects.bindings[0][forbidden] = 'production';
    assert.throws(() => planFor(payload, source), /local name\/class_name/);
  });
}

test('source rejects duplicate Preview binding names and missing Preview bindings', () => {
  const { payload, source } = fixture();
  source.wrangler.previews.durable_objects.bindings.push(structuredClone(durableObjects.bindings[0]));
  assert.throws(() => planFor(payload, source), /Duplicate Preview/);
  delete source.wrangler.previews.durable_objects;
  assert.throws(() => planFor(payload, source), /require Preview bindings/);
});

for (const scope of ['top-level', 'production environment']) {
  test(`source rejects a migrated class bound in ${scope}`, () => {
    const { payload, source } = fixture();
    if (scope === 'top-level') source.wrangler.durable_objects = structuredClone(durableObjects);
    else source.wrangler.env.production.durable_objects = structuredClone(durableObjects);
    assert.throws(() => planFor(payload, source), /absent from production/);
  });
}

test('nonempty migrations are rejected for production dispatch and direct production plans', () => {
  const { payload, source } = fixture();
  assert.throws(() => planFor({ ...payload, branch: 'main' }, source), /only for native staging/);
  const project = projectFromSource(payload, source, {});
  assert.throws(() => prepare({ ...payload, branch: 'main' }, project), /only for native staging/);
  const plan = planFor(payload, source);
  assert.throws(() => sanitizeConfig(generated(source, 'production'), { ...plan, target: 'production' }), /only for native staging/);
});

test('nonempty migrations are rejected for legacy alias deployment', () => {
  const { payload, source } = fixture();
  delete source.wrangler.previews;
  assert.throws(() => planFor(payload, source), /only for native staging/);
});

for (const change of ['missing', 'changed', 'extra']) {
  test(`generated ${change} migrations cannot differ from the exact source list`, () => {
    const { payload, source } = fixture(), plan = planFor(payload, source), config = generated(source);
    if (change === 'missing') delete config.migrations;
    if (change === 'changed') config.migrations[0].tag = 'different-tag';
    if (change === 'extra') config.migrations.push({ tag: 'v2', new_sqlite_classes: ['Other'] });
    assert.throws(() => sanitizeConfig(config, plan), /differ from source|Migrated classes/);
  });
}

test('generated-only migrations and altered artifact actions are rejected', () => {
  const { payload, source } = fixture(), original = generated(source);
  delete source.wrangler.migrations;
  const plan = planFor(payload, source);
  assert.throws(() => sanitizeConfig(original, plan), /differ from source/);
  const withSource = fixture(), declaredPlan = planFor(withSource.payload, withSource.source), altered = generated(withSource.source);
  altered.migrations[0].deleted_classes = ['MailDispatcher'];
  assert.throws(() => sanitizeConfig(altered, declaredPlan), /Only tag and new_sqlite_classes/);
});

test('existing native production and alias projects without migrations retain their binding behavior', () => {
  for (const native of [true, false]) {
    for (const branch of ['dev', 'main']) {
      const { payload, source } = fixture();
      delete source.wrangler.migrations;
      delete source.wrangler.env.staging.durable_objects;
      if (native) source.wrangler.previews = {};
      else delete source.wrangler.previews;
      const plan = planFor({ ...payload, branch }, source), config = generated(source, plan.target);
      config.migrations = [];
      const output = sanitizeConfig(config, plan);
      assert.equal(output.migrations, undefined);
      assert.equal(output.durable_objects, undefined);
      assert.equal(plan.project.preview_migrations, undefined);
      assert.deepEqual(sanitizeConfig(output, plan), output);
    }
  }
});

test('real build staging retains migrations in the deploy artifact and revalidates tampering', () => {
  const directory = mkdtempSync(join(tmpdir(), 'vinext-preview-migrations-'));
  try {
    const { payload, source } = fixture(), plan = planFor(payload, source), app = join(directory, 'app'), artifact = join(directory, 'artifact');
    mkdirSync(join(app, 'dist/server'), { recursive: true });
    mkdirSync(join(app, 'dist/client'), { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify(source.pkg));
    writeFileSync(join(app, 'pnpm-lock.yaml'), 'fixture frozen lock');
    writeFileSync(join(app, 'dist/server/index.js'), 'export default { fetch() { return new Response("fixture") } }');
    writeFileSync(join(app, 'dist/server/wrangler.json'), JSON.stringify(generated(source)));
    const envFile = join(directory, 'build-values.json');
    writeFileSync(envFile, '{}');
    const executed = [];
    build(plan, { appRoot: app, bundleRoot: artifact, envFile, env: {}, execute(command, args, options) {
      executed.push({ command, args });
      assert.equal(options.env.CLOUDFLARE_ENV, 'staging');
    } });
    assert.equal(executed.length, 3);
    assert.equal(existsSync(envFile), false);
    assert.deepEqual(validateBundle(artifact, plan).config.migrations, migrations);
    assert.deepEqual(JSON.parse(readFileSync(join(artifact, 'vinext-release.json'), 'utf8')), { repo: payload.repo, sha: payload.sha, target: 'staging', worker: 'example' });
    const duplicate = join(directory, 'tampered');
    cpSync(artifact, duplicate, { recursive: true });
    const path = join(duplicate, 'server/wrangler.json'), changed = JSON.parse(readFileSync(path, 'utf8'));
    changed.migrations[0].tag = 'changed-after-build';
    writeFileSync(path, JSON.stringify(changed));
    assert.throws(() => validateBundle(duplicate, plan), /differ from source/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
