import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { createChromeImportRegistry } = createRequire(import.meta.url)('../native/electron/chrome-import-registry.cjs');
test('one Chrome account stays linked to each imported Iris partition across restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-link-test-'));
  try {
    let tick = 0;
    const make = () => createChromeImportRegistry({stateDir: dir, fs, path, now: () => ++tick});
    const profile = {browser:{id:'chrome'}, profile:'Default', gaia:'synthetic-id', label:'Test'};
    const registry = make();
    registry.note(profile, 'persist:acprof:a');
    registry.note(profile, 'persist:acprof:b');
    for (const r of [registry, make()]) {
      assert.equal(r.latestForPartition('persist:acprof:a')?.cid, 'chrome:Default');
      assert.equal(r.latestForPartition('persist:acprof:b')?.cid, 'chrome:Default');
      assert.equal(r.has(profile), true);
    }
    registry.backfill([{entry: {...profile, profile:'Profile 1'}, partition:'persist:acprof:a'}]);
    assert.equal(registry.latestForPartition('persist:acprof:a')?.cid, 'chrome:Default');
    registry.note({...profile, gaia:'second-account', profile:'Profile 2'},'persist:acprof:a');
    assert.equal(registry.latestForPartition('persist:acprof:a')?.cid,'chrome:Profile 2');
    assert.equal(registry.latestForPartition('persist:acprof:b')?.cid,'chrome:Default');
  } finally { fs.rmSync(dir, {recursive:true,force:true}); }
});
