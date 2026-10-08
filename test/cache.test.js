const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cache = require('../cache');
const influx = require('../influx');

// kept self-contained so this file can be dropped into any plugin reusing cache.js/influx.js
const createDataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cache-'));
const removeDataDir = (dir) => fs.rmSync(dir, { recursive: true, force: true });
const cachedFiles = (dir) => fs.readdirSync(dir).filter((f) => f.includes('cached'));

describe('offline cache', () => {
  it('refuses to write without a valid cache directory', () => {
    // `${cacheDir}/${file}` used to resolve to the filesystem root when unconfigured
    assert.equal(cache.push([{ value: 1 }], ''), false);
    assert.equal(cache.push([{ value: 1 }], undefined), false);
    assert.equal(cache.push([{ value: 1 }], path.join(__dirname, 'does-not-exist')), false);
    assert.equal(cache.load(''), false);
  });

  it('skips empty metric batches', () => {
    const dir = createDataDir();
    try {
      assert.equal(cache.push([], dir), false);
      assert.equal(cache.load(dir), false);
      assert.deepEqual(influx.flush([], dir), []);
      assert.deepEqual(cachedFiles(dir), []);
    } finally {
      removeDataDir(dir);
    }
  });

  it('caches buffered metrics once into the configured directory', () => {
    const dir = createDataDir();
    try {
      assert.deepEqual(influx.flush([{ name: 'position' }], dir), []);
      assert.equal(cachedFiles(dir).length, 1);

      const cached = JSON.parse(fs.readFileSync(path.join(dir, cachedFiles(dir)[0]), 'utf-8'));
      assert.deepEqual(cached, [{ name: 'position' }]);

      // the buffer is cleared on success, so flushing again must not duplicate it
      assert.deepEqual(influx.flush([], dir), []);
      assert.equal(cachedFiles(dir).length, 1);
    } finally {
      removeDataDir(dir);
    }
  });

  it('keeps metrics buffered when they cannot be cached', () => {
    const missing = path.join(__dirname, 'does-not-exist');
    const dir = createDataDir();
    try {
      assert.deepEqual(influx.flush([{ name: 'depth' }], missing), []);
      // retrying with a usable directory still writes the buffered metric
      assert.deepEqual(influx.flush([], dir), []);
      assert.equal(cachedFiles(dir).length, 1);
      const cached = JSON.parse(fs.readFileSync(path.join(dir, cachedFiles(dir)[0]), 'utf-8'));
      assert.deepEqual(cached, [{ name: 'depth' }]);
    } finally {
      removeDataDir(dir);
    }
  });
});
