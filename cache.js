/*
    offline cache - shared by the SignalK Barograph, Dashboard & Sealog plugins

    Points that could not be written to influx are stored as '<time>-<seq>.cached.json' in the plugin data directory
    and replayed one file at a time once influx accepts writes again:
    - files are written atomically (temporary file + rename) - a power cut never leaves a partial cache file
    - a file is removed only after its points are confirmed written (see influx.js replay)
    - unreadable files are removed - they only hold a single batch (one write interval)
    - the cache is bounded by size and age, the oldest files are pruned first
    - the directory is scanned once, then tracked in memory - usage() is cheap enough for every write interval
*/
const fs = require('fs')
const path = require('path')
const REQUEUED = '.cached.json'
const TEMPORARY = '.tmp'
const MAX_BYTES = 100 * 1024 * 1024         // 100 MB
const MAX_AGE = 30 * 24 * 60 * 60 * 1000    // 30 days
const WARNING = 0.5                         // usage() warns from half of either limit
const log = require('debug')('signalk-barograph:cache')

let sequence = 0
const tracked = new Map()   // cacheDir -> { files: Map(name -> bytes) oldest first, bytes, pruned }

function cachePath (cacheDir, file) {
	return path.join(cacheDir, file)
}

function isCacheFile (file) {
	return typeof file === 'string' && file.endsWith(REQUEUED)
}

// creation time in ms - encoded at the start of the file name
function createdAt (file) {
	return parseInt(file, 10)
}

function size (cacheDir, file) {
	try { return fs.statSync(cachePath(cacheDir, file)).size } catch { return 0 }
}

// cache files of a directory - scanned once, then kept up to date by push and remove
function scan (cacheDir) {
	let entry = tracked.get(cacheDir)
	if (entry)
		return entry
	entry = { files: new Map(), bytes: 0, pruned: 0 }
	let files = []
	try {
		files = fs.readdirSync(cacheDir).filter(isCacheFile)
	} catch (err) {
		log(`Cannot read cache directory '${cacheDir}': ${err.message}`)
		return entry
	}
	files.sort((a, b) => createdAt(a) - createdAt(b) || a.localeCompare(b))
	for (const file of files) {
		const bytes = size(cacheDir, file)
		entry.files.set(file, bytes)
		entry.bytes += bytes
	}
	tracked.set(cacheDir, entry)
	return entry
}

function remove (file, cacheDir) {
	const entry = tracked.get(cacheDir)
	if (entry && entry.files.has(file)) {
		entry.bytes -= entry.files.get(file)
		entry.files.delete(file)
		// all caught up - a past pruning is no longer a reason to warn
		if (entry.files.size === 0)
			entry.pruned = 0
	}
	try {
		fs.unlinkSync(cachePath(cacheDir, file))
		return true
	} catch (err) {
		if (err.code !== 'ENOENT')
			log(`Cannot remove ${file}: ${err.message}`)
		return false
	}
}

function prune (cacheDir, limits = {}) {
	if (!cacheDir || !fs.existsSync(cacheDir))
		return 0
	const maxBytes = limits.maxBytes !== undefined ? limits.maxBytes : MAX_BYTES
	const maxAge = limits.maxAge !== undefined ? limits.maxAge : MAX_AGE
	const entry = scan(cacheDir)
	const now = Date.now()
	let removed = 0
	for (const file of [...entry.files.keys()]) {
		if (now - createdAt(file) <= maxAge && entry.bytes <= maxBytes)
			break
		remove(file, cacheDir)
		removed++
	}
	if (removed > 0) {
		entry.pruned += removed
		log(`Pruned ${removed} cache file(s) exceeding ${Math.round(maxBytes / 1024 / 1024)} MB or ${Math.round(maxAge / 86400000)} days`)
	}
	return removed
}

function push (input, cacheDir, limits) {
	// nothing to cache
	if (!Array.isArray(input) || input.length === 0)
		return false
	// never fall back to the filesystem root when no cache directory is configured
	if (!cacheDir || !fs.existsSync(cacheDir)) {
		log(`Cannot cache ${input.length} data point(s): invalid cache directory '${cacheDir}'`)
		return false
	}
	const entry = scan(cacheDir)
	// store content to file - atomically, a partial file is never picked up
	const fileName = `${Date.now()}-${sequence++ % 1000}${REQUEUED}`
	const target = cachePath(cacheDir, fileName)
	const content = JSON.stringify(input)
	try {
		fs.writeFileSync(target + TEMPORARY, content)
		fs.renameSync(target + TEMPORARY, target)
	} catch (err) {
		log(`Cannot cache ${input.length} data point(s): ${err.message}`)
		try { fs.unlinkSync(target + TEMPORARY) } catch { /* not written */ }
		return false
	}
	const bytes = Buffer.byteLength(content)
	entry.files.set(fileName, bytes)
	entry.bytes += bytes
	log(`Caching ${input.length} data point(s) to ${fileName}`)
	prune(cacheDir, limits)
	return true
}

// cached file names, oldest first - false if there are none
function load (cacheDir) {
	if (!cacheDir || !fs.existsSync(cacheDir)) {
		log(`Invalid cache directory '${cacheDir}'`)
		return false
	}
	const files = [...scan(cacheDir).files.keys()]
	return files.length === 0 ? false : files
}

// content of a single cache file - an unreadable file is removed and returns no points
function read (file, cacheDir) {
	try {
		const content = JSON.parse(fs.readFileSync(cachePath(cacheDir, file), 'utf8'))
		if (Array.isArray(content))
			return content
		log(`Removing ${file}: unexpected content`)
	} catch (err) {
		if (err.code === 'ENOENT') {
			remove(file, cacheDir)
			return []
		}
		log(`Removing ${file}: ${err.message}`)
	}
	remove(file, cacheDir)
	return []
}

// all cached points at once, files are removed - kept for compatibility, influx.js replays file by file
function send (filenames, cacheDir) {
	const input = []
	for (const file of filenames || []) {
		if (isCacheFile(file)) {
			input.push(...read(file, cacheDir))
			remove(file, cacheDir)
		}
	}
	return input
}

// cache usage for the plugin status: warning from half of either limit or once data had to be pruned
function usage (cacheDir, limits = {}) {
	const maxBytes = limits.maxBytes !== undefined ? limits.maxBytes : MAX_BYTES
	const maxAge = limits.maxAge !== undefined ? limits.maxAge : MAX_AGE
	if (!cacheDir || !fs.existsSync(cacheDir))
		return { files: 0, bytes: 0, oldest: null, pruned: 0, warning: false, message: '' }
	const entry = scan(cacheDir)
	const first = entry.files.keys().next().value
	const oldest = first !== undefined ? createdAt(first) : null
	const age = oldest !== null ? Date.now() - oldest : 0
	const warning = entry.pruned > 0 || entry.bytes >= WARNING * maxBytes || age >= WARNING * maxAge
	const mb = (entry.bytes / 1024 / 1024).toFixed(1)
	let message = ''
	if (entry.files.size > 0) {
		message = `${entry.files.size} file(s), ${mb} of ${Math.round(maxBytes / 1024 / 1024)} MB cached since ${new Date(oldest).toISOString().slice(0, 16).replace('T', ' ')} UTC`
		if (entry.pruned > 0)
			message += ` - ${entry.pruned} oldest file(s) dropped`
	}
	return { files: entry.files.size, bytes: entry.bytes, oldest, pruned: entry.pruned, warning, message }
}

module.exports = {
	push,       // cache points to a new file
	load,       // list cache files, oldest first
	read,       // read the points of one file
	remove,     // remove one file
	prune,      // enforce size and age limits
	send,       // read and remove all files
	usage       // cache usage and warning for the plugin status
}
