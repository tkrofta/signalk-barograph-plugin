option v = {timeRangeStart: -1h, timeRangeStop: now(), windowPeriod: 60m}
option task = {name: "cq_time_60m ", every: 1h, offset: 6m}

from(bucket: "signalk_metrics")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "time"))
	|> filter(fn: (r) =>
		(r["_field"] == "sunrise"))
	|> aggregateWindow(every: v.windowPeriod, fn: min, createEmpty: false)
	|> yield(name: "sunrise")
	|> to(bucket: "signalk_weather", org: "Dev SignalK")
from(bucket: "signalk_metrics")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "time"))
	|> filter(fn: (r) =>
		(r["_field"] == "sunset"))
	|> aggregateWindow(every: v.windowPeriod, fn: max, createEmpty: false)
	|> yield(name: "sunset")
	|> to(bucket: "signalk_weather", org: "Dev SignalK")