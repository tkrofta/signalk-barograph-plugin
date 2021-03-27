const predictions = require ('barometer-trend')
const units = require ('./skunits')
let log = null
let type = 'trend'

let currentPressure = '';
let currentTemperature = '';
let navigationAltitude = '';
let navigationPosition = '';
function isSubscribed(path) {
    return (path===currentPressure || path===currentTemperature || path===navigationAltitude || path===navigationPosition)
}

let pathPrefix = "environment.barometer.";
const barometerTrend = pathPrefix+"trend";
const trendTime = pathPrefix+"trend.time";
const barometerPrediction = pathPrefix+"prediction";
const predictionTime = pathPrefix+"prediction.time";
const barometerDescription = pathPrefix+'description';
/*
const forecastSunrise = pathPrefix+"trend.sunrise";
const forecastSunset = pathPrefix+"time.sunset";
const simpleTemp = pathPrefix+'temperature';
const simpleHumidity = pathPrefix+'humidity';
const simplePressure = pathPrefix+'pressure';
const simpleDescription = pathPrefix+'description';
const simpleRain = pathPrefix+'rain';
const simpleWeatherCode = pathPrefix+'weather.code';
const fullMain = pathPrefix+'weather';
const fullIcon = pathPrefix+'weather.icon';
const fullTempMin = pathPrefix+'temperature.minimum';
const fullTempMax = pathPrefix+'temperature.maximum';
const fullFeelsLike = pathPrefix+'temperature.feelslike';
const fullDewPoint = pathPrefix+'temperature.dewpoint';
const fullUVIndex = pathPrefix+'weather.uvindex';
const fullClouds = pathPrefix+'weather.clouds';
const fullVisibility = pathPrefix+'weather.visibility';
const fullWindSpeed = pathPrefix+'wind.speed';
const fullWinDir = pathPrefix+'wind.direction';
*/

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
            (latest.altitude!=='' ? latest.altitude.value : null),
            (latest.temperature!=='' ? units.toTarget('K', latest.temperature.value, 'deg').value : null),
            null)
        log({ pressure: latest.pressure.value, altitude: latest.altitude.value, temperature: latest.temperature.value, wind: null });
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

function prepareUpdate(type) {
    const noData = "waiting ..."
    switch (type) {
        case 'description': return [
            buildDeltaUpdate(barometerDescription, latest.description !== null ? latest.description : noData),
        ];
        case 'trend': return [
            buildDeltaUpdate(trendTime, latest.trend.time !== null ? latest.trend.time : noData),
        ];
        case 'prediction': return [
            buildDeltaUpdate(predictionTime, latest.prediction.time !== null ? latest.prediction.time : noData),
        ];
        case 'meta-trend': return [
/*            buildDeltaUpdate(simpleTemp, { units: "K" }),
            buildDeltaUpdate(simpleHumidity, { units: "ratio" }),
            buildDeltaUpdate(simplePressure, { units: "Pa" }) */
        ];
        case 'meta-prediction': return [
/*            buildDeltaUpdate(simpleTemp, { units: "K" }),
            buildDeltaUpdate(fullTempMin, { units: "K" }),
            buildDeltaUpdate(fullTempMax, { units: "K" }),
            buildDeltaUpdate(fullFeelsLike, { units: "K" }),
            buildDeltaUpdate(simpleHumidity, { units: "ratio" }),
            buildDeltaUpdate(simplePressure, { units: "Pa" }),
            buildDeltaUpdate(fullDewPoint, { units: "K" }),
            buildDeltaUpdate(fullWindSpeed, { units: "m/s" }),
            buildDeltaUpdate(fullWinDir, { units: "rad" }) */
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
    let meta = null
    // add units to updates
    /* if (initial) {
        type = 'meta-'+type
        meta = prepareUpdate(null, null, null);
        type = type.replace('meta-', '')        
    } */
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
    getTrendAndPredictions,

    init: function(loghandler, prefix) {
        log = loghandler;
        latest.update = null;
        predictions.clear();
        if (prefix!=='')
            pathPrefix = 'environment.'+prefix+'.'
    }
}