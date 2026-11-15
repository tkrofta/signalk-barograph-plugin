/* 
    Copyright © 2026 Inspired Technologies. All Rights Reserved.

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

const { InfluxDB, Point } = require('@influxdata/influxdb-client')
const { HealthAPI } = require('@influxdata/influxdb-client-apis')
const { DateTime } = require('luxon')
const fs = require('fs') 
const path = require('path')
const cache = require('./cache')
const log = require("debug")("signalk-barograph:influx")

const BatchSize = 5000

let cacheDir = ''
let cacheBuffer = []        // points posted but not yet confirmed - cached on flush (plugin stop)
let replaying = false

function buffer(metrics) {
    if (Array.isArray(metrics))
        metrics.forEach(m => cacheBuffer.push(m))
}

// drop confirmed or cached points from the buffer
function release(metrics) {
    const done = new Set(metrics)
    cacheBuffer = cacheBuffer.filter(p => !done.has(p))
}

function flush(metrics, cachedir) {
    if (cachedir)
      cacheDir = cachedir
    if (metrics)
      buffer(metrics)
    if (cacheBuffer.length > 0 && cache.push(cacheBuffer, cacheDir))
      cacheBuffer = []
    return []
  }

// read a json configuration file - re-read on every call (no require cache), [] if missing or invalid
function config(configfile, interval) {
    if (!configfile || !fs.existsSync(configfile))
        return []
    try {
        const configPaths = JSON.parse(fs.readFileSync(configfile, 'utf8'))
        return Array.isArray(configPaths) ? configPaths : []
    } catch (err) {
        log(`Invalid configuration ${configfile}: ${err.message}`)
        return []
    }
}

function reconfig (path, config) {
    if (config.includes(':')){
      const param = config.split(':')
      const res = reconfig(path, param[0])
      return reconfig(res, param[1]) 
    }
    else if (config.includes('|>')) {
      // replace
      const param = config.split('|>')
      return path.replace(param[0], param[1])
    } else if (config.includes('+>')) {
      // add
      const param = config.split('+>')
      return param[0]+path+"."+param[1]
    } else if (config.includes('~')) {
      // switch+embed
      const param = config.split('~')
      const rotate = '*.'+path.split('.*')[0]+path.split('.*')[1]
      return param[0]+rotate+param[1]
    } else if (config.includes('^')) {
        // lookup
        return config    
    }
    return null
}

function match(paths, actual)
{
    if (!Array.isArray(paths))
        return ''

    let found = ''
    paths.forEach(p => {
        let p1 = p.split('.')
        let p2 = actual.split('.')
        let i = 0

        while (i<p1.length)
        {
            if (p1[i]!=='*' && p1[i]!==p2[i])
                break;
            if (i===p1.length-1)
                found = p;
            i++
        }
    })

    return found
}

function save(dir, file, content) {
    fs.writeFileSync(path.join(dir, file), JSON.stringify(content).concat("\n"))
    return file
}

function check(dir, file) {
    return fs.existsSync(path.join(dir, file));
}

function login(clientOptions, cachedir) {
    try {
        const influxDB = new InfluxDB(clientOptions)
        cacheDir = cachedir
        log("Influx Login successful")
        return influxDB
    } catch (err) {
        log("Error logging into influx: "+err)         
    }
}

// single health check - the callback receives { status: 'pass' } or { status: 'fail', message } in any case
async function health (influxDB, callback) {
    if (!influxDB) {
        log("Influx healthCheck: No client!")
        return callback(influxDB, { status: 'fail', message: 'no influx client' })
    }

    log("Determining influx health")
    const healthAPI = new HealthAPI(influxDB)

    let result
    try {
        result = await healthAPI.getHealth()
        log('healthCheck: ' + (result.status === 'pass' ? 'OK' : 'NOT OK'))
    } catch (error) {
        log("HealthCheck "+error)
        result = { status: 'fail', message: error.message }
    }
    return callback(influxDB, result)
}

// rebuild a point read from the cache - tags and fields are kept as serialized (line protocol encoded),
// so every tag and the field type survive the round trip; files written before 2026-11 carry 'timestamp'
function revive (p) {
    const point = new Point(p.name)
    point.tags = Object.assign({}, p.tags)
    point.fields = Object.assign({}, p.fields)
    const time = p.time !== undefined ? p.time : p.timestamp
    if (time !== undefined)
        point.timestamp(time)
    return point
}

// write points - resolves once influx confirmed them, rejects otherwise
function write (influxdb, points, config) {
    // [Required] Organization | Empty for 1.8.x
    // [Required] Bucket | Database/Retention Policy
    // Precision of timestamp. [`ns`, `us`, `ms`, `s`]. The default would be `ns` for other data
    const writeAPI = influxdb.getWriteApi(config.organization, config.bucket, 'ms')
    writeAPI.useDefaultTags({id: config.id})
    points.forEach(p => writeAPI.writePoint(p))
    return writeAPI.close()
}

// replay cached files one by one - a file is only removed once all its points are confirmed
async function replay (influxdb, config) {
    if (replaying)
        return true
    const files = cache.load(config.cacheDir)
    if (files === false)
        return true
    replaying = true
    log(`Replaying ${files.length} cached file(s) to influx`)
    try {
        for (const file of files) {
            const points = cache.read(file, config.cacheDir).map(revive)
            for (let i = 0; i < points.length; i += BatchSize)
                await write(influxdb, points.slice(i, i + BatchSize), config)
            cache.remove(file, config.cacheDir)
            log(`Replayed ${points.length} cached data point(s) from ${file}`)
        }
        return true
    } catch (err) {
        log(`Replay stopped, cached data kept: ${err.message}`)
        return false
    } finally {
        replaying = false
    }
}

// post points - confirmed points trigger the replay of the cache, failed points are cached
function post (influxdb, metrics, config) {
    if (!Array.isArray(metrics) || metrics.length === 0)
        return Promise.resolve(true)
    const measurements = {}
    metrics.forEach(p => {
        measurements[p.name] = (measurements[p.name] ? measurements[p.name]+1 : 1)
    })
    return write(influxdb, metrics, config)
        .then(() => {
            log(measurements)
            release(metrics)
            return replay(influxdb, config)
        })
        .catch(err => {
            log(`Metrics not written due to ${err.message}`)
            // cache exactly the failed points - other posts may still be in flight
            if (cache.push(metrics, config.cacheDir))
                release(metrics)
            return false
        })
}

function format (path, values, timestamp, skSource) {
    if (values === null){
        return null
    }

    //Set variables for metric
    let point = null

    // Get correct measurement based on path based on path config
    const skPath = path.split('.')

    switch (skPath.length) {
        case 6:
            // extended - use double tagging
            switch (typeof values) {
                case 'string':
                    point = new Point(skPath[4])
                    .tag(skPath[0], skPath[1])
                    .tag(skPath[2], skPath[3])
                    .stringField(skPath[5], values)    
                    break;
                case 'object':
                    point = new Point(skPath[4])
                    .tag(skPath[0], skPath[1])
                    .tag(skPath[2], skPath[3])
                    .stringField(skPath[5], JSON.stringify(values))  
                    break;
                case 'boolean':
                    point = new Point(skPath[4])
                    .tag(skPath[0], skPath[1])
                    .tag(skPath[2], skPath[3])
                    .booleanField(skPath[5], values)
                    break;
                default:
                    if (!isNaN(values))
                        point = new Point(skPath[4])
                        .tag(skPath[0], skPath[1])
                        .tag(skPath[2], skPath[3])
                        .floatField(skPath[5], values)
                    break;
            }
            break;
        case 5:
            // extended - use double tagging
            switch (typeof values) {
                case 'string':
                    point = new Point(skPath[3])
                    .tag(skPath[0], skPath[1])
                    .tag(skPath[1], skPath[2])
                    .stringField(skPath[4], values)    
                    break;
                case 'object':
                    point = new Point(skPath[3])
                    .tag(skPath[0], skPath[1])
                    .tag(skPath[1], skPath[2])
                    .stringField(skPath[4], JSON.stringify(values))  
                    break;
                case 'boolean':
                    point = new Point(skPath[3])
                    .tag(skPath[0], skPath[1])
                    .tag(skPath[1], skPath[2])
                    .booleanField(skPath[4], values)
                    break;
                default:
                    if (!isNaN(values))
                        point = new Point(skPath[3])
                        .tag(skPath[0], skPath[1])
                        .tag(skPath[1], skPath[2])
                        .floatField(skPath[4], values)
                    break;
            }
            break;
        case 4:
            // default
            switch (typeof values) {
                case 'string':
                    point = new Point(skPath[2])
                    .tag(skPath[0], skPath[1])
                    .stringField(skPath[3], values)    
                    break;
                case 'object':
                    point = new Point(skPath[2])
                    .tag(skPath[0], skPath[1])
                    .stringField(skPath[3], JSON.stringify(values))  
                    break;
                case 'boolean':
                    point = new Point(skPath[2])
                    .tag(skPath[0], skPath[1])
                    .booleanField(skPath[3], values)
                    break;
                default:
                    if (!isNaN(values))
                        point = new Point(skPath[2])
                        .tag(skPath[0], skPath[1])
                        .floatField(skPath[3], values)
                    break;
            }
            break;
        case 3:
            // default
            switch (typeof values) {
                case 'string':
                    point = new Point(skPath[2])
                    .tag(skPath[0], skPath[1])
                    .stringField('value', values)    
                    break;
                case 'object':
                    point = new Point(skPath[2])
                    .tag(skPath[0], skPath[1])
                    .stringField('value', JSON.stringify(values))  
                    break;
                case 'boolean':
                    point = new Point(skPath[2])
                    .tag(skPath[0], skPath[1])
                    .booleanField('value', values)
                    break;
                default:
                    if (!isNaN(values))
                        point = new Point(skPath[2])
                        .tag(skPath[0], skPath[1])
                        .floatField('value', values)
                    break;
            }
            break;
        case 2:
            // to be verified
            switch (typeof values) {
                case 'string':
                    point = new Point(skPath[1])
                    .tag(skPath[0], '')
                    .stringField('value', values)    
                    break;
                case 'object':
                    point = new Point(skPath[1])
                    .tag(skPath[0], '')
                    .stringField('value', JSON.stringify(values))  
                    break;
                case 'boolean':
                    point = new Point(skPath[1])
                    .tag(skPath[0], '')
                    .booleanField('value', values)
                    break;
                default:
                    if (!isNaN(values))
                        point = new Point(skPath[1])
                        .tag(skPath[0], '')
                        .floatField('value', values)
                    break;
            }
            break;
        case 1:
        default:
            // invalid
            break;
    }

    // return with timestamp and source tag if available
    if (point===null)
        return null
    if (skSource && skSource!=='')
        point.tag('source', skSource)
    // time of measurement in ms (write precision) - falls back to now for a missing or invalid timestamp
    const millis = timestamp && typeof timestamp.toMillis === 'function' ? timestamp.toMillis() : NaN
    point.timestamp(Number.isFinite(millis) ? millis : DateTime.utc().toMillis())
    return point
}

module.exports = {
    login,      // login to InfluxDB
    health,     // check InfluxDB health
    config,     // create default configuration
    reconfig,   // modify config  record
    match,      // find dynamics path matching actual config path
    check,      // check if config file exists
    save,       // save configuration to file
    buffer,     // keep posted points until confirmed
    flush,      // flush the buffer to cache
    post,       // post to InfluxDB, cache on failure, replay cache on success
    replay,     // replay cached files to InfluxDB
    revive,     // rebuild a cached point
    format      // format measurement before sending
}