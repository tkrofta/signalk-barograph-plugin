const {InfluxDB} = require('@influxdata/influxdb-client')
const {HealthAPI} = require('@influxdata/influxdb-client-apis')
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
    influxdb.write(
        {
            org: config.organization,         // [Required] Organization | Empty for 1.8.x
            bucket: config.bucket,            // [Required] Bucket | Database/Retention Policy
            precision: 'ms'                    // Precision of timestamp. [`ns`, `us`, `ms`, `s`]. The default would be `ns` for other data
        },
        metrics,
    )
    .then(resp => {
        log(resp + 'successfully uploaded')
        cacheResult = cache.load(config.cacheDir, log) 
        if (cacheResult === false) {
            return
        }
        else {      
            log('Cache files to be loaded to influx')
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
            log(`${cacheResult.length} files still cached`)
        }
    })
    // log(JSON.stringify(metrics))
}

function format (path, values, skTimestamp, config) {
    if (values === null){
        values = 0
    }

    //Set variables for metric
    let metric = null
    let measurement = ''
    let tags = {
        id: config.id
    }
    let fields = {}
    let timestamp = Date.parse(skTimestamp)

    // Get correct measurement based on path based on path config
    const skPath = path.split('.')

    switch (skPath.length) {
        case 4:
            // default
            measurement = skPath[2]
            tags = JSON.parse(JSON.stringify(tags).replace('}', ',') + '"' + skPath[0] + '":"' + skPath[1] + '"}')
            fields[skPath[3]] = values
            break;
        case 3:
            // default
            measurement = skPath[2]
            tags = JSON.parse(JSON.stringify(tags).replace('}', ',') + '"' + skPath[0] + '":"' + skPath[1] + '"}')
            fields.value = values
            break;
        case 2:
            // to be verified
            measurement = skPath[1]
            tags = JSON.parse(JSON.stringify(tags).replace('}', ',') + '"' + skPath[0] + '":""}')
            fields.value = values
            break;
        case 1:
        default:
            // invalid
            fields = null
            break;
    }
   
    if (measurement!=='' && tags && fields && timestamp)
        metric = { measurement, tags, fields, timestamp }
    return metric
}

module.exports = {
    cacheBuffer,
    login,      // login to InfluxDB
    health,     // check InfluxDB health
    config,     // create default configuration
    post,       // post to InfluxDB
    format      // format measurement before sending
}