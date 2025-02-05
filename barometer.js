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

const units = require ('./skunits')
let log = null
let refreshRate = null

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
    let handler
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
            break;
    }
    if (handler!==null)
        subscriptionHandler.push(handler)
}

function onDeltaUpdate(update) {
    update.values.forEach((value) => {
        let onDeltaUpdated = subscriptionHandler.find((d) => d.path === value.path);

        if (onDeltaUpdated !== null) {
            onDeltaUpdated.handle(value.value);
        }
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
                // +", Wind forecast: "+forecast.predictions.beaufort
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

function onPressureUpdate(value) {
    if (value === null) 
    {
        log("Cannot add null value as pressure - ignoring ...");
    }
    else if (value!=="waiting ...")
    {
        latest.pressure = { value, time: Date.now() }
        predictions.addPressure(new Date(latest.pressure.time), value, 
            (latest.altitude!==null ? latest.altitude.value : null),
            (latest.temperature!==null ? latest.temperature.value : null),
            (latest.winddir!==null ? units.toTarget('rad', latest.winddir.value, 'deg', 0).value : null))
        log({ pressure: latest.pressure.value, altitude: (latest.altitude!==null ? latest.altitude.value : null), 
            temperature: (latest.temperature!==null ? latest.temperature.value : null), 
            winddir: (latest.winddir!==null ? Math.round(latest.winddir.value*100)/100 : null) });
    }
}

function onTemperatureUpdate(value) {
    if (value === null) 
        log("Cannot add null value as temperature - ignoring ...");
    else if (value!=="waiting ...")
        latest.temperature = { value, time: Date.now() }
}

function onWindDirUpdate(value) {
    if (value === null) 
        log("Cannot add null value as wind direction - ignoring ...");
    else if (value!=="waiting ...")
        latest.winddir = { value, time: Date.now() }
}

function onElevationUpdate(value) {
    if (value === null) 
    {
        log("Cannot add null value as elevation - using 0 instead");
        latest.altitude.elevation = 0
    }
    else if (value!=="waiting ...")
    {
        latest.altitude = { value, time: Date.now() } 
        log("Elevation set to "+value+"m above sea level");
    }
}

function onPositionUpdate(value) {
    let current = latest.hemisphere 
    if (value === null) 
    {
        log("Cannot add null value as position - defaulting to northern hemisphere");
        latest.hemisphere = 'N'
    }
    else if (lastUpdateWithin(30*60*1000))
    {
        latest.hemisphere = value.latitude < 0 ? 'S' : 'N';
    }
    if (current!==latest.hemisphere)
        log("Hemisphere set to "+latest.hemisphere);
}

function predictWindSpeed(prediction, calc) {
    if (prediction==='Less than F6') {
        if (calc==='min')
            return 0;
        else
            return 6;
    } else {
        if (prediction.includes('-')) {
            forecast = prediction.replace('F', '').split('-')
            if (calc==='min')
                return forecast[0]
            else
                return forecast[1]
        } else if (prediction.includes('+')) {
            forecast = prediction.replace('F', '').split('+')
            if (calc==='min')
                return forecast[0]
            else
                return 12
        } else {
            return int.parse(prediction.replace('F', ''))
        }
    }
}

function prepareUpdate(type) {
    const noData = "waiting ..."
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
            buildDeltaUpdate(type, predictionWindMin, latest.prediction !== null ? units.toSignalK('BftMin', predictWindSpeed(latest.prediction.beaufort.force, 'min')).value : noVal),
            buildDeltaUpdate(type, predictionWindMax, latest.prediction !== null ? units.toSignalK('BftMax', predictWindSpeed(latest.prediction.beaufort.force, 'max')).value : noVal),
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

module.exports = {
    addSubscriptionHandler,    
    isSubscribed,
    preLoad,
    onDeltaUpdate,
    onElevationUpdate,
    getTrendAndPredictions,

    init: function(loghandler, prefix, interval) {
        log = loghandler;
        latest.update = null;
        refreshRate = interval * 1000;
        predictions.clear();
        if (prefix!=='')
            pathPrefix = 'environment.'+prefix+'.'
    }
}
