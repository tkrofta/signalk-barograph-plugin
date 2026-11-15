const predictions = require ('barometer-trend')

/*
    Copyright © 2021 Inspired Technologies GmbH. Rights Reserved.

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
*/

const fs = require('fs')
const path = require('path')
const units = require ('./skunits')
const log = require('debug')('signalk-barograph:barometer')

const WAITING = "waiting ..."
const SAMPLE_RATE = 60 * 1000                       // pressure readings used for predictions - at most one per minute
const HISTORY = 48 * 60 * 60 * 1000                 // barometer-trend keeps 48h
const HISTORY_FILE = 'barometer.pressures.json'     // pressure history saved on plugin stop

let refreshRate = null
let sampleRate = SAMPLE_RATE
let currentPressure = '';
let currentTemperature = '';
let currentWindDirection = ''
let navigationAltitude = '';
let navigationPosition = '';
function isSubscribed(path) {
    return (path===currentPressure || path===currentTemperature || path===navigationAltitude || path===navigationPosition || path===currentWindDirection)
}

let pathPrefix = "environment.barometer.";
const barometerTrend = pathPrefix+"trend";                  // severity, trend, tendency
const trendDifference = pathPrefix+"trend.difference";      // difference
const trendPeriod = pathPrefix+"trend.period";              // period
const barometerPrediction = pathPrefix+"prediction";        // season
const predictionWind = pathPrefix+"wind.predicted";         // beaufort
const predictionWindDir = pathPrefix+"wind.direction";      // quadrant
const predictionWindMin = pathPrefix+"wind.minimum";        // beaufort -> range
const predictionWindMax = pathPrefix+"wind.maximum";        // beaufort -> range
const predictionFront = pathPrefix+"front.predicted";       // front
const barometerDescription = pathPrefix+'description';

const latest = {
    update: null,
    sampled: null,
    hemisphere: 'N',
    pressure: null,
    temperature: null,
    winddir: null,
    altitude: null,
    trend: null,
    prediction: null,
    description: null
}

let subscriptionHandler = []
function addSubscriptionHandler (type, path) {
    let handler = null
    switch (type) {
        case 'pressure':
            currentPressure = path
            handler = { path: currentPressure, handle: (value) => onPressureUpdate(value) }
            break;
        case 'temperature':
            currentTemperature = path
            handler = { path: currentTemperature, handle: (value) => onTemperatureUpdate(value) }
            break;
        case 'winddir':
            currentWindDirection = path
            handler = { path: currentWindDirection, handle: (value) => onWindDirUpdate(value) }
            break;
        case 'altitude':
            navigationAltitude = path
            handler = { path: navigationAltitude, handle: (value) => onElevationUpdate(value) }
            break;
        case 'position':
            navigationPosition = path
            handler = { path: navigationPosition, handle: (value) => onPositionUpdate(value) }
            break;
        default:
            log(`Unknown trend type '${type}' for ${path} - ignored`)
            break;
    }
    if (handler!==null)
        subscriptionHandler.push(handler)
}

function onDeltaUpdate(update) {
    if (!update || !Array.isArray(update.values))
        return
    update.values.forEach((value) => {
        subscriptionHandler
            .filter((d) => d.path === value.path)
            .forEach((d) => d.handle(value.value))
    });
}

function getTrendAndPredictions (interval) {
    let messages = []
    if (!lastUpdateWithin(interval) && predictions.hasPressures())
    {
        try {
            let forecast = predictions.getPredictions(latest.hemisphere==='N')
            if (forecast!==null)
            {
                // determine Forecast
                latest.update = Date.now()
                latest.trend = forecast.trend
                latest.prediction = forecast.predictions
                latest.description = forecast.predictions.pressureOnly
                log ({
                    count: predictions.getPressureCount(),
                    trend: `${latest.trend.trend} ${latest.trend.tendency}`,
                    prediction: latest.prediction.pressureOnly
                })
                // add Messages
                prepareUpdate('description').forEach(m => messages.push(m))
                prepareUpdate('trend').forEach(m => messages.push(m))
                prepareUpdate('prediction').forEach(m => messages.push(m))
            }
        }
        catch (err) {
            log ('Error calculating predictions: '+err)
        }
    }
    return messages
}

