option v = {timeRangeStart: -1h, timeRangeStop: now(), windowPeriod: 60m}
option task = {name: "cq_weather_60m", every: 1h, offset: 6m}

from(bucket: "signalk_metrics")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "weather"))
	|> filter(fn: (r) =>
		(r["_field"] == "clouds"))
	|> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false)
	|> yield(name: "clouds")
	|> to(bucket: "signalk_weather", org: "Dev SignalK")
from(bucket: "signalk_metrics")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "weather"))
	|> filter(fn: (r) =>
		(r["_field"] == "uvindex"))
	|> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false)
	|> yield(name: "uvindex")
	|> to(bucket: "signalk_weather", org: "Dev SignalK")
from(bucket: "signalk_metrics")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "weather"))
	|> filter(fn: (r) =>
		(r["_field"] == "visibility"))
	|> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false)
	|> yield(name: "visibility")
	|> to(bucket: "signalk_weather", org: "Dev SignalK")