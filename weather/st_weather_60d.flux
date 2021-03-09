option v = {timeRangeStart: -1d, timeRangeStop: now(), windowPeriod: 1d}
option task = {name: "st_weather_60d", every: 1d}

from(bucket: "signalk_weather")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "weather"))
	|> filter(fn: (r) =>
		(r["_field"] == "clouds"))
	|> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false)
	|> yield(name: "clouds")
	|> to(bucket: "weather_store", org: "Dev SignalK")
from(bucket: "signalk_weather")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "weather"))
	|> filter(fn: (r) =>
		(r["_field"] == "uvindex"))
	|> aggregateWindow(every: v.windowPeriod, fn: max, createEmpty: false)
	|> yield(name: "uvindex")
	|> to(bucket: "weather_store", org: "Dev SignalK")
from(bucket: "signalk_weather")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "weather"))
	|> filter(fn: (r) =>
		(r["_field"] == "visibility"))
	|> aggregateWindow(every: v.windowPeriod, fn: max, createEmpty: false)
	|> yield(name: "visibility")
	|> to(bucket: "weather_store", org: "Dev SignalK")
from(bucket: "signalk_weather")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "weather"))
	|> filter(fn: (r) =>
		(r["_field"] == "description"))
	|> aggregateWindow(every: v.windowPeriod, fn: last, createEmpty: false)
	|> yield(name: "description")
	|> to(bucket: "weather_store", org: "Dev SignalK")
from(bucket: "signalk_weather")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "weather"))
	|> filter(fn: (r) =>
		(r["_field"] == "icon"))
	|> aggregateWindow(every: v.windowPeriod, fn: last, createEmpty: false)
	|> yield(name: "icon")
	|> to(bucket: "weather_store", org: "Dev SignalK")