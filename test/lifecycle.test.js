const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pluginFactory = require('../index');

const UUID = 'urn:mrn:signalk:uuid:test-vessel';

// Stands in for both InfluxDB (health/write) and the SignalK server (auth/applicationData)
// so the whole plugin lifecycle can be verified from the command line without any service.
function createStubServer(recorded) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          name: 'influxdb',
          message: 'ready for queries and writes',
          status: 'pass',
          version: '2.7.0',
          commit: 'test',
          checks: [],
        }));
      } else if (req.method === 'POST' && url.pathname === '/api/v2/write') {
        recorded.writes.push({
          org: url.searchParams.get('org'),
          bucket: url.searchParams.get('bucket'),
          precision: url.searchParams.get('precision'),
          lines: body.split('\n').filter((line) => line !== ''),
        });
        res.writeHead(204);
        res.end();
      } else if (req.method === 'POST' && url.pathname === '/api/v2/query') {
        recorded.queries.push(JSON.parse(body || '{}').query);
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
        res.end([
          '#datatype,string,long,dateTime:RFC3339,double',
          '#group,false,false,false,false',
          '#default,_result,,,',
          ',result,table,_time,_value',
          ',,0,2026-11-15T10:00:00Z,101300',
          ',,0,2026-11-15T10:01:00Z,101310',
          '',
        ].join('\r\n'));
      } else if (req.method === 'POST' && url.pathname === '/signalk/v1/auth/login') {
        recorded.logins.push(JSON.parse(body || '{}'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token: 'test-jwt' }));
      } else if (req.method === 'POST' && url.pathname.startsWith('/signalk/v1/applicationData/')) {
        recorded.appData.push(JSON.parse(body || '{}'));
        res.writeHead(200);
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
}

async function waitFor(condition, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${description}`);
}

// express router stand-in - router.access(level) exists from server 2.31
function createRouter(withAccess) {
  const routes = {};
  const levels = [];
  const router = { get: (p, handler) => { routes[p] = handler; } };
  if (withAccess) {
    router.access = (level) => {
      levels.push(level);
      return router;
    };
  }
  return { router, routes, levels };
}

async function call(handler, query = {}) {
  const res = {
    code: 200,
    body: undefined,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler({ query }, res);
  return res;
}

function delta(path, value, source = 'test.source') {
  return {
    updates: [
      {
        $source: source,
        timestamp: new Date().toISOString(),
        values: [{ path, value }],
      },
    ],
  };
}

describe('plugin lifecycle', () => {
  const recorded = { writes: [], logins: [], appData: [], queries: [] };
  const statuses = [];
  const errors = [];
  const sentDeltas = [];
  // the server returns plain values for vessel identifiers and value objects for data paths
  const selfPaths = { uuid: UUID, 'navigation.gnss.antennaAltitude': { value: 2.5 } };

  let dataDir;
  let server;
  let baseUrl;
  let options;
  let plugin;
  let subscription = null;
  let onDelta = null;
  let unsubscribed = 0;

  const app = {
    debug: () => {},
    error: (msg) => errors.push(msg),
    setPluginStatus: (status) => statuses.push(status),
    setPluginError: (error) => errors.push(error),
    getDataDirPath: () => dataDir,
    getSelfPath: (p) => selfPaths[p],
    readPluginOptions: () => ({ configuration: options }),
    savePluginOptions: (opts, callback) => callback && callback(),
    handleMessage: (id, message) => sentDeltas.push({ id, message }),
    subscriptionmanager: {
      subscribe: (localSubscription, unsubscribes, onError, onDeltaReceived) => {
        subscription = localSubscription;
        onDelta = onDeltaReceived;
        unsubscribes.push(() => {
          unsubscribed += 1;
        });
      },
    },
  };

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-barograph-'));
    server = createStubServer(recorded);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    options = {
      influxUri: baseUrl,
      influxToken: 'test-token',
      influxOrg: 'test-org',
      influxBucket: 'test-bucket',
      loadFrequency: 1,
    };
    plugin = pluginFactory(app);
  });

  after(async () => {
    plugin.stop();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('starts, writes a default path configuration and subscribes to self', async () => {
    plugin.start(options, () => {});

    await waitFor(() => subscription !== null, 'subscription to be registered');

    assert.equal(options.pathConfig, 'pathconfig.json');
    assert.ok(fs.existsSync(path.join(dataDir, 'pathconfig.json')));
    assert.deepEqual(statuses.slice(0, 3), ['Initializing', 'Initialized', 'Started']);
    assert.deepEqual(errors, []);
    assert.equal(subscription.context, 'vessels.self');

    const subscribedPaths = subscription.subscribe.map((p) => p.path);
    assert.ok(subscribedPaths.includes('environment.outside.pressure'));
    assert.ok(subscribedPaths.includes('environment.outside.temperature'));
    assert.ok(subscribedPaths.includes('navigation.position'));
    assert.equal(typeof onDelta, 'function');
  });

  it('preloads barometer values and units as deltas', () => {
    const values = sentDeltas
      .filter((d) => d.message.updates[0].values)
      .flatMap((d) => d.message.updates[0].values);
    const description = values.find((v) => v.path === 'environment.barometer.description');
    assert.ok(description);
    assert.match(description.value, /waiting/);

    const meta = sentDeltas
      .filter((d) => d.message.updates[0].meta)
      .flatMap((d) => d.message.updates[0].meta);
    const difference = meta.find((m) => m.path === 'environment.barometer.trend.difference');
    assert.ok(difference);
    assert.equal(difference.value.units, 'Pa');
  });

  it('forwards subscribed deltas to influx', async () => {
    onDelta(delta('environment.outside.pressure', 101300));
    onDelta(delta('environment.outside.temperature', 288.15));
    onDelta(delta('environment.outside.relativeHumidity', 0.56));

    await waitFor(() => recorded.writes.length > 0, 'metrics to be written to influx');

    const write = recorded.writes[0];
    assert.equal(write.org, 'test-org');
    assert.equal(write.bucket, 'test-bucket');
    assert.equal(write.precision, 'ms');

    const pressure = write.lines.find((line) => line.startsWith('pressure,'));
    assert.ok(pressure, `no pressure measurement in ${write.lines.join(' | ')}`);
    assert.ok(pressure.includes('environment=outside'));
    assert.ok(pressure.includes('source=test.source'));
    assert.ok(pressure.includes(`id=${UUID}`));
    assert.match(pressure, /value=101300/);

    assert.ok(write.lines.some((line) => line.startsWith('temperature,')));
    // relativeHumidity is remapped to humidity by the default path configuration
    assert.ok(write.lines.some((line) => line.startsWith('humidity,')));
  });

  it('writes forecasts at the time they are valid for, taken from the same source', async () => {
    const before = recorded.writes.length;
    const valid = '2026-11-15T13:00:00.000Z';
    onDelta(delta('environment.forecast.time', valid, 'openmeteo-signalk.icon_seamless'));
    onDelta(delta('environment.forecast.time', '2026-11-15T15:00:00.000Z', 'openweather'));
    onDelta(delta('environment.forecast.pressure', 100500, 'openmeteo-signalk.icon_seamless'));
    await waitFor(() => recorded.writes.slice(before).some((w) => w.lines.some((l) => l.startsWith('pressure,environment=forecast'))), 'forecast to be written');
    const line = recorded.writes.slice(before).flatMap((w) => w.lines).find((l) => l.startsWith('pressure,environment=forecast'));
    assert.ok(line.includes('source=openmeteo-signalk.icon_seamless'), line);
    assert.ok(line.endsWith(` ${Date.parse(valid)}`), line);
  });

  it('ignores empty and placeholder delta values', async () => {
    const before = recorded.writes.length;
    onDelta(delta('environment.outside.pressure', null));
    onDelta(delta('environment.outside.pressure', 'waiting ...'));
    onDelta(delta('', 123));
    onDelta({ updates: 'not-an-array' });

    await new Promise((resolve) => setTimeout(resolve, 1500));
    const written = recorded.writes.slice(before).flatMap((w) => w.lines);
    assert.deepEqual(written.filter((line) => line.startsWith('pressure,')), []);
    assert.deepEqual(errors, []);
  });

  it('no longer logs into the server or publishes credentials as application data', () => {
    assert.deepEqual(recorded.logins, []);
    assert.deepEqual(recorded.appData, []);
  });

  it('serves the app settings without credentials to read-only users', async () => {
    const { router, routes, levels } = createRouter(true);
    plugin.registerWithRouter(router);
    assert.deepEqual(levels, ['readonly']);

    const res = await call(routes['/settings']);
    assert.equal(res.code, 200);
    assert.equal(res.body.paths.pressure, 'environment.outside.pressure');
    assert.equal(res.body.history.available, true);
    assert.deepEqual(res.body.history.timescales, [3, 12, 24, 48, 72]);
    assert.deepEqual(res.body.history.buckets, { write: 'test-bucket', read: 'test-bucket' });
    assert.doesNotMatch(JSON.stringify(res.body), /test-token|token/);
    // forecast trace only with the Open-Meteo plugin installed and enabled
    assert.equal(res.body.forecast.available, false);
    assert.equal(res.body.forecast.endpoint, '/plugins/openmeteo-signalk/forecast');
    assert.equal(res.body.forecast.hours, 3);
    try {
      // documented feature detection (ServerAPI.getFeatures)
      app.getFeatures = async () => ({ apis: [], plugins: [{ id: 'openmeteo-signalk', enabled: false }] });
      assert.equal((await call(routes['/settings'])).body.forecast.available, false);
      app.getFeatures = async () => ({ apis: ['weather'], plugins: [{ id: 'openmeteo-signalk', enabled: true }] });
      assert.equal((await call(routes['/settings'])).body.forecast.available, true);
      app.getFeatures = async () => { throw new Error('not ready'); };
      assert.equal((await call(routes['/settings'])).body.forecast.available, false);
      // the plugins list of the server as fallback
      delete app.getFeatures;
      app.getPluginsList = async () => [{ id: 'openmeteo-signalk', enabled: true }];
      assert.equal((await call(routes['/settings'])).body.forecast.available, true);
    } finally {
      delete app.getFeatures;
      delete app.getPluginsList;
    }
  });

  it('keeps the routes admin only on servers without router.access', () => {
    const { router, routes } = createRouter(false);
    plugin.registerWithRouter(router);
    assert.deepEqual(Object.keys(routes).sort(), ['/history', '/settings']);
  });

  it('queries the pressure history from influx on the server', async () => {
    const { router, routes } = createRouter(true);
    plugin.registerWithRouter(router);

    const res = await call(routes['/history'], { hours: '3' });
    assert.equal(res.code, 200, JSON.stringify(res.body));
    assert.equal(res.body.unit, 'Pa');
    assert.equal(res.body.bucket, 'write');
    assert.equal(res.body.resolution, 60);
    assert.deepEqual(res.body.data, [[Date.parse('2026-11-15T10:00:00Z'), 101300], [Date.parse('2026-11-15T10:01:00Z'), 101310]]);

    const query = recorded.queries[recorded.queries.length - 1];
    assert.match(query, /from\(bucket: "test-bucket"\)/);
    assert.match(query, /range\(start: -3h\)/);
    assert.match(query, /r\["_measurement"\] == "pressure" and r\["_field"\] == "value"/);
    assert.match(query, /r\["environment"\] == "outside"/);
    assert.ok(query.includes(`r["id"] == "${UUID}"`));

    const invalid = await call(routes['/history'], { hours: 'abc' });
    assert.equal(invalid.code, 400);
  });

  it('queries the past forecasts of one source', async () => {
    const { router, routes } = createRouter(true);
    plugin.registerWithRouter(router);
    const res = await call(routes['/history'], { hours: '12', series: 'forecast', source: 'openmeteo-signalk.icon_seamless' });
    assert.equal(res.code, 200, JSON.stringify(res.body));
    assert.equal(res.body.path, 'environment.forecast.pressure');
    assert.equal(res.body.source, 'openmeteo-signalk.icon_seamless');
    const query = recorded.queries[recorded.queries.length - 1];
    assert.match(query, /r\["environment"\] == "forecast"/);
    assert.ok(query.includes('r["source"] == "openmeteo-signalk.icon_seamless"'), query);

    assert.equal((await call(routes['/history'], { series: 'forecast', source: 'x" or true' })).code, 400);
    assert.equal((await call(routes['/history'], { series: 'temperature' })).code, 400);
  });

  it('openApi describes the routes', () => {
    const api = plugin.getOpenApi();
    assert.equal(api.servers[0].url, '/plugins/signalk-barograph');
    assert.deepEqual(Object.keys(api.paths).sort(), ['/history', '/settings']);
  });

  it('stops, unsubscribes and no longer uploads', async () => {
    plugin.stop();
    assert.equal(unsubscribed, 1);

    const before = recorded.writes.length;
    onDelta(delta('environment.outside.pressure', 101400));
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(recorded.writes.length, before);
  });
});
