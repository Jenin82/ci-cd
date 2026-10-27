import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepare, sanitizeConfig, validateProductionMigrations } from '../scripts/vinext/config.mjs';
import { projectFromSource } from '../scripts/vinext/source.mjs';
import { build, validateBundle } from '../scripts/vinext/build.mjs';
import { deploymentArgs } from '../scripts/vinext/deploy.mjs';
const previewMigrations = [{ tag: 'vkg-mail-v1', new_sqlite_classes: ['MailDispatcher'] }];
const productionMigrations = [{ tag: 'vkg-prod-mail-v1', new_sqlite_classes: ['ProductionMailDispatcher'] }];
const previewDO = { bindings: [{ name: 'MAIL_DISPATCHER', class_name: 'MailDispatcher' }] };
const productionDO = { bindings: [{ name: 'MAIL_DISPATCHER', class_name: 'ProductionMailDispatcher' }] };
const singapore = { region: 'aws:ap-southeast-1' };
function fixture(branch = 'main') {
  const payload = { repo: 'Jenin82/example', branch, sha: 'a'.repeat(40), source_run_url: 'https://github.com/Jenin82/example/actions/runs/1', project_slug: '' };
  const source = { submodule_repos: [], pkg: { packageManager: 'pnpm@10.15.0', devDependencies: { wrangler: '4.151.0' }, scripts: { 'check:deploy': 'true', 'build:vinext': 'true' } },
    wrangler: { name: 'example', account_id: 'a'.repeat(32), main: 'worker.ts', compatibility_date: '2026-10-15', compatibility_flags: ['nodejs_compat'], workers_dev: true, preview_urls: true,
      assets: { directory: 'dist/client', binding: 'ASSETS' }, durable_objects: structuredClone(productionDO), migrations: structuredClone(previewMigrations),
      env: { staging: { name: 'example', durable_objects: structuredClone(previewDO) }, production: { name: 'example', durable_objects: structuredClone(productionDO), migrations: structuredClone(productionMigrations), placement: structuredClone(singapore) } },
      previews: { durable_objects: structuredClone(previewDO), placement: { region: 'aws:ap-northeast-3' } },
    } };
  return { payload, source };
}
const planFor = ({payload, source}) => prepare(payload, projectFromSource(payload, source, {}));
function generated(source, target = 'production') {
  const config = { ...structuredClone(source.wrangler), ...structuredClone(source.wrangler.env[target]), targetEnvironment: target, no_bundle: true, main: 'index.js', assets: { directory: '../client', binding: 'ASSETS' } };
  delete config.env;
  return config;
}
test('production additive creates and placement survive both passes without deploying Preview classes', () => {
  const f = fixture(), plan = planFor(f), output = sanitizeConfig(generated(f.source), plan);
  assert.deepEqual(output.migrations, productionMigrations);
  assert.deepEqual(output.durable_objects, productionDO);
  assert.deepEqual(output.placement, singapore);
  assert.deepEqual(output.previews.durable_objects, previewDO);
  assert.deepEqual(sanitizeConfig(output, plan), output);
  assert.equal(deploymentArgs(plan, '/config', '/secrets', 'tag')[0], 'deploy');
});
test('staging still selects only Preview migrations and restores production placement for the artifact base', () => {
  const f = fixture('dev'), plan = planFor(f), output = sanitizeConfig(generated(f.source, 'staging'), plan);
  assert.deepEqual(output.migrations, previewMigrations);
  assert.deepEqual(output.durable_objects, productionDO);
  assert.deepEqual(output.placement, singapore);
  assert.deepEqual(output.previews.placement, { region: 'aws:ap-northeast-3' });
  assert.deepEqual(sanitizeConfig(output, plan), output);
});
for (const [name, value] of [
  ['legacy classes', [{ tag: 'v1', new_classes: ['ProductionMailDispatcher'] }]],
  ['deletion', [{ tag: 'v1', deleted_classes: ['ProductionMailDispatcher'] }]],
  ['rename', [{ tag: 'v1', renamed_classes: [{ from: 'Old', to: 'ProductionMailDispatcher' }] }]],
  ['transfer', [{ tag: 'v1', transferred_classes: [{ from: 'Old', from_script: 'other', to: 'ProductionMailDispatcher' }] }]],
  ['extra action', [{ ...productionMigrations[0], sql: 'bad' }]],
  ['unbound class', [{ tag: 'v1', new_sqlite_classes: ['Other'] }]],
  ['Preview class', previewMigrations],
  ['duplicate class', [{ tag: 'v1', new_sqlite_classes: ['ProductionMailDispatcher', 'ProductionMailDispatcher'] }]],
  ['duplicate tag', [...productionMigrations, { tag: 'vkg-prod-mail-v1', new_sqlite_classes: ['Other'] }]],
  ['empty classes', [{ tag: 'v1', new_sqlite_classes: [] }]],
  ['invalid tag', [{ tag: '../bad', new_sqlite_classes: ['ProductionMailDispatcher'] }]],
  ['null', null], ['wrong shape', {}],
]) test(`production source rejects ${name}`, () => {
  const f = fixture(); f.source.wrangler.env.production.migrations = value;
  assert.throws(() => planFor(f), /migration|Migrated|SQLite/);
});
for (const key of ['script_name', 'environment', 'namespace_id', 'id']) test(`production migration rejects binding ${key}`, () => {
  const f = fixture();
  f.source.wrangler.durable_objects.bindings[0][key] = 'other';
  f.source.wrangler.env.production.durable_objects.bindings[0][key] = 'other';
  assert.throws(() => planFor(f), /local name\/class_name/);
});
test('production creation cannot share a Preview class, use alias mode, or execute under staging validation', () => {
  const f = fixture();
  f.source.wrangler.previews.durable_objects.bindings.push({name:'OTHER',class_name:'ProductionMailDispatcher'});
  assert.throws(() => planFor(f), /absent from Previews/);
  const alias = fixture(); delete alias.source.wrangler.previews; delete alias.source.wrangler.migrations;
  assert.throws(() => planFor(alias), /native production/);
  assert.throws(() => validateProductionMigrations(productionMigrations, { nativePreview:true,target:'staging',productionBindings:{durable_objects:productionDO}, previewBindings:{} }), /native production/);
});
for (const change of ['missing','altered','Preview','extra']) test(`production artifact rejects ${change} migrations`, () => {
  const f = fixture(), plan = planFor(f), config = generated(f.source);
  if(change==='missing') delete config.migrations;
  if(change==='altered') config.migrations[0].tag='tampered';
  if(change==='Preview') config.migrations=previewMigrations;
  if(change==='extra') config.migrations.push({tag:'v2',new_sqlite_classes:['Other']});
  assert.throws(() => sanitizeConfig(config,plan), /differ from source|Migrated classes/);
});
test('production explicit empty migrations override inherited Preview creates', () => {
  const f = fixture(); f.source.wrangler.env.production.migrations=[];
  const plan=planFor(f), output=sanitizeConfig(generated(f.source),plan);
  assert.equal(output.migrations,undefined);
  assert.deepEqual(sanitizeConfig(output,plan),output);
  const bad=generated(f.source);bad.migrations=previewMigrations;
  assert.throws(()=>sanitizeConfig(bad,plan),/Migrated classes/);
});
test('source placement is checked in raw builds and sanitized artifacts', () => {
  const f=fixture(),plan=planFor(f), config=generated(f.source);
  config.placement={region:'aws:us-east-1'};
  assert.throws(()=>sanitizeConfig(config,plan),/Unexpected production placement/);
  const output=sanitizeConfig(generated(f.source),plan);delete output.placement;
  assert.throws(()=>sanitizeConfig(output,plan),/Unexpected production placement/);
});
test('production build artifact preserves selected migrations, placement, and tampering checks', () => {
  const dir=mkdtempSync(join(tmpdir(),'vinext-production-'));
  try {
    const f=fixture(),plan=planFor(f),app=join(dir,'app'),artifact=join(dir,'artifact');
    mkdirSync(join(app,'dist/server'),{recursive:true}); mkdirSync(join(app,'dist/client'),{recursive:true});
    writeFileSync(join(app,'package.json'),JSON.stringify(f.source.pkg));writeFileSync(join(app,'pnpm-lock.yaml'),'fixture');
    writeFileSync(join(app,'dist/server/index.js'),'export default {}');writeFileSync(join(app,'dist/server/wrangler.json'),JSON.stringify(generated(f.source)));
    const envFile=join(dir,'env.json');writeFileSync(envFile,'{}');
    build(plan,{appRoot:app,bundleRoot:artifact,envFile,env:{},execute(_command,_args,options){assert.equal(options.env.CLOUDFLARE_ENV,'production');}});
    assert.deepEqual(validateBundle(artifact,plan).config.migrations,productionMigrations);
    const tampered=join(dir,'tampered');cpSync(artifact,tampered,{recursive:true});
    const path=join(tampered,'server/wrangler.json'),config=JSON.parse(readFileSync(path,'utf8'));config.migrations=previewMigrations;writeFileSync(path,JSON.stringify(config));
    assert.throws(()=>validateBundle(tampered,plan),/Migrated classes/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('staging rejects a generated production migration list and placement drift', () => {
  const f = fixture('dev'), plan = planFor(f), config = generated(f.source, 'staging');
  config.migrations = productionMigrations;
  assert.throws(() => sanitizeConfig(config, plan), /Migrated classes/);
  const drift = generated(f.source, 'staging'); drift.placement = singapore;
  assert.throws(() => sanitizeConfig(drift, plan), /Unexpected staging placement/);
});
