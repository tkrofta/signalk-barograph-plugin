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
  const recorded = { writes: [], logins: [], appData: [] };
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
      selfRef: `${baseUrl}|user|pwd`,
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

  it('publishes its configuration to the SignalK application data store', async () => {
    await waitFor(() => recorded.appData.length > 0, 'application data to be posted');

    const config = recorded.appData[0];
    assert.deepEqual(recorded.logins[0], { username: 'user', password: 'pwd' });
    assert.equal(config.influx.url, `${baseUrl}`);
    assert.equal(config.influx.org, 'test-org');
    assert.equal(config.influx.write, 'test-bucket');
    assert.equal(config.influx.read, 'test-bucket');
    assert.equal(config.influx.id, UUID);
    assert.equal(typeof config.subscriptions, 'object');
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
