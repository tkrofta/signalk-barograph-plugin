const predictions = require ('barometer-trend')
const units = require ('./skunits')
let log = null

let currentPressure = '';
let currentTemperature = '';
let navigationAltitude = '';
let navigationPosition = '';
function isSubscribed(path) {
    return (path===currentPressure || path===currentTemperature || path===navigationAltitude || path===navigationPosition)
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
    altitude: null,
    trend: null,
    prediction: null,
    description: null
}

let subscriptionHandler = []
function addSubcriptionHandler (type, path) {
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
                log ({count: predictions.getPressureCount(), trend: latest.trend, prediction: latest.prediction })
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
            (latest.temperature!==null ? units.toTarget('K', latest.temperature.value, 'deg').value : null),
            null)
        log({ pressure: latest.pressure.value, altitude: (latest.altitude!==null ? latest.altitude.value : null), 
            temperature: (latest.temperature!==null ? latest.temperature.value : null), wind: null });
    }
}

function onTemperatureUpdate(value) {
    if (value === null) 
        log("Cannot add null value as temperature - ignoring ...");
    else if (value!=="waiting ...")
        latest.temperature = { value, time: Date.now() }
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
    if (value === null) 
    {
        log("Cannot add null value as position - defaulting to northern hemisphere");
        latest.hemisphere = 'N'
    }
    else if (lastUpdateWithin(30*60*1000))
    {
        latest.hemisphere = value.latitude < 0 ? 'S' : 'N';
    }
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
        } else if (prediction.include('+')) {
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
            buildDeltaUpdate(barometerDescription, latest.description !== null ? latest.description : noData),
        ];
        case 'trend': return [
            buildDeltaUpdate(barometerTrend, latest.trend !== null ? { severity: latest.trend.severity, tendency: latest.trend.tendency, changerate: latest.trend.trend } : {}),
            buildDeltaUpdate(trendDifference, latest.trend !== null ? units.toSignalK('Pa', latest.trend.difference).value : noVal),
            buildDeltaUpdate(trendPeriod, latest.trend !== null ? (-1)*latest.trend.period*60 : noVal)
        ];
        case 'prediction': return [
            buildDeltaUpdate(barometerPrediction, latest.prediction !== null ? latest.prediction.season : noData),
            buildDeltaUpdate(predictionWind, latest.prediction !== null ? latest.prediction.beaufort : noData),
            buildDeltaUpdate(predictionWindDir, latest.prediction !== null ? latest.prediction.quadrant : noData),
            buildDeltaUpdate(predictionWindMin, latest.prediction !== null ? units.toSignalK('BftMin', predictWindSpeed(latest.prediction.beaufort, 'min')).value : noVal),
            buildDeltaUpdate(predictionWindMax, latest.prediction !== null ? units.toSignalK('BftMax', predictWindSpeed(latest.prediction.beaufort, 'max')).value : noVal),
            buildDeltaUpdate(predictionFront, latest.prediction !== null ? latest.prediction.front: { key: 'N/A' }),
        ];
        case 'meta-trend': return [
            buildDeltaUpdate(trendDifference, { units: "Pa" }),
            buildDeltaUpdate(trendPeriod, { units: "s" })
        ];
        case 'meta-prediction': return [
            buildDeltaUpdate(predictionWindDir, { units: "" }),
            buildDeltaUpdate(predictionWindMin, { units: "m/s" }),
            buildDeltaUpdate(predictionWindMax, { units: "m/s" })
        ];
        default:
            return [];
    }
}

function buildDeltaUpdate(path, value) {
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
    addSubcriptionHandler,    
    isSubscribed,
    preLoad,
    onDeltaUpdate,
    onElevationUpdate,
    getTrendAndPredictions,

    init: function(loghandler, prefix) {
        log = loghandler;
        latest.update = null;
        predictions.clear();
        if (prefix!=='')
            pathPrefix = 'environment.'+prefix+'.'
    }
}