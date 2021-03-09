option v = {timeRangeStart: -1h, timeRangeStop: now(), windowPeriod: 1h}
option task = {name: "st_temperature_60d", every: 1h}

from(bucket: "signalk_weather")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "temperature"))
	|> filter(fn: (r) =>
		(r["_field"] == "average"))
	|> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false)
	|> yield(name: "average")
	|> to(bucket: "weather_store", org: "Dev SignalK")
from(bucket: "signalk_weather")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "temperature"))
	|> filter(fn: (r) =>
		(r["_field"] == "minimum"))
	|> aggregateWindow(every: v.windowPeriod, fn: min, createEmpty: false)
	|> yield(name: "minimum")
	|> to(bucket: "weather_store", org: "Dev SignalK")
from(bucket: "signalk_weather")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "temperature"))
	|> filter(fn: (r) =>
		(r["_field"] == "maximum"))
	|> aggregateWindow(every: v.windowPeriod, fn: max, createEmpty: false)
	|> yield(name: "maximum")
	|> to(bucket: "weather_store", org: "Dev SignalK")
from(bucket: "signalk_weather")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "temperature"))
	|> filter(fn: (r) =>
		(r["_field"] == "feelslike"))
	|> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false)
	|> yield(name: "feelslike")
	|> to(bucket: "weather_store", org: "Dev SignalK")
from(bucket: "signalk_weather")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "temperature"))
	|> filter(fn: (r) =>
		(r["_field"] == "dewpoint"))
	|> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false)
	|> yield(name: "dewpoint")
	|> to(bucket: "weather_store", org: "Dev SignalK")