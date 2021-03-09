option v = {timeRangeStart: -1d, timeRangeStop: now(), windowPeriod: 1d}
option task = {name: "st_time_60d", every: 1d}

from(bucket: "signalk_weather")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "time"))
	|> filter(fn: (r) =>
		(r["_field"] == "sunset"))
	|> aggregateWindow(every: v.windowPeriod, fn: max, createEmpty: false)
	|> yield(name: "sunset")
	|> to(bucket: "weather_store", org: "Dev SignalK")
from(bucket: "signalk_weather")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "time"))
	|> filter(fn: (r) =>
		(r["_field"] == "sunrise"))
	|> aggregateWindow(every: v.windowPeriod, fn: min, createEmpty: false)
	|> yield(name: "sunrise")
	|> to(bucket: "weather_store", org: "Dev SignalK")