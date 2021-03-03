option v = {timeRangeStart: -15m, timeRangeStop: now(), windowPeriod: 15m}
option task = {name: "cq_wind_15m", every: 15m}

from(bucket: "signalk_metrics")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "wind"))
	|> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false)
	|> yield(name: "mean")
	|> to(bucket: "signalk_weather", org: "Dev SignalK")