const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const trend = require('barometer-trend');
const barometer = require('../barometer');

const PRESSURE = 'environment.outside.pressure';
const update = (p, value) => ({ values: [{ path: p, value }] });
const valueOf = (messages, p) => (messages.find((m) => m.path === p) || {}).value;

describe('barometer', () => {
  beforeEach(() => {
    barometer.init(undefined, 30);
    barometer.addSubscriptionHandler('pressure', PRESSURE);
  });

  it('uses at most one pressure reading per minute for predictions', () => {
    for (let i = 0; i < 10; i++) barometer.onDeltaUpdate(update(PRESSURE, 101300 + i));
    assert.equal(trend.getPressureCount(), 1);

    barometer.init(undefined, 30, 0);
    barometer.addSubscriptionHandler('pressure', PRESSURE);
    for (let i = 0; i < 10; i++) barometer.onDeltaUpdate(update(PRESSURE, 101300 + i));
    assert.equal(trend.getPressureCount(), 10);
  });

  it('ignores unknown paths, unknown trend types and missing values', () => {
    barometer.addSubscriptionHandler('humidity', 'environment.outside.humidity');
    assert.doesNotThrow(() => barometer.onDeltaUpdate(update('environment.outside.humidity', 0.5)));
    assert.doesNotThrow(() => barometer.onDeltaUpdate(update(PRESSURE, null)));
    assert.doesNotThrow(() => barometer.onDeltaUpdate({}));
    assert.doesNotThrow(() => barometer.onElevationUpdate(null));
    assert.equal(trend.getPressureCount(), 0);
  });

  it('publishes predictions with the wind range in m/s', () => {
    barometer.init(undefined, 30, 0);
    barometer.addSubscriptionHandler('pressure', PRESSURE);
    // a steep fall over three hours
    const start = Date.now() - 3 * 60 * 60 * 1000;
    for (let i = 0; i <= 180; i += 10) trend.addPressure(new Date(start + i * 60 * 1000), 101500 - i * 5);
    const messages = barometer.getTrendAndPredictions(0);
    assert.ok(messages.length > 0);
    const force = valueOf(messages, 'environment.barometer.wind.predicted');
    const min = valueOf(messages, 'environment.barometer.wind.minimum');
    const max = valueOf(messages, 'environment.barometer.wind.maximum');
    assert.equal(typeof force, 'string');
    assert.ok(typeof min === 'number' && typeof max === 'number' && min < max);
    // Beaufort values are converted, not published as force numbers
    assert.ok(max > 12);
  });

  it('derives the wind range from the predicted force, unknown forces stay null', () => {
    // 'Unknown' used to throw (int.parse) and drop the whole prediction update
    assert.equal(barometer.predictWindSpeed({ force: 'Unknown', min: 0, max: 0 }, 'min'), null);
    assert.equal(barometer.predictWindSpeed({ force: 'Unknown', min: 0, max: 0 }, 'max'), null);
    assert.equal(barometer.predictWindSpeed(undefined, 'max'), null);
    assert.equal(barometer.predictWindSpeed({ force: 'Less than F6', min: 0, max: 6 }, 'min'), 0);
    assert.equal(barometer.predictWindSpeed({ force: 'Less than F6', min: 0, max: 6 }, 'max'), 13.9);
    assert.equal(barometer.predictWindSpeed({ force: 'F8-12', min: 8, max: 12 }, 'min'), 17.2);
    assert.equal(barometer.predictWindSpeed({ force: 'F8-12', min: 8, max: 12 }, 'max'), 99.9);
  });

  it('saves the pressure history on stop and restores the last 48h on start', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-barograph-'));
    try {
      barometer.init(undefined, 30, 0);
      assert.equal(barometer.persist(dir), false);
      trend.addPressure(new Date(Date.now() - 49 * 60 * 60 * 1000), 101000);
      trend.addPressure(new Date(Date.now() - 60 * 60 * 1000), 101100, 10, 290, 180);
      trend.addPressure(new Date(), 101200, 10, 290, 180);
      assert.equal(barometer.persist(dir), true);

      barometer.init(undefined, 30);
      assert.equal(trend.getPressureCount(), 0);
      assert.equal(barometer.restore(dir), 2);
      assert.equal(trend.getPressureCount(), 2);
      assert.deepEqual(trend.getAll()[1].meta, { value: 101200, altitude: 10, temperature: 290, twd: 180 });
      // the restored history counts for the per minute sampling
      barometer.addSubscriptionHandler('pressure', PRESSURE);
      barometer.onDeltaUpdate(update(PRESSURE, 101250));
      assert.equal(trend.getPressureCount(), 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a missing or broken history file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-barograph-'));
    try {
      assert.equal(barometer.restore(dir), 0);
      fs.writeFileSync(path.join(dir, 'barometer.pressures.json'), '[{');
      assert.equal(barometer.restore(dir), 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
