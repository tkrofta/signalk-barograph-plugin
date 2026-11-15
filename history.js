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

    Pressure history for the barograph app - queried on the server, so the influx credentials never reach the browser.
    - up to the write retention the write bucket is used (field as written by the plugin),
      beyond it the read bucket (downsampled field 'average') - unless both are the same bucket
    - Influx 2.x (organisation configured): Flux; Influx 1.8 (no organisation): InfluxQL
    - optionally limited to one $source (tag 'source'), eg. the forecasts of one Open-Meteo model
*/

const log = require('debug')('signalk-barograph:history')

const TIMESCALES = [3, 12, 24, 48, 72]      // hours offered by the app
const MAX_HOURS = 72
const POINTS = 720                          // target number of points per timescale
const DOWNSAMPLED = 'average'               // field of the downsampled read bucket
const DOWNSAMPLED_STEP = 300                // seconds - the read bucket holds 5 minute values (downsampling task)

// influx series of a SignalK path - same mapping as influx.format()
function series(path) {
    const s = (path || '').split('.')
    switch (s.length) {
        case 3:
            return { measurement: s[2], tags: { [s[0]]: s[1] }, field: 'value' }
        case 4:
            return { measurement: s[2], tags: { [s[0]]: s[1] }, field: s[3] }
        case 5:
            return { measurement: s[3], tags: { [s[0]]: s[1], [s[1]]: s[2] }, field: s[4] }
        case 6:
            return { measurement: s[4], tags: { [s[0]]: s[1], [s[2]]: s[3] }, field: s[5] }
        default:
            return null
    }
}

// sample window in seconds - one minute up to 12h, scaled to about POINTS points beyond,
// not below the step of the downsampled read bucket
function resolution(hours, downsampled = false) {
    return Math.max(downsampled ? DOWNSAMPLED_STEP : 60, Math.ceil(hours * 3600 / POINTS / 60) * 60)
}

function hoursOf(value) {
    const hours = Number(value)
    if (!Number.isFinite(hours) || hours <= 0)
        return null
    return Math.min(MAX_HOURS, Math.ceil(hours))
}

// bucket and field for a timescale
function source(config, hours, field) {
    const retention = Number(config.retention) || 3
    const downsampled = hours > retention && config.read && config.read !== config.bucket
    return downsampled ? { bucket: config.read, field: DOWNSAMPLED, type: 'read' } : { bucket: config.bucket, field, type: 'write' }
}

// $source as written by the plugin, eg. 'openmeteo-signalk.icon_seamless' or 'n2k.115'
function isSource(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
}

const fluxString = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
const qlIdentifier = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
const qlString = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"

function fluxQuery(config, path, hours, options = {}) {
    const s = series(path)
    const src = source(config, hours, s.field)
    const filters = Object.entries(s.tags).map(([k, v]) => `r["${fluxString(k)}"] == "${fluxString(v)}"`)
    if (config.id)
        filters.push(`r["id"] == "${fluxString(config.id)}"`)
    if (options.source)
        filters.push(`r["source"] == "${fluxString(options.source)}"`)
    return [
        `from(bucket: "${fluxString(src.bucket)}")`,
        `|> range(start: -${hours}h)`,
        `|> filter(fn: (r) => r["_measurement"] == "${fluxString(s.measurement)}" and r["_field"] == "${fluxString(src.field)}")`,
        `|> filter(fn: (r) => ${filters.join(' and ')})`,
        `|> filter(fn: (r) => exists r["source"] and r["source"] != "")`,
        `|> group()`,
        `|> sort(columns: ["_time"])`,
        `|> aggregateWindow(every: ${resolution(hours, src.type === 'read')}s, fn: mean, createEmpty: false)`,
        `|> keep(columns: ["_time", "_value"])`
    ].join(' ')
}

function influxQL(config, path, hours, options = {}) {
    const s = series(path)
    const src = source(config, hours, s.field)
    const [db, rp] = src.bucket.split('/')
    const where = [`time > now() - ${hours}h`]
    Object.entries(s.tags).forEach(([k, v]) => where.push(`${qlIdentifier(k)} = ${qlString(v)}`))
    if (config.id)
        where.push(`"id" = ${qlString(config.id)}`)
    where.push(options.source ? `"source" = ${qlString(options.source)}` : `"source" != ''`)
    return {
        db,
        q: `SELECT mean(${qlIdentifier(src.field)}) FROM ${qlIdentifier(db)}.${rp ? qlIdentifier(rp) : ''}.${qlIdentifier(s.measurement)} ` +
            `WHERE ${where.join(' AND ')} GROUP BY time(${resolution(hours, src.type === 'read')}s) fill(none)`
    }
}

async function queryFlux(influxDB, config, path, hours, options) {
    const rows = await influxDB.getQueryApi(config.organization).collectRows(fluxQuery(config, path, hours, options))
    return rows
        .filter(r => r._value !== null && r._value !== undefined)
        .map(r => [new Date(r._time).getTime(), r._value])
}

async function queryInfluxQL(config, path, hours, fetchFn = fetch, options) {
    const { db, q } = influxQL(config, path, hours, options)
    const url = `${String(config.url).replace(/\/+$/, '')}/query?db=${encodeURIComponent(db)}&epoch=ms&q=${encodeURIComponent(q)}`
    const headers = {}
    if (config.token)
        headers.Authorization = 'Basic ' + Buffer.from(config.token).toString('base64')
    const response = await fetchFn(url, { headers, signal: AbortSignal.timeout(20 * 1000) })
    if (!response.ok)
        throw new Error(`InfluxQL query failed: HTTP ${response.status}`)
    const result = await response.json()
    const first = result && result.results && result.results[0]
    if (first && first.error)
        throw new Error(`InfluxQL query failed: ${first.error}`)
    const values = first && first.series && first.series[0] ? first.series[0].values : []
    return values.filter(v => v[1] !== null).map(v => [v[0], v[1]])
}

// pressure history in Pa - { path, source, hours, resolution, bucket, unit, from, to, data: [[ms, Pa], ...] }
async function query(influxDB, config, path, value, fetchFn, options = {}) {
    const hours = hoursOf(value)
    if (hours === null)
        throw Object.assign(new Error('hours must be a positive number'), { status: 400 })
    if (!series(path))
        throw Object.assign(new Error(`no influx series for path '${path}'`), { status: 404 })
    const v1 = !config.organization
    if (options.source !== undefined && !isSource(options.source))
        throw Object.assign(new Error('invalid source'), { status: 400 })
    const data = v1 ? await queryInfluxQL(config, path, hours, fetchFn, options) : await queryFlux(influxDB, config, path, hours, options)
    const to = Date.now()
    const src = source(config, hours, series(path).field)
    log(`history ${path}${options.source ? ' of ' + options.source : ''} ${hours}h: ${data.length} point(s) via ${v1 ? 'InfluxQL' : 'Flux'}`)
    return {
        path,
        source: options.source || null,
        hours,
        resolution: resolution(hours, src.type === 'read'),
        bucket: src.type,
        unit: 'Pa',
        from: new Date(to - hours * 3600 * 1000).toISOString(),
        to: new Date(to).toISOString(),
        data
    }
}

module.exports = {
    TIMESCALES,
    series,
    resolution,
    isSource,
    fluxQuery,
    influxQL,
    query
}
