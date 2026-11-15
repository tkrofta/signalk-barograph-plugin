# InfluxDB samples

Development samples only - InfluxDB v2, not part of the npm package and not required by the plugin.

- `pressure_5m.json` - task export of the development setup (every 5 minutes), from the
  write bucket `signalk_metrics` (field `value`) into the read bucket `signalk_data`:
  - measured pressure: 5 minute `average`, `minimum` and `maximum`
  - forecast pressure (`environment` = `forecast`, written at its valid time): 5 minute
    means of the last hour as field `forecast`

  Tags (incl. `source` and `id`) are kept. Beyond the write retention the barograph
  reads the field `average` - for the past forecasts in the read bucket the forecast
  block has to write `average` as well (the `environment` tag keeps the series apart).

  Bucket names, organisation and the `writeToken` secret are those of the dev server -
  adapt them before importing the task elsewhere.
