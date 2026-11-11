'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path');
const { appServerFixture } = require('./app_server_fixture');
const { normalizeSpeed } = require('../codex_speed');
const { readSessionRuntimeProfile } = require('../tracker');
const { contextConfig } = require('../codex_new_chat');

async function until(check) {
  for (let i = 0; i < 180; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Native speed verification timed out.');
}

test('native speed selection overrides defaults, reaches the first request and survives resume', { timeout: 40000 }, async () => {
  const f = await appServerFixture();
  try {
    const configFile = path.join(f.home, 'config.toml'), original = await fs.readFile(configFile, 'utf8');
    // This isolated catalog advertises all three tiers without changing the
    // user's catalog or access. All requests still terminate at loopback.
    const catalogSource = process.env.CST_MODEL_CATALOG || path.join(process.env.USERPROFILE, '.codex', 'models_cache.json');
    const catalog = JSON.parse(await fs.readFile(catalogSource, 'utf8'));
    const model = catalog.models.find(item => item.slug === 'gpt-6-astra');
    assert.ok(model);
    const fixtureCatalog = path.join(f.root, 'models.json');
    await fs.writeFile(fixtureCatalog, JSON.stringify({ models: [{ ...model, service_tiers: [
      { id: 'priority', name: 'Fast', description: 'Fixture Fast' }, { id: 'ultrafast', name: 'Ultrafast', description: 'Fixture Ultrafast' }
    ] }] }));
    await fs.writeFile(configFile, 'service_tier="fast"\nmodel_catalog_json=' + JSON.stringify(fixtureCatalog) + '\n' + original.replace('[model_providers.fixture]', '[features]\nfast_mode=true\n[model_providers.fixture]'));
    await f.restart();
    const nativeCatalog = await f.rpc('model/list', { limit: 100, includeHidden: false });
    const modelInfo = nativeCatalog.data.find(model => (model.model || model.id) === 'gpt-6-astra');
    assert.ok(modelInfo.serviceTiers.some(tier => tier.id === 'ultrafast'));
    const threads = [];
    for (const tier of ['default', 'priority', 'ultrafast']) {
      const before = f.requests.length;
      const thread = await f.backend.createFreshChat({ cwd: f.root, model: 'gpt-6-astra', serviceTier: tier, message: 'Speed fixture ' + tier,
        contextConfig: contextConfig('400k', { effectivePercent: 95 }) });
      await until(() => f.requests.length > before);
      await until(async () => (await f.rpc('thread/read', { threadId: thread.id, includeTurns: false })).thread.status.type === 'idle');
      const wire = f.requests[before].service_tier;
      const runtime = await readSessionRuntimeProfile(thread.path);
      console.log(JSON.stringify({ selected: tier, wire: wire ?? null, runtime: runtime.serviceTier }));
      assert.equal(normalizeSpeed(wire ?? null), tier); assert.equal(runtime.serviceTier, tier);
      if (tier === 'default') {
        const records = (await fs.readFile(thread.path, 'utf8')).trim().split('\n').map(JSON.parse);
        console.log('Runtime provenance: ' + JSON.stringify({ cliVersion: records.find(r => r.type === 'session_meta')?.payload.cli_version,
          model: records.find(r => r.type === 'turn_context')?.payload.model }));
      }
      threads.push({ ...thread, serviceTier: tier });
    }
    await f.restart();
    for (const thread of threads) {
      const before = f.requests.length;
      await f.backend.continueConversation({ conversationId: thread.id, input: [{ type: 'text', text: 'Continue the speed fixture.' }] });
      await until(() => f.requests.length > before);
      assert.equal(normalizeSpeed(f.requests[before].service_tier ?? null), thread.serviceTier, 'native speed persists after host restart');
      await until(async () => (await f.rpc('thread/read', { threadId: thread.id, includeTurns: false })).thread.status.type === 'idle');
    }
    console.log('All three speeds reached native model requests and resumed correctly; external model requests: 0.');
  } finally { await f.close(); }
});
