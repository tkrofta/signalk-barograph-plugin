const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
    plugin.start({ influxUri: unreachable, influxToken: 'token', selfRef: `${unreachable}|user|pwd` }, () => {});
    plugin.stop();
  });
});