function addPressure(time, value) {
    predictions.addPressure(new Date(time), value,
        (latest.altitude!==null ? latest.altitude.value : null),
        (latest.temperature!==null ? latest.temperature.value : null),
        (latest.winddir!==null ? units.toTarget('rad', latest.winddir.value, 'deg', 0).value : null))
}

function onPressureUpdate(value) {
    if (value === null || value === undefined)
    {
        log("Cannot add null value as pressure - ignoring ...");
    }
    else if (value!==WAITING)
    {
        latest.pressure = { value, time: Date.now() }
        // predictions only need a reading per minute, independent of the subscription period
        if (latest.sampled!==null && latest.pressure.time-latest.sampled < sampleRate)
            return
        latest.sampled = latest.pressure.time
        addPressure(latest.pressure.time, value)
        log({ pressure: latest.pressure.value, altitude: (latest.altitude!==null ? latest.altitude.value : null),
            temperature: (latest.temperature!==null ? latest.temperature.value : null),
            winddir: (latest.winddir!==null ? Math.round(latest.winddir.value*100)/100 : null) });
    }
}

function onTemperatureUpdate(value) {
    if (value === null || value === undefined)
        log("Cannot add null value as temperature - ignoring ...");
    else if (value!==WAITING)
        latest.temperature = { value, time: Date.now() }
}

function onWindDirUpdate(value) {
    if (value === null || value === undefined)
        log("Cannot add null value as wind direction - ignoring ...");
    else if (value!==WAITING)
        latest.winddir = { value, time: Date.now() }
}

function onElevationUpdate(value) {
    if (value === null || value === undefined)
    {
        log("Cannot add null value as elevation - using 0 instead");
        latest.altitude = { value: 0, time: Date.now() }
    }
    else if (value!==WAITING)
    {
        latest.altitude = { value, time: Date.now() }
        log("Elevation set to "+value+"m above sea level");
    }
}

function onPositionUpdate(value) {
    let current = latest.hemisphere
    if (value === null || value === undefined || typeof value.latitude !== 'number')
    {
        log("Cannot use position without latitude - keeping "+latest.hemisphere+" hemisphere");
    }
    else
    {
        latest.hemisphere = value.latitude < 0 ? 'S' : 'N';
    }
    if (current!==latest.hemisphere)
        log("Hemisphere set to "+latest.hemisphere);
}

// wind speed range in m/s for the predicted Beaufort force - barometer-trend provides min/max force
function predictWindSpeed(beaufort, calc) {
    if (!beaufort || beaufort.force==='Unknown' || typeof beaufort[calc]!=='number')
        return null
    return units.toSignalK(calc==='min' ? 'BftMin' : 'BftMax', beaufort[calc]).value
}

function prepareUpdate(type) {
    const noData = WAITING
    const noVal = null
    switch (type) {
        case 'description': return [
            buildDeltaUpdate(type, barometerDescription, latest.description !== null ? latest.description : noData),
        ];
        case 'trend': return [
            buildDeltaUpdate(type, barometerTrend, latest.trend !== null ? { severity: latest.trend.severity, tendency: latest.trend.tendency, changerate: latest.trend.trend } : {}),
            buildDeltaUpdate(type, trendDifference, latest.trend !== null ? units.toSignalK('Pa', latest.trend.difference).value : noVal),
            buildDeltaUpdate(type, trendPeriod, latest.trend !== null ? Math.abs(latest.trend.period*60) : noVal)
        ];
        case 'prediction': return [
            buildDeltaUpdate(type, barometerPrediction, latest.prediction !== null ? latest.prediction.season : noData),
            buildDeltaUpdate(type, predictionWind, latest.prediction !== null ? latest.prediction.beaufort.force : noData),
            buildDeltaUpdate(type, predictionWindDir, latest.prediction !== null ? latest.prediction.quadrant : noData),
            buildDeltaUpdate(type, predictionWindMin, latest.prediction !== null ? predictWindSpeed(latest.prediction.beaufort, 'min') : noVal),
            buildDeltaUpdate(type, predictionWindMax, latest.prediction !== null ? predictWindSpeed(latest.prediction.beaufort, 'max') : noVal),
            buildDeltaUpdate(type, predictionFront, latest.prediction !== null ? latest.prediction.front: { key: 'N/A' }),
        ];
        case 'meta-trend': return [
            buildDeltaUpdate(type, trendDifference, { units: "Pa" }),
            buildDeltaUpdate(type, trendPeriod, { units: "s" })
        ];
        case 'meta-prediction': return [
            buildDeltaUpdate(type, predictionWindDir, { units: "" }),
            buildDeltaUpdate(type, predictionWindMin, { units: "m/s" }),
            buildDeltaUpdate(type, predictionWindMax, { units: "m/s" })
        ];
        default:
            return [];
    }
}

function buildDeltaUpdate(type, path, value) {
    if (type.startsWith("meta-") && value !== null) value.timeout = refreshRate/1000;
    return {
        path: path,
        value: value
    }
}

function preLoad() {
    // set the coordinates (latitude,longitude)
    latest.description = 'waiting for prediction data ...';
    let initial = prepareUpdate('description');
    let trend = prepareUpdate('trend');
    trend.forEach(v => initial.push(v));
    let prediction = prepareUpdate('prediction');
    prediction.forEach(v => initial.push(v));
    let meta = null
    // add units to updates
    if (initial) {
        meta = prepareUpdate('meta-trend');
        let pred = prepareUpdate('meta-prediction');
        pred.forEach(m => meta.push(m));
    }
    return { "update": initial, "meta": meta }
}

function lastUpdateWithin(interval) {
    return latest.update !== null ? (Date.now() - latest.update) <= interval : false;
}

// save the pressure history once on plugin stop - restored on the next start
function persist(dir) {
    if (!dir || !predictions.hasPressures())
        return false
    const file = path.join(dir, HISTORY_FILE)
    try {
        const history = predictions.getAll().map(p => ({ datetime: p.datetime.getTime(), meta: p.meta }))
        fs.writeFileSync(file + '.tmp', JSON.stringify(history))
        fs.renameSync(file + '.tmp', file)
        log(`Saved ${history.length} pressure reading(s) to ${HISTORY_FILE}`)
        return true
    } catch (err) {
        log(`Cannot save pressure history: ${err.message}`)
        return false
    }
}

// restore the pressure history of the last 48h saved on plugin stop
function restore(dir) {
    if (!dir)
        return 0
    const file = path.join(dir, HISTORY_FILE)
    if (!fs.existsSync(file))
        return 0
    try {
        const threshold = Date.now() - HISTORY
        const history = JSON.parse(fs.readFileSync(file, 'utf8'))
            .filter(p => p && p.meta && typeof p.meta.value === 'number' && p.datetime >= threshold)
            .sort((a, b) => a.datetime - b.datetime)
        history.forEach(p => predictions.addPressure(new Date(p.datetime), p.meta.value, p.meta.altitude, p.meta.temperature, p.meta.twd))
        if (history.length > 0)
            latest.sampled = history[history.length-1].datetime
        log(`Restored ${history.length} pressure reading(s) from ${HISTORY_FILE}`)
        return history.length
    } catch (err) {
        log(`Cannot restore pressure history: ${err.message}`)
        return 0
    }
}

module.exports = {
    addSubscriptionHandler,
    isSubscribed,
    preLoad,
    onDeltaUpdate,
    onElevationUpdate,
    getTrendAndPredictions,
    persist,
    restore,
    predictWindSpeed,

    init: function(prefix, interval, rate) {
        latest.update = null;
        latest.sampled = null;
        latest.trend = null;
        latest.prediction = null;
        latest.description = null;
        refreshRate = interval * 1000;
        sampleRate = (typeof rate === 'number' && rate >= 0 ? rate : SAMPLE_RATE);
        subscriptionHandler = [];
        currentPressure = currentTemperature = currentWindDirection = navigationAltitude = navigationPosition = '';
        predictions.clear();
        // note: the published paths are fixed to environment.barometer.*
        if (prefix)
            pathPrefix = 'environment.'+prefix+'.'
    }
}
