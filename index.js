'use strict'
const debug = require("debug")("signalk:signalk-barograph")
const influx = require("./influx")
const fs = require('fs')
const path = require('path')
const WAITING = 'waiting ...'


module.exports = function (app) {

    var plugin = {};
    var influxConfig = {
        initialized: false
    };

    plugin.id = 'signalk-barograph';
    plugin.name = 'Barograph powered by SignalK';
    plugin.description = 'Plugin to provide data & graphics for aggregated environmental information using influxdb (pressure, temperature, humidity)';

    var unsubscribes = [];
    let timerId;
    let metrics;
    
    function saveconfig(dir, file, content) {
        fs.writeFileSync(
            path.join(dir, file),
            JSON.stringify(content).concat("\n"), (err) => {
              if (err) throw err;
              return null
            }
          )
        return file
    }

    function subscribe(influxDB, result) {
        if (influxConfig.initialized && result.status === 'pass' ) {

            if (influxConfig.paths.length===0) {
                // Reconfig subscriptions                
                influxConfig.paths = influx.config('environment', 10*1000)
                var options = app.readPluginOptions();
                saveconfig(app.getDataDirPath(), options.configuration.pathConfig, influxConfig.paths)
            }

            app.setPluginStatus('Initialized');

            timerId = setInterval(() => {
                app.debug (`Sending ${metrics.length} metrics to be uploaded to influx`)
                if (metrics.length !== 0) {
                    influx.post(influxDB, metrics, influxConfig, log)
                    influx.cacheBuffer = metrics
                    metrics = []
                }
            }, influxConfig.loadFrequency*1000)
            app.debug (`Interval started, upload frequency: ${influxConfig.loadFrequency}s`)

            let localSubscription = {
                context: '*', // Get data for all contexts
                subscribe: influxConfig.paths
            };

            app.subscriptionmanager.subscribe(
            localSubscription,
            unsubscribes,
            subscriptionError => {
                app.error('Error:' + subscriptionError);
            },
            delta => {
                if (!delta.updates) {
                return;
                }
                delta.updates.forEach(u => {
                    if (!u.values || u.values[0].path===undefined || u.values[0].value===WAITING) {
                        return;
                    }
                    const path = u.values[0].path
                    const values = u.values[0].value
                    var timestamp = u.timestamp
                    if (path.includes('environment.forecast.time'))
                        influxConfig.currentForecast = new Date(u.values[0].value*1000).toISOString()
                    else {
                        if (path.includes('environment.forecast')) {
                            if (app.getSelfPath('environment.forecast.time').value===WAITING)
                                timestamp = influxConfig.currentForecast
                            else
                                timestamp = new Date(app.getSelfPath('environment.forecast.time').value*1000).toISOString()
                        }
        
                        const metric = influx.format(path, values, timestamp, influxConfig)
                        if (metric!==null)
                            metrics.push(metric)    
                    }
                })
            }
            );
            app.setPluginStatus('Started');
            app.debug('Plugin started');
            return true
        }
        else
        {
            app.setPluginError('Failed to connect to Influx');
            return false
        }
    }

    plugin.start = function (options, restartPlugin) {

        app.debug('Plugin starting ...');
        app.setPluginStatus('Initializing');

        metrics = []
        influx.cacheBuffer = []
        influxConfig.cacheDir = app.getDataDirPath()
        var configFile = options.pathConfig
        if (options.pathConfig===undefined) 
        {   
            options.pathConfig = 'pathconfig.json'
            configFile = saveconfig(app.getDataDirPath(), options.pathConfig, [])
            app.savePluginOptions(options, () => {app.debug('Plugin options saved')});
        }
        influxConfig.paths = require(configFile.includes('/') ? configFile : require('path').join(app.getDataDirPath(), configFile))
        influxConfig.organization = options.influxOrg
        influxConfig.bucket = options.influxBucket
        influxConfig.id = app.getSelfPath('mmsi') ? app.getSelfPath('mmsi') : app.getSelfPath('uuid')

        const influxDB = influx.login({
            url: options.influxUri,         // get from options
            token: options.influxToken,     // get from options
            timeout: 10 * 1000              // 10sec timeout for health check
        }, log)

        influxConfig.initialized = influx.health(influxDB, log, subscribe)
        influxConfig.loadFrequency = (options.loadFrequency ? options.loadFrequency : 30) 

        app.debug('Plugin initialized');
    };

    plugin.stop = function () {
        unsubscribes.forEach(f => f());
        unsubscribes = [];
        clearInterval(timerId)
        app.debug('Interval Timer Stopped')
        app.debug('Plugin stopped');
    };

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
                description: 'v2.x: [token]; V1.8.x: [username:password]'
            },
        "influxOrg": {
                type: 'string',
                title: 'InfluxDB Organisation',
                description: 'v2.x: [required]; V1.8.x: [empty]'
            },
        "influxBucket": {
                type: 'string',
                title: 'InfluxDB Bucket',
                description: 'v2.x: [bucket]; v1.8.x: [database/retentionpolicy]'
            },
        /* "cacheDirectory": {
            type: 'string',
            title: 'full path to directory where the buffer should be stored (note no at end of dir)',
            default: '/home/pi/.barograph'
        }, */
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
            }
        }
    };

    function log(msg) { app.debug(msg); }

    return plugin;
};