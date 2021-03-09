option v = {timeRangeStart: -24h, timeRangeStop: now(), windowPeriod: 1d}
option task = {name: "lt_maindata_20y", every: 1d}

from(bucket: "weather_store")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "humidity"))
	|> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false)
	|> to(bucket: "weather_archive", org: "Dev SignalK")
from(bucket: "weather_store")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "pressure"))
	|> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false)
	|> to(bucket: "weather_archive", org: "Dev SignalK")
from(bucket: "weather_store")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "temperature"))
	|> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false)
	|> to(bucket: "weather_archive", org: "Dev SignalK")
from(bucket: "weather_store")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "wind"))
	|> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false)
	|> to(bucket: "weather_archive", org: "Dev SignalK")
from(bucket: "weather_store")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "time"))
	|> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false)
	|> to(bucket: "weather_archive", org: "Dev SignalK")