const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const pluginFactory = require('../index');

describe('plugin', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-barograph-'));
  // unreachable endpoints keep the baseline check offline: influx health fails and the plugin stays idle
  const unreachable = 'http://127.0.0.1:1';
  const app = {
    debug: () => {},
    error: () => {},
    setPluginStatus: () => {},
    setPluginError: () => {},
    getDataDirPath: () => dataDir,
    getSelfPath: () => undefined,
    readPluginOptions: () => ({ configuration: {} }),
    savePluginOptions: (options, callback) => callback && callback(),
    handleMessage: () => {},
    subscriptionmanager: {
      subscribe: () => {},
    },
  };
  const plugin = pluginFactory(app);

  after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('has required interface', () => {
    assert.equal(typeof plugin.start, 'function');
    assert.equal(typeof plugin.stop, 'function');
    assert.ok(plugin.id);
  });

  it('starts and stops without error', () => {
    plugin.start({ influxUri: unreachable, influxToken: 'token' }, () => {});
    plugin.stop();
  });
});

describe('plugin without influx', () => {
  const unreachable = 'http://127.0.0.1:1';
  const options = () => ({ influxUri: unreachable, influxToken: 'token', loadFrequency: 1 });

  function createApp(dataDir) {
    const app = {
      errors: [],
      subscriptions: 0,
      debug: () => {},
      error: () => {},
      setPluginStatus: () => {},
      setPluginError: (error) => app.errors.push(error),
      getDataDirPath: () => dataDir,
      getSelfPath: () => undefined,
      readPluginOptions: () => ({ configuration: {} }),
      savePluginOptions: (opts, callback) => callback && callback(),
      handleMessage: () => {},
      subscriptionmanager: {
        subscribe: (subscription, unsubscribes) => {
          app.subscriptions += 1;
          unsubscribes.push(() => {});
        },
      },
    };
    return app;
  }

  async function waitFor(condition, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  }

  it('reports the failed influx connection and keeps publishing predictions', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-barograph-'));
    const app = createApp(dataDir);
    const plugin = pluginFactory(app);
    try {
      plugin.start(options(), () => {});
      await waitFor(() => app.errors.length > 0);
      assert.match(app.errors[0], /Influx/);
      assert.equal(app.subscriptions, 1);
    } finally {
      plugin.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('shows the reason of the failed influx connection', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-barograph-'));
    const app = createApp(dataDir);
    const plugin = pluginFactory(app);
    try {
      plugin.start(options(), () => {});
      await waitFor(() => app.errors.length > 0);
      assert.match(app.errors[0], /^Failed to connect to Influx \(.+\) - publishing predictions only$/);
    } finally {
      plugin.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('raises a filling offline cache on the plugin state', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-barograph-'));
    // influx is healthy but rejects writes - the cache of 20 days exceeds half of the 30 days limit
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: 'influxdb', status: 'pass', checks: [] }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'invalid', message: 'rejected' }));
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const old = Date.now() - 20 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(path.join(dataDir, `${old}-0.cached.json`), '[]');
    const app = createApp(dataDir);
    const plugin = pluginFactory(app);
    try {
      plugin.start({ ...options(), influxUri: url }, () => {});
      await waitFor(() => app.errors.length > 0);
      assert.match(app.errors[0], /^Influx writes failing - offline cache 1 file\(s\)/);
    } finally {
      plugin.stop();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('does not subscribe when stopped before the influx health check completed', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-barograph-'));
    const app = createApp(dataDir);
    const plugin = pluginFactory(app);
    try {
      plugin.start(options(), () => {});
      plugin.stop();
      // a quick restart: only the health check of the second start may subscribe
      plugin.start(options(), () => {});
      await waitFor(() => app.errors.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(app.subscriptions, 1);
    } finally {
      plugin.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
