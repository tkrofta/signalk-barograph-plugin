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

  it('writes complete files only and lists them oldest first', () => {
    const dir = createDataDir();
    try {
      assert.equal(cache.push([{ value: 1 }], dir), true);
      assert.equal(cache.push([{ value: 2 }], dir), true);
      // no temporary files are left behind
      assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
      const files = cache.load(dir);
      assert.equal(files.length, 2);
      assert.deepEqual(cache.read(files[0], dir), [{ value: 1 }]);
      assert.deepEqual(cache.read(files[1], dir), [{ value: 2 }]);
      // other files in the plugin data directory are ignored
      fs.writeFileSync(path.join(dir, 'pathconfig.json'), '[]');
      fs.writeFileSync(path.join(dir, 'cached-notes.txt'), '');
      assert.equal(cache.load(dir).length, 2);
    } finally {
      removeDataDir(dir);
    }
  });

  it('removes an unreadable file instead of blocking the replay', () => {
    const dir = createDataDir();
    try {
      fs.writeFileSync(path.join(dir, `${Date.now()}.cached.json`), '[{"name":"pres');
      const files = cache.load(dir);
      assert.deepEqual(cache.read(files[0], dir), []);
      assert.equal(cache.load(dir), false);
      // a file removed in the meantime is not an error
      assert.deepEqual(cache.read('0.cached.json', dir), []);
      assert.equal(cache.remove('0.cached.json', dir), false);
    } finally {
      removeDataDir(dir);
    }
  });

  it('prunes the oldest files beyond the size and age limits', () => {
    const dir = createDataDir();
    try {
      const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
      fs.writeFileSync(path.join(dir, `${old}-0.cached.json`), '[1]');
      cache.push([1], dir);
      // the default age limit (30 days) removed the 40 days old file
      assert.equal(cache.load(dir).length, 1);

      for (let i = 0; i < 3; i++) cache.push(new Array(100).fill(i), dir, { maxBytes: 700 });
      const files = cache.load(dir);
      const total = files.reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0);
      assert.ok(total <= 700);
      // the newest file is kept
      assert.deepEqual(cache.read(files[files.length - 1], dir), new Array(100).fill(2));
    } finally {
      removeDataDir(dir);
    }
  });

  it('reports the usage and warns from half of a limit or after pruning', () => {
    const dir = createDataDir();
    try {
      assert.deepEqual(cache.usage(dir), { files: 0, bytes: 0, oldest: null, pruned: 0, warning: false, message: '' });
      cache.push(new Array(100).fill(1), dir);
      const small = cache.usage(dir);
      assert.equal(small.files, 1);
      assert.equal(small.warning, false);
      assert.match(small.message, /^1 file\(s\), 0\.0 of 100 MB cached since /);
      assert.equal(cache.usage(dir, { maxBytes: 2 * small.bytes }).warning, true);
      assert.equal(cache.usage(dir, { maxAge: 0 }).warning, true);

      // dropped data is reported until the cache has been replayed completely
      cache.push(new Array(100).fill(2), dir, { maxBytes: small.bytes });
      const pruned = cache.usage(dir);
      assert.equal(pruned.pruned, 1);
      assert.equal(pruned.warning, true);
      assert.match(pruned.message, /1 oldest file\(s\) dropped$/);
      cache.load(dir).forEach((f) => cache.remove(f, dir));
      assert.equal(cache.usage(dir).warning, false);
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
