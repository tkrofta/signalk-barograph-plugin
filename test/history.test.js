const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const history = require('../history');

const v2 = { organization: 'org', bucket: 'raw', read: 'downsampled', retention: 3, id: 'urn:mrn:signalk:uuid:test' };
const v1 = { organization: '', bucket: 'signalk/autogen', read: 'signalk/weekly', retention: 3, id: '211234560', url: 'http://influx:8086/', token: 'user:pwd' };

describe('history queries', () => {
  it('maps paths to influx series like influx.format', () => {
    assert.deepEqual(history.series('environment.outside.pressure'), { measurement: 'pressure', tags: { environment: 'outside' }, field: 'value' });
    assert.deepEqual(history.series('environment.outside.wind.speed'), { measurement: 'wind', tags: { environment: 'outside' }, field: 'speed' });
    assert.equal(history.series('pressure'), null);
  });

  it('scales the resolution to about 180 points per timescale', () => {
    assert.deepEqual(history.TIMESCALES.map(history.resolution), [60, 240, 480, 960, 1440]);
  });

  it('uses the write bucket within the retention and the read bucket beyond', () => {
    const recent = history.fluxQuery(v2, 'environment.outside.pressure', 3);
    assert.match(recent, /from\(bucket: "raw"\)/);
    assert.match(recent, /r\["_field"\] == "value"/);
    const older = history.fluxQuery(v2, 'environment.outside.pressure', 48);
    assert.match(older, /from\(bucket: "downsampled"\)/);
    assert.match(older, /r\["_field"\] == "average"/);
    assert.match(older, /aggregateWindow\(every: 960s, fn: mean, createEmpty: false\)/);
    // without a separate read bucket the written field is used for every timescale
    assert.match(history.fluxQuery({ ...v2, read: 'raw' }, 'environment.outside.pressure', 72), /from\(bucket: "raw"\).*"_field"\] == "value"/);
  });

  it('escapes values in Flux and InfluxQL', () => {
    const odd = { ...v2, id: 'a"b' };
    assert.ok(history.fluxQuery(odd, 'environment.outside.pressure', 3).includes('r["id"] == "a\\"b"'));
    const { q } = history.influxQL({ ...v1, id: "a'b" }, 'environment.outside.pressure', 3);
    assert.ok(q.includes(`"id" = 'a\\'b'`));
  });

  it('builds InfluxQL for Influx 1.8 with database and retention policy', () => {
    const recent = history.influxQL(v1, 'environment.outside.pressure', 3);
    assert.equal(recent.db, 'signalk');
    assert.equal(recent.q, `SELECT mean("value") FROM "signalk"."autogen"."pressure" WHERE time > now() - 3h AND "environment" = 'outside' AND "id" = '211234560' AND "source" != '' GROUP BY time(60s) fill(none)`);
    const older = history.influxQL(v1, 'environment.outside.pressure', 72);
    assert.match(older.q, /^SELECT mean\("average"\) FROM "signalk"."weekly"."pressure" .* GROUP BY time\(1440s\)/);
    assert.match(history.influxQL({ ...v1, bucket: 'signalk' }, 'environment.outside.pressure', 3).q, /FROM "signalk".."pressure"/);
  });

  it('queries Influx 1.8 with basic authentication and returns [ms, Pa]', async () => {
    let request;
    const fetchFn = async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({ results: [{ series: [{ values: [[1794736800000, 101300], [1794736860000, null], [1794736920000, 101320]] }] }] }),
      };
    };
    const result = await history.query(null, v1, 'environment.outside.pressure', '3', fetchFn);
    assert.ok(request.url.startsWith('http://influx:8086/query?db=signalk&epoch=ms&q='));
    assert.equal(request.options.headers.Authorization, 'Basic ' + Buffer.from('user:pwd').toString('base64'));
    assert.deepEqual(result.data, [[1794736800000, 101300], [1794736920000, 101320]]);
    assert.equal(result.hours, 3);
    assert.equal(result.unit, 'Pa');
  });

  it('reports query errors and limits the timescale', async () => {
    const failing = async () => ({ ok: true, json: async () => ({ results: [{ error: 'database not found' }] }) });
    await assert.rejects(history.query(null, v1, 'environment.outside.pressure', 3, failing), /database not found/);
    await assert.rejects(history.query(null, v1, 'environment.outside.pressure', 0), (err) => err.status === 400);
    const empty = async () => ({ ok: true, json: async () => ({ results: [{}] }) });
    const result = await history.query(null, v1, 'environment.outside.pressure', 500, empty);
    assert.equal(result.hours, 72);
    assert.deepEqual(result.data, []);
  });
});
