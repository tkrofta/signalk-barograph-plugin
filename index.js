/* 
   Copyright © 2024 Inspired Technologies GmbH. Rights Reserved.

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
const debug = require("debug")("signalk:signalk-barograph")
const { getSourceId } = require('@signalk/signalk-schema')
const influx = require("./influx")
const barometer = require("./barometer")
const appconfig = require ("./appconfig")
const convert = require("./skunits")
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
    let pathConfig = {}
    let valueConfig = {}
    
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

    function reconfig(path, config) {

        if (config.includes('|>')) {
            // replace
            const param = config.split('|>')
            return path.replace(param[0], param[1])
        }

        return null
    }

    function source(update) {
        if (update['$source']) {
          return update['$source']
        } else if (update['source']) {
          return getSourceId(update['source'])
        }
        return ''
    }

    function subscribe(influxDB, result) {
        if (influxConfig.initialized && result.status === 'pass' ) {

            if (influxConfig.paths.length===0) {
                // Reconfig subscriptions                
                influxConfig.paths = influx.config('environment', 10*1000)
                influx.config('navigation', 0).forEach(p => influxConfig.paths.push(p))
                var options = app.readPluginOptions();
                saveconfig(app.getDataDirPath(), options.configuration.pathConfig, influxConfig.paths)
            } 
            if (influxConfig.paths.length>0)
            {
                influxConfig.paths.forEach(p => {
                    if (p.hasOwnProperty('config'))
                        pathConfig[p.path] = reconfig(p.path, p.config)
                    if (p.hasOwnProperty('convert'))
                        valueConfig[p.path] = p.convert                                         
                    if (p.hasOwnProperty('trend')) {
                        barometer.addSubscriptionHandler(p.trend, p.path)
                        appconfig.addSubscription(p.trend, p.path)
                        // hack: server version > 1.39, startup timing issue
                        let val = app.getSelfPath(p.path)
                        if (p.trend==='altitude' && val && val.value) {
                            barometer.onElevationUpdate(val.value)
                        }
                    }
                });
            }

            let preload = barometer.preLoad()
            if (preload)
            {
                sendDelta(preload.update)
                if (preload.meta!==null)
                    sendMeta(preload.meta)
            }
            app.setPluginStatus('Initialized');

            timerId = setInterval(() => {
                app.debug (`Sending ${metrics.length} data points to be uploaded to influx`)
                if (metrics.length !== 0) {
                    influx.post(influxDB, metrics, influxConfig, log)
                    influx.buffer(metrics)
                    metrics = []
                }
                let updates = barometer.getTrendAndPredictions(influxConfig.loadFrequency*1000)
                if (updates.length>0)
                    sendDelta(updates)
            }, influxConfig.loadFrequency*1000)
            app.debug (`Interval started, upload frequency: ${influxConfig.loadFrequency}s`)

            var appConfigTimer = setInterval( (log) => {
                appconfig.setAppUserData(log);
                clearInterval(appConfigTimer);               
              }, 5000, log);
              
            let localSubscription = {
                context: 'vessels.self', // Get data only for self context
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
                    if (!u.values || u.values[0].path===undefined || (u.values[0].value===WAITING || u.values[0].value===null || 
                        (typeof u.values[0].value==="object" && Object.keys(u.values[0].value)===0))) {
                        return;
                    }
                    const path = (pathConfig[u.values[0].path] ? pathConfig[u.values[0].path] : u.values[0].path)
                    const values = (!valueConfig[path] ? u.values[0].value : 
                        convert.toTarget(valueConfig[u.values[0].path].split('|>')[0], u.values[0].value, valueConfig[u.values[0].path].split('|>')[1]).value )
                    var timestamp = u.timestamp
                    if (path==='environment.forecast.time')
                        // conversion not required due to dt format change in openweather plugin (v0.5) 
                        // influxConfig.currentForecast = new Date(u.values[0].value*1000).toISOString()
                        influxConfig.currentForecast = u.values[0].value
                    else {
                        if (path.includes('environment.forecast')) {
                            let fctime = app.getSelfPath('environment.forecast.time')
                            if (!fctime || fctime.value===null || fctime.value===WAITING)
                                timestamp = influxConfig.currentForecast
                            else
                                timestamp = fctime.value
                            }
                        else if (barometer.isSubscribed(u.values[0].path))
                        {   // fix: subscription is on the original path 
                            barometer.onDeltaUpdate(u)
                        }
                        if (path.includes('environment'))
                        {
                            const metric = influx.format(path, values, timestamp, source(u))
                            if (metric!==null)
                                metrics.push(metric)
                        }
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
        try {
            influxConfig.paths = require(configFile.includes('/') ? configFile : require('path').join(app.getDataDirPath(), configFile))
        }
        catch {
            let paths = influx.config('environment', 10*1000)
            influx.config('navigation', 0).forEach(p => paths.push(p))
            configFile = saveconfig(app.getDataDirPath(), options.pathConfig, paths)
            influxConfig.paths = require(configFile.includes('/') ? configFile : require('path').join(app.getDataDirPath(), configFile))
        }
        influxConfig.organization = (options.influxOrg ? options.influxOrg : '')
        influxConfig.write = (options.influxBucket ? options.influxBucket : '')
        influxConfig.read = (options.influxRead ? options.influxRead : (options.influxBucket ? options.influxBucket : ''))
        influxConfig.retention = (options.writeRetention ? options.writeRetention : 3)
        influxConfig.id = app.getSelfPath('mmsi') ? app.getSelfPath('mmsi') : app.getSelfPath('uuid')
        appconfig.addInflux('id', influxConfig.id)

        const influxDB = influx.login({
            url: options.influxUri,         // get from options
            token: options.influxToken,     // get from options
            timeout: 10 * 1000              // 10sec timeout for health check
        }, log)
        appconfig.addInflux('url', options.influxUri+(influxConfig.organization==='' ? '/api/v2/query' : ''))
        appconfig.addInflux('token', options.influxToken)
        appconfig.addInflux('org', influxConfig.organization)
        appconfig.addInflux('write', influxConfig.write)
        appconfig.addInflux('read', influxConfig.read)
        appconfig.addInflux('retention', influxConfig.retention)
        appconfig.addInflux('username', options.influxToken.includes(':') ? options.influxToken.split(':')[0] : '') // not relevant for >2.x
        appconfig.addInflux('password', options.influxToken.includes(':') ? options.influxToken.split(':')[1] : '') // not relevant for >2.x
        let connectionString = []
        if (!options.selfRef) {
            connectionString.push('http://localhost:3000'); // default local server
            connectionString.push(''); // empty username
            connectionString.push(''); // empty password
        } else if (connectionString.length===1) {           // server only
            connectionString.push(''); // empty username
            connectionString.push(''); // empty password
        } else {
            connectionString=options.selfRef.split('|')
        }
        appconfig.init(connectionString[0], connectionString[1], connectionString[2], log)
        influxConfig.initialized = influx.health(influxDB, log, subscribe)
        influxConfig.loadFrequency = (options.loadFrequency ? options.loadFrequency : 30)
        // TODO: if configured
        barometer.init(app.debug, options["barometer"], influxConfig.loadFrequency)

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
                title: 'InfluxDB Write Bucket',
                description: 'v2.x: [bucket]; v1.8.x: [database/retentionpolicy]'
            },
        "influxRead": {
                type: 'string',
                title: 'InfluxDB Read Bucket',
                description: 'v2.x: [bucket]; v1.8.x: [database/retentionpolicy]',
            },
        "selfRef": {
                type: 'string',
                title: 'Connection String (server|username|password)',
                default: 'http://localhost:3000|user|pwd',
                description: 'SignalK Server credentials required to provide configuration to embedded web app'
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

    function log(msg) { app.debug(msg); }

    return plugin;
};