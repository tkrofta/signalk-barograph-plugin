const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DateTime } = require('luxon');

const cache = require('../cache');
const influx = require('../influx');

// kept self-contained so this file can be dropped into any plugin reusing cache.js/influx.js
const createDataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-influx-'));
const removeDataDir = (dir) => fs.rmSync(dir, { recursive: true, force: true });
const cachedFiles = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.cached.json'));

// stands in for the influx client: records the line protocol of confirmed writes, fails while `down`
function stubInflux() {
  const stub = { down: false, written: [], attempts: 0 };
  stub.getWriteApi = () => {
    const lines = [];
    return {
      useDefaultTags: () => {},
      writePoint: (p) => lines.push(p.toLineProtocol({ defaultTags: { id: 'test' }, convertTime: (t) => String(t) })),
      close: () => {
        stub.attempts += 1;
        if (stub.down) return Promise.reject(new Error('influx down'));
        stub.written.push(...lines);
        return Promise.resolve();
      },
    };
  };
  return stub;
}

describe('influx points', () => {
  it('carries the time of measurement', () => {
    const measured = DateTime.fromISO('2026-11-15T10:00:00.123Z');
    const point = influx.format('environment.outside.pressure', 101325, measured, 'bme280');
    assert.equal(point.time, measured.toMillis());
    assert.match(point.toLineProtocol({ convertTime: (t) => String(t) }), / 1794736800123$/);
  });

  it('falls back to now for a missing or invalid timestamp', () => {
    const before = Date.now();
    const invalid = influx.format('environment.outside.pressure', 101325, DateTime.fromISO('not a date'), '');
    const missing = influx.format('environment.outside.pressure', 101325, undefined, '');
    for (const point of [invalid, missing]) {
      assert.ok(Number.isFinite(point.time));
      assert.ok(point.time >= before && point.time <= Date.now());
    }
  });

  it('restores every tag and the field type from the cache', () => {
    const measured = DateTime.fromISO('2026-11-15T10:00:00Z');
    const points = [
      influx.format('environment.outside.pressure', 101325, measured, 'bme280'),
      influx.format('environment.forecast.today.temperature.minimum', 280.5, measured, 'openweather'),
      influx.format('environment.forecast.description', 'light rain', measured, 'openweather'),
      influx.format('environment.outside.wind.gust', 0, measured, ''),
    ];
    const revived = JSON.parse(JSON.stringify(points)).map(influx.revive);
    const line = (p) => p.toLineProtocol({ convertTime: (t) => String(t) });
    assert.deepEqual(revived.map(line), points.map(line));
  });

  it('replays cache files written before the timestamp fix', () => {
    const legacy = { name: 'pressure', tags: { environment: 'outside', source: 'bme280' }, fields: { value: '101325' }, timestamp: 1794736800000 };
    const point = influx.revive(legacy);
    assert.equal(point.toLineProtocol({ convertTime: (t) => String(t) }), 'pressure,environment=outside,source=bme280 value=101325 1794736800000');
  });
});

describe('influx post and replay', () => {
  const config = (dir) => ({ organization: 'org', bucket: 'bucket', id: 'test', cacheDir: dir, retention: 6 });
  const point = (value) => influx.format('environment.outside.pressure', value, DateTime.utc(), 'bme280');
  const measuredPoint = (value, millis) => influx.format('environment.outside.pressure', value, DateTime.fromMillis(millis), 'bme280');

  it('caches exactly the points of a failed post', async () => {
    const dir = createDataDir();
    try {
      const db = stubInflux();
      db.down = true;
      assert.equal(await influx.post(db, [point(1), point(2)], config(dir)), false);
      assert.equal(cachedFiles(dir).length, 1);
      assert.equal(cache.read(cachedFiles(dir)[0], dir).length, 2);
      // nothing left in the buffer, so a flush on stop does not cache them a second time
      influx.flush([], dir);
      assert.equal(cachedFiles(dir).length, 1);
    } finally {
      removeDataDir(dir);
    }
  });

  it('replays the cache after a successful post and removes only confirmed files', async () => {
    const dir = createDataDir();
    try {
      const db = stubInflux();
      db.down = true;
      await influx.post(db, [point(1)], config(dir));
      await influx.post(db, [point(2)], config(dir));
      assert.equal(cachedFiles(dir).length, 2);

      db.down = false;
      assert.equal(await influx.post(db, [point(3)], config(dir)), true);
      assert.equal(cachedFiles(dir).length, 0);
      assert.equal(db.written.length, 3);
      assert.ok(db.written.every((l) => l.includes('source=bme280')));
    } finally {
      removeDataDir(dir);
    }
  });

  it('keeps cache files when the replay fails', async () => {
    const dir = createDataDir();
    try {
      const db = stubInflux();
      cache.push([JSON.parse(JSON.stringify(point(1)))], dir);
      db.down = true;
      assert.equal(await influx.replay(db, config(dir)), false);
      assert.equal(cachedFiles(dir).length, 1);
      db.down = false;
      assert.equal(await influx.replay(db, config(dir)), true);
      assert.equal(cachedFiles(dir).length, 0);
      assert.equal(db.written.length, 1);
    } finally {
      removeDataDir(dir);
    }
  });

  it('does not write or cache points already outside retention', async () => {
    const dir = createDataDir();
    try {
      const db = stubInflux();
      db.down = true;
      const expired = measuredPoint(1, Date.now() - 7 * 60 * 60 * 1000);
      const posting = influx.post(db, [expired], config(dir));
      // The plugin buffers immediately after post() so stop can preserve an
      // in-flight write. Expired points must be released after this step.
      influx.buffer([expired]);
      assert.equal(await posting, true);
      assert.equal(db.attempts, 0);
      assert.equal(cachedFiles(dir).length, 0);
      influx.flush([], dir);
      assert.equal(cachedFiles(dir).length, 0);
    } finally {
      removeDataDir(dir);
    }
  });

  it('drops expired cached points and replays the remaining points', async () => {
    const dir = createDataDir();
    try {
      const db = stubInflux();
      const expired = measuredPoint(1, Date.now() - 7 * 60 * 60 * 1000);
      const current = point(2);
      cache.push(JSON.parse(JSON.stringify([expired, current])), dir);
      assert.equal(await influx.replay(db, config(dir)), true);
      assert.equal(cachedFiles(dir).length, 0);
      assert.equal(db.attempts, 1);
      assert.equal(db.written.length, 1);
      assert.match(db.written[0], /value=2/);
    } finally {
      removeDataDir(dir);
    }
  });

  it('removes an all-expired cache file without writing it', async () => {
    const dir = createDataDir();
    try {
      const db = stubInflux();
      const expired = measuredPoint(1, Date.now() - 7 * 60 * 60 * 1000);
      cache.push(JSON.parse(JSON.stringify([expired])), dir);
      assert.equal(await influx.replay(db, config(dir)), true);
      assert.equal(cachedFiles(dir).length, 0);
      assert.equal(db.attempts, 0);
      assert.equal(db.written.length, 0);
    } finally {
      removeDataDir(dir);
    }
  });
});

describe('influx health', () => {
  it('reports a failure to the callback when influx is unreachable', async () => {
    const db = influx.login({ url: 'http://127.0.0.1:1', token: 'token', timeout: 1000 }, '');
    let result = null;
    await influx.health(db, (client, res) => { result = res; });
    assert.equal(result.status, 'fail');
  });

  it('reports a failure to the callback without a client', async () => {
    let result = null;
    await influx.health(undefined, (client, res) => { result = res; });
    assert.equal(result.status, 'fail');
  });
});

describe('influx path configuration', () => {
  it('re-reads the file on every call', () => {
    const dir = createDataDir();
    try {
      const file = path.join(dir, 'pathconfig.json');
      influx.save(dir, 'pathconfig.json', [{ path: 'environment.outside.pressure' }]);
      assert.equal(influx.config(file).length, 1);
      influx.save(dir, 'pathconfig.json', [{ path: 'environment.outside.pressure' }, { path: 'environment.outside.temperature' }]);
      assert.equal(influx.config(file).length, 2);
      fs.writeFileSync(file, '{ invalid');
      assert.deepEqual(influx.config(file), []);
      assert.deepEqual(influx.config(path.join(dir, 'missing.json')), []);
    } finally {
      removeDataDir(dir);
    }
  });
});
