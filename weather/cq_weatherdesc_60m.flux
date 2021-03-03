option v = {timeRangeStart: -1h, timeRangeStop: now(), windowPeriod: 60m}
option task = {name: "cq_weatherdesc_60m", every: 1h, offset: 6m}

from(bucket: "signalk_metrics")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "description"))
	|> filter(fn: (r) =>
		(r["_field"] == "value"))
	|> aggregateWindow(every: v.windowPeriod, fn: last, createEmpty: false)
	|> set(key: "_measurement", value: "weather")
	|> set(key: "_field", value: "description")
	|> yield(name: "last")
	|> to(bucket: "signalk_weather", org: "Dev SignalK")
from(bucket: "signalk_metrics")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "weather"))
	|> filter(fn: (r) =>
		(r["_field"] == "icon"))
	|> aggregateWindow(every: v.windowPeriod, fn: first, createEmpty: false)
	|> yield(name: "icon")
	|> to(bucket: "signalk_weather", org: "Dev SignalK")