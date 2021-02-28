const {InfluxDB, Point, HttpError} = require('@influxdata/influxdb-client')
const {HealthAPI} = require('@influxdata/influxdb-client-apis')
const { LOADIPHLPAPI } = require('dns')
const cache = require('./cache')

let cacheBuffer

function login(clientOptions, log) {
    try {
        const influxDB = new InfluxDB(clientOptions)

        log ("Influx Login successful")
        return influxDB
    } catch (err) {
        log ("Error logging into influx: "+err)         
    }
}

async function health (influxDB, log, callback) {
    log("Determining influx health")
    const healthAPI = new HealthAPI(influxDB)
    
    await healthAPI
    .getHealth()
    .then((result /* : HealthCheck */) => {
        log('Influx healthCheck: ' + (result.status === 'pass' ? 'OK' : 'NOT OK'))
        return callback(influxDB, result) 
   })
    .catch(error => {
        log("HealthCheck Error: "+error)
        return false
    })
}

function config(root, interval) {
    if (interval<1000) interval = 1000
    switch (root) {
        case 'environment':
                return [
                    { path: 'environment.forecast.time', period: interval, policy: "instant", minPeriod: interval },
                    { path: 'environment.inside.temperature', period: 60*interval, policy: "instant", minPeriod: interval },
                    { path: 'environment.outside.temperature', period: 60*interval, policy: "instant", minPeriod: interval },
                    { path: 'environment.water.temperature', period: 60*interval, policy: "instant", minPeriod: interval },
                    { path: 'environment.forecast.temperature', period: 60*interval, policy: "instant", minPeriod: interval },
                    { path: 'environment.forecast.temperature.minimum', period: 60*interval, policy: "instant", minPeriod: interval },
                    { path: 'environment.forecast.temperature.maximum', period: 60*interval, policy: "instant", minPeriod: interval },
                    { path: 'environment.forecast.temperature.feelslike', period: 60*interval, policy: "instant", minPeriod: interval },
                    { path: 'environment.inside.pressure', period: 60*interval, policy: "instant", minPeriod: interval },
                    { path: 'environment.outside.pressure', period: 60*interval, policy: "instant", minPeriod: interval },
                    { path: 'environment.forecast.pressure', period: 60*interval, policy: "instant", minPeriod: interval },
                    { path: 'environment.inside.humidity', period: 60*interval, policy: "instant", minPeriod: interval },
                    { path: 'environment.outside.humidity', period: 60*interval, policy: "instant", minPeriod: interval },
                    { path: 'environment.forecast.humidity', period: 60*interval, policy: "instant", minPeriod: interval }
                ];
        default:        
            return [] 
    }
}

function post (influxdb, metrics, config, log) {
    // [Required] Organization | Empty for 1.8.x
    // [Required] Bucket | Database/Retention Policy
    // Precision of timestamp. [`ns`, `us`, `ms`, `s`]. The default would be `ns` for other data
    const writeAPI = influxdb.getWriteApi(config.organization, config.bucket, 'ms')
    // TODO: setup default tags for all writes through this API
    writeAPI.useDefaultTags({id: config.id})
    
    // write point with the appropriate (client-side) timestamp
    for (i=0; i<metrics.length; i++)
    {
        writeAPI.writePoint(metrics[i])
        log(`${i+1}: ${metrics[i].toLineProtocol(writeAPI)}`)
    }
    writeAPI
        .close()
        .then(() => {
            log('Loaded successfully')
            cacheResult = cache.load(config.cacheDir, log) 
            if (cacheResult === false) {
                return
            }
            else {      
                log('Cache file(s) to be loaded to influx')
                log(JSON.stringify(cacheResult))
                post(influxdb, cache.send(cacheResult, config.cacheDir), config, log)
            }
        })
        .catch(err => {
            // Handle errors
            cache.push(cacheBuffer, config.cacheDir)
            cacheBuffer = []
            log(`Caching metrics because ${err.message}`);
            const cacheResult = cache.load(config.cacheDir, log)
            if (cacheResult !== false) {
                log(`${cacheResult.length} files cached`)
            }
    })
    // log(JSON.stringify(metrics))
}

function format (path, values, skTimestamp, log) {
    if (values === null){
        values = 0
    }

    //Set variables for metric
    let point = null
    let timestamp = Date.parse(skTimestamp)

    // Get correct measurement based on path based on path config
    const skPath = path.split('.')

    switch (skPath.length) {
        case 4:
            // default
            if (typeof values==='string')
                point = new Point(skPath[2])
                    .tag(skPath[0], skPath[1])
                    .stringField(skPath[3], values)
            else
                point = new Point(skPath[2])
                    .tag(skPath[0], skPath[1])
                    .floatField(skPath[3], values)
            break;
        case 3:
            // default
            if (typeof values==='string')
                point = new Point(skPath[2])
                    .tag(skPath[0], skPath[1])
                    .stringField('value', values)
            else
                point = new Point(skPath[2])
                    .tag(skPath[0], skPath[1])
                    .floatField('value', values)
            break;
        case 2:
            // to be verified
            if (typeof values==='string')
                point = new Point(skPath[1])
                    .tag(skPath[0], '')
                    .stringField('value', values)
            else
                point = new Point(skPath[1])
                    .tag(skPath[0], '')
                    .floatField('value', values)
            break;
        case 1:
        default:
            // invalid
            fields = null
            break;
    }
   
    point.timestamp = (timestamp ? timestamp : Date.now())
    // log(point)
    return point
}

module.exports = {
    cacheBuffer,
    login,      // login to InfluxDB
    health,     // check InfluxDB health
    config,     // create default configuration
    post,       // post to InfluxDB
    format      // format measurement before sending
}