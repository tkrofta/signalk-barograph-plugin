/*
   Copyright © 2026 Inspired Technologies. Rights Reserved.

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

'use strict'
const log = require('debug')('signalk-barograph')
const path = require('path')
const { getSourceId } = require('@signalk/signalk-schema')
const { DateTime } = require('luxon');
const influx = require("./influx")
const cache = require("./cache")
const barometer = require("./barometer")
const history = require("./history")
const openApi = require("./openApi.json")
const convert = require("./skunits")
const WAITING = 'waiting ...'
const DEFAULT_CONFIG = 'pathconfig.json'
const INTERVAL = 1000

// path configuration written when the plugin has none configured
function defaultPaths() {
    const hourly = 60*60*INTERVAL
    return [
        { path: 'environment.forecast.time', period: 10*INTERVAL, policy: "fixed" },
        { path: 'environment.outside.temperature', policy: "instant", minPeriod: INTERVAL, trend: "temperature" },
        { path: 'environment.forecast.temperature', period: hourly, policy: "fixed" },
        { path: 'environment.forecast.temperature.minimum', period: hourly, policy: "fixed" },
        { path: 'environment.forecast.temperature.maximum', period: hourly, policy: "fixed" },
        { path: 'environment.forecast.today.temperature.minimum', period: hourly, policy: "fixed" },
        { path: 'environment.forecast.today.temperature.maximum', period: hourly, policy: "fixed" },
        { path: 'environment.forecast.temperature.feelslike', period: hourly, policy: "fixed" },
        { path: 'environment.outside.pressure', policy: "instant", minPeriod: INTERVAL, trend: "pressure" },
        { path: 'environment.forecast.pressure', period: hourly, policy: "fixed" },
        { path: 'environment.outside.humidity', policy: "instant", minPeriod: INTERVAL },
        { path: 'environment.outside.relativeHumidity', policy: "instant", minPeriod: INTERVAL, config: 'relativeHumidity|>humidity' },
        { path: 'environment.forecast.relativeHumidity', period: hourly, policy: "fixed", config: 'relativeHumidity|>humidity' },
        { path: 'environment.forecast.description', period: hourly, policy:"fixed" },
        { path: 'environment.forecast.wind.direction', period: hourly, policy:"fixed" },
        { path: 'environment.forecast.wind.speed', period: hourly, policy:"fixed" },
        { path: 'environment.forecast.wind.gust', period: hourly, policy:"fixed" },
        { path: 'environment.forecast.weather.visibility', period: hourly, policy:"fixed" },
        { path: 'environment.forecast.weather.clouds', period: hourly, policy:"fixed" },
        { path: 'environment.forecast.weather.uvindex', period: hourly, policy:"fixed" },
        { path: 'environment.forecast.weather.icon', period: hourly, policy:"fixed" },
        { path: 'environment.forecast.weather.code', period: hourly, policy:"fixed" },
        { path: 'environment.wind.directionTrue', period: 10*INTERVAL, policy: "fixed", trend: "winddir", config: "wind.directionTrue|>outside.wind.direction" },
        { path: 'environment.outside.wind.direction', policy :"instant", minPeriod: INTERVAL, trend: "winddir" },
        { path: 'environment.outside.wind.speed', policy :"instant", minPeriod: INTERVAL },
        { path: 'environment.outside.wind.gust', policy :"instant", minPeriod: INTERVAL },
        { path: 'navigation.gnss.antennaAltitude', period: 60*INTERVAL, policy: 'fixed', trend:'altitude' },
        { path: 'navigation.position', period: 60*INTERVAL, policy: 'fixed', trend: 'position' }
    ]
}

// path configuration written when the configured file is missing or empty
function minimalPaths() {
    return [
        { path: 'environment.outside.temperature', policy: "instant", minPeriod: INTERVAL, trend: "temperature" },
        { path: 'environment.outside.pressure', policy: "instant", minPeriod: INTERVAL, trend: "pressure" },
        { path: 'environment.outside.humidity', policy: "instant", minPeriod: INTERVAL },
        { path: 'environment.outside.relativeHumidity', policy: "instant", minPeriod: INTERVAL, config: 'relativeHumidity|>humidity' },
        { path: 'environment.wind.directionTrue', period: 10*INTERVAL, policy: "fixed", trend: "winddir", config: "wind.directionTrue|>outside.wind.direction" },
        { path: 'environment.outside.wind.direction', policy :"instant", minPeriod: INTERVAL, trend: "winddir" },
        { path: 'environment.outside.wind.speed', policy :"instant", minPeriod: INTERVAL },
        { path: 'environment.outside.wind.gust', policy :"instant", minPeriod: INTERVAL },
        { path: 'navigation.gnss.antennaAltitude', period: 60*INTERVAL, policy: 'fixed', trend:'altitude' },
        { path: 'navigation.position', period: 60*INTERVAL, policy: 'fixed', trend: 'position' }
    ]
}

function isEmpty(value) {
    return value===undefined || value===null || value===WAITING ||
        (typeof value==="object" && Object.keys(value).length===0)
}

module.exports = function (app) {

    var plugin = {};
    var influxConfig = {
        initialized: false
    };

    plugin.id = 'signalk-barograph'
    plugin.name = 'Barograph powered by SignalK'
    plugin.description = 'Plugin to provide data & graphics for aggregated environmental information using influxdb (pressure, temperature, humidity)'

    var unsubscribes = []
    let timerId
    let metrics = []
    let pathConfig = {}
    let valueConfig = {}
    let running = false         // guards the asynchronous influx health check against an early stop
    let generation = 0          // ... and against a check of a previous start completing after a restart
    let reported = ''           // last plugin status set from the offline cache

    // plugin status from the offline cache: pending files are shown, a filling cache is raised as error
    function reportCache() {
        const state = cache.usage(influxConfig.cacheDir)
        const message = state.files===0 ? 'Started' :
            (state.warning ? `Influx writes failing - offline cache ${state.message}` : `Started - offline cache ${state.message}`)
        if (message===reported)
            return
        reported = message
        if (state.warning)
            app.setPluginError(message)
        else
            app.setPluginStatus(message)
    }

    function source(update) {
        if (update['$source']) {
          return update['$source']
        } else if (update['source']) {
          return getSourceId(update['source'])
        }
        return ''
    }

    // timestamp for forecast paths - the time the forecast is valid for
    function forecastTime(timestamp) {
        const fctime = app.getSelfPath('environment.forecast.time')
        if (fctime && fctime.value && fctime.value!==WAITING) {
            const time = DateTime.fromISO(fctime.value)
            if (time.isValid)
                return time.toUTC()
        }
        if (influxConfig.currentForecast && influxConfig.currentForecast.isValid)
            return influxConfig.currentForecast.toUTC()
        return timestamp
    }

    function subscribe(influxDB, result, started) {
        if (!running || started!==generation) {
            log('Plugin stopped before influx health check completed - not subscribing')
            return false
        }
        // influx is checked once on start: if it fails, the plugin is set to error and keeps publishing predictions
        influxConfig.online = (result && result.status === 'pass')
        if (influxConfig.online)
            log({
                organization: influxConfig.organization,
                buckets: {
                    write: influxConfig.bucket,
                    read: influxConfig.read
                }
            })
        //configure paths
        if (influxConfig.paths.length===0) {
            influxConfig.paths = minimalPaths()
            influx.save(path.dirname(influxConfig.configFile), path.basename(influxConfig.configFile), influxConfig.paths)
        }
        influxConfig.paths.forEach(p => {
            if (p.hasOwnProperty('config'))
                pathConfig[p.path] = influx.reconfig(p.path, p.config)
            if (p.hasOwnProperty('convert'))
                valueConfig[p.path] = p.convert
            if (p.hasOwnProperty('trend')) {
                barometer.addSubscriptionHandler(p.trend, p.path)
                influxConfig.trends[p.trend] = p.path
                // hack: server version > 1.39, startup timing issue
                let val = app.getSelfPath(p.path)
                if (p.trend==='altitude' && val && val.value) {
                    barometer.onElevationUpdate(val.value)
                }
            }
        });
        // preload barometer
        let preload = barometer.preLoad()
        if (preload)
        {
            sendDelta(preload.update)
            if (preload.meta!==null)
                sendMeta(preload.meta)
        }
        app.setPluginStatus('Initialized');
        // ready to push data
        timerId = setInterval(() => {
            if (influxConfig.online && metrics.length !== 0) {
                log(`Sending ${metrics.length} data points to be uploaded to influx`)
                influx.post(influxDB, metrics, influxConfig)
                influx.buffer(metrics)
                metrics = []
            }
            if (influxConfig.online)
                reportCache()
            let updates = barometer.getTrendAndPredictions(2*influxConfig.loadFrequency*1000)
            if (updates.length>0)
                sendDelta(updates)
        }, influxConfig.loadFrequency*1000)
        log(`Interval started, upload frequency: ${influxConfig.loadFrequency}s`)

        let localSubscription = {
            context: 'vessels.self', // Get data only for self context
            subscribe: influxConfig.paths
        };

        app.subscriptionmanager.subscribe (
            localSubscription,
            unsubscribes,
            subscriptionError => {
                app.error('Error:' + subscriptionError);
            },
            delta => {
                if (!Array.isArray(delta.updates))
                  return
                delta.updates.forEach(u => {
                    if (!Array.isArray(u.values) || u.values.length===0 || !u.values[0].path || isEmpty(u.values[0].value))
                        return
                    const path = pathConfig[u.values[0].path] ? pathConfig[u.values[0].path] : u.values[0].path
                    const values = !valueConfig[u.values[0].path] ? u.values[0].value :
                        convert.toTarget(valueConfig[u.values[0].path].split('|>')[0], u.values[0].value, valueConfig[u.values[0].path].split('|>')[1]).value
                    let timestamp = DateTime.fromISO(u.timestamp).toUTC()
                    if (path==='environment.forecast.time') {
                        // conversion not required due to dt format change in openweather plugin (v0.5)
                        influxConfig.currentForecast = DateTime.fromISO(u.values[0].value)
                        return
                    }
                    if (path.includes('environment.forecast'))
                        timestamp = forecastTime(timestamp)
                    else if (barometer.isSubscribed(u.values[0].path))
                        // fix: subscription is on the original path
                        barometer.onDeltaUpdate(u)
                    if (influxConfig.online && path.includes('environment'))
                    {
                        const metric = influx.format(path, values, timestamp, source(u))
                        if (metric!==null)
                            metrics.push(metric)
                    }
                })
            }
        );
        if (influxConfig.online) {
            reported = ''
            reportCache()
            log('Plugin started');
        } else {
            // the exact reason helps when checking the plugins after a server restart
            const reason = result && result.message ? ` (${result.message})` : ''
            app.setPluginError(`Failed to connect to Influx${reason} - publishing predictions only`);
            log(`Influx not available${reason} - publishing predictions only`);
        }
        return influxConfig.online
    }

    plugin.start = function (options, restartPlugin) {

        log('Plugin starting ...');
        app.setPluginStatus('Initializing');
        running = true
        const started = ++generation

        metrics = []
        pathConfig = {}
        valueConfig = {}
        influxConfig = { initialized: false, online: false, trends: {} }
        influxConfig.cacheDir = app.getDataDirPath()
        if (!options.pathConfig)
        {
            options.pathConfig = DEFAULT_CONFIG
            influx.save(app.getDataDirPath(), options.pathConfig, defaultPaths())
            log('No path configuration provided, using default configuration and saving to plugin data directory')
            app.savePluginOptions(options, () => {log('Plugin options saved')});
        }
        // re-read on every start - a restart from the server UI picks up changes of the file
        influxConfig.configFile = options.pathConfig.includes('/') ? options.pathConfig : path.join(app.getDataDirPath(), options.pathConfig)
        influxConfig.paths = influx.config(influxConfig.configFile)
        influxConfig.organization = (options.influxOrg ? options.influxOrg : '')
        influxConfig.bucket = (options.influxBucket ? options.influxBucket : '')
        influxConfig.read = (options.influxRead ? options.influxRead : (options.influxBucket ? options.influxBucket : ''))
        influxConfig.retention = (options.writeRetention ? options.writeRetention : 3)
        influxConfig.loadFrequency = (options.loadFrequency ? options.loadFrequency : 30)
        influxConfig.id = app.getSelfPath('mmsi') ? app.getSelfPath('mmsi') : app.getSelfPath('uuid')

        // predictions do not depend on influx - restore the pressure history saved on the last stop
        barometer.init(options["barometer"], influxConfig.loadFrequency)
        barometer.restore(app.getDataDirPath())

        // kept on the server only - the app queries the history through the plugin endpoint
        influxConfig.url = options.influxUri
        influxConfig.token = options.influxToken || ''
        const influxDB = influx.login({
            url: influxConfig.url,          // get from options
            token: influxConfig.token,      // get from options
            timeout: 10 * 1000              // 10sec timeout for health check
        }, influxConfig.cacheDir)
        influxConfig.client = influxDB
        influxConfig.initialized = true
        influx.health(influxDB, (db, result) => subscribe(db, result, started))

        log('Plugin initialized');
    };

    plugin.stop = function () {
        running = false
        unsubscribes.forEach(f => f());
        unsubscribes = [];
        clearInterval(timerId)
        timerId = undefined
        log('Interval Timer Stopped')
        metrics = influx.flush(metrics, influxConfig.cacheDir ? influxConfig.cacheDir : app.getDataDirPath())
        barometer.persist(app.getDataDirPath())
        log('Plugin stopped');
    };

    // configuration for the barograph app - no credentials
    function appSettings() {
        const pressure = influxConfig.trends && influxConfig.trends.pressure
        return {
            running,
            paths: {
                pressure: pressure || 'environment.outside.pressure',
                temperature: (influxConfig.trends && influxConfig.trends.temperature) || 'environment.outside.temperature',
                altitude: (influxConfig.trends && influxConfig.trends.altitude) || 'navigation.gnss.antennaAltitude',
                barometer: 'environment.barometer.'
            },
            history: {
                available: !!(running && influxConfig.online),
                retention: influxConfig.retention || 3,
                timescales: history.TIMESCALES
            },
            interval: influxConfig.loadFrequency || 30
        }
    }

    plugin.registerWithRouter = function (router) {
        // any logged-in user may read (server >= 2.31), older servers keep plugin routes admin only
        const readonly = typeof router.access === 'function' ? router.access('readonly') : router

        readonly.get('/settings', (req, res) => {
            res.json(appSettings())
        })

        readonly.get('/history', async (req, res) => {
            if (!running || !influxConfig.online || !influxConfig.client) {
                res.status(503).json({ message: 'influx not available' })
                return
            }
            const settings = appSettings()
            const source = pathConfig[settings.paths.pressure] || settings.paths.pressure
            try {
                res.json(await history.query(influxConfig.client, influxConfig, source, req.query.hours || 3))
            } catch (err) {
                log(`History query failed: ${err.message}`)
                res.status(err.status || 502).json({ message: err.message })
            }
        })
    }

    plugin.getOpenApi = () => openApi

    plugin.schema = {
        type: 'object',
        required: [
            'influxUri',
            'influxToken',
            'influxBucket',
            'pathConfig',
            'loadFrequency'
        ],
        properties: {
        "influxUri": {
                type: 'string',
                title: 'InfluxDB URI'
            },
        "influxToken": {
                type: 'string',
                title: 'InfluxDB Token',
                description: 'v2.x: [token]; V1.11.x: [username:password]'
            },
        "influxOrg": {
                type: 'string',
                title: 'InfluxDB Organisation',
                description: 'v2.x: [required]; V1.11.x: [empty]'
            },
        "influxBucket": {
                type: 'string',
                title: 'InfluxDB Write Bucket',
                description: 'v2.x: [bucket]; v1.11.x: [database/retentionpolicy]'
            },
        "influxRead": {
                type: 'string',
                title: 'InfluxDB Read Bucket',
                description: 'v2.x: [bucket]; v1.11.x: [database/retentionpolicy]',
            },
        "pathConfig": {
                type: 'string',
                title: 'Paths Configuration',
                description: 'paths config file [plugin data directory]',
                default: 'barograph.config.json'
            },
        "loadFrequency": {
                type: 'number',
                title: 'Write Interval',
                description: 'frequency of batched write to InfluxDB in s',
                default: 30
            },
        "writeRetention": {
                type: 'number',
                title: 'Write Bucket Retention',
                description: 'if entered (hours), read bucket will only be used for queries greater than write retention period',
                default: 3
            },
        }
    };


    /**
     *
     * @param {Array<[{path:path, value:value}]>} messages
     */
    function sendDelta(messages) {
        app.handleMessage('signalk-barograph', {
            updates: [
                {
                    values: messages
                }
            ]
        });
    }

    function sendMeta(units) {
        app.handleMessage('signalk-barograph', {
            updates: [
                {
                    meta: units
                }
            ]
        })
    }

    return plugin;
};
