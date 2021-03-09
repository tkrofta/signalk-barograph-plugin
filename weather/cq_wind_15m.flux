option v = {timeRangeStart: -15m, timeRangeStop: now(), windowPeriod: 15m}
option task = {name: "wind_15m", every: 15m}

from(bucket: "signalk_metrics")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "wind"))
	|> filter(fn: (r) =>
		(r["_field"] == "speed"))
	|> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false)
	|> yield(name: "speed")
	|> to(bucket: "signalk_weather", org: "Dev SignalK")
from(bucket: "signalk_metrics")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "wind"))
	|> filter(fn: (r) =>
		(r["_field"] == "speed"))
	|> aggregateWindow(every: v.windowPeriod, fn: min, createEmpty: false)
	|> yield(name: "minimum")
	|> to(bucket: "signalk_weather", org: "Dev SignalK")
from(bucket: "signalk_metrics")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "wind"))
	|> filter(fn: (r) =>
		(r["_field"] == "speed"))
	|> aggregateWindow(every: v.windowPeriod, fn: max, createEmpty: false)
	|> yield(name: "maximum")
	|> to(bucket: "signalk_weather", org: "Dev SignalK")
from(bucket: "signalk_metrics")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "wind"))
	|> filter(fn: (r) =>
		(r["_field"] == "direction"))
	|> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false)
	|> yield(name: "direction")
	|> to(bucket: "signalk_weather", org: "Dev SignalK")