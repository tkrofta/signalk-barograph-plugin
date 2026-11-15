# Change Log

## [1.0.0]
Public Release

### Fix
- InfluxDB points carry the time of measurement - they were stamped with the upload time, readings of the same series within a millisecond overwrote each other.
- Offline cache: replayed points keep all tags (incl. `source`) and their field type; cache files are removed only after influx confirmed the write, written atomically, unreadable files are removed, the cache is limited to 100 MB / 30 days.
- An unreachable InfluxDB is reported as plugin error with its reason; barometer predictions continue without it.
- The path configuration file is re-read on every plugin (re)start.
- `environment.barometer.wind.minimum` / `maximum` are published in m/s - they carried Beaufort numbers; an unknown wind force no longer drops the whole prediction update.
- Stopping the plugin before the InfluxDB health check completed no longer leaves a running subscription.

### Feature
- Pending offline cache files are shown on the plugin state; from half of the size or age limit, or once data had to be dropped, the state turns into an error.
- Predictions use at most one pressure reading per minute, independent of the subscription period.
- The pressure history of the last 48 h is saved on plugin stop and restored on start - predictions are available right after a restart.
- skunits update: missing values stay missing instead of 0, Beaufort conversions, additional units.
- Logging via the `signalk-barograph` debug log.
