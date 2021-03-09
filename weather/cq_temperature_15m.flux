option v = {timeRangeStart: -15m, timeRangeStop: now(), windowPeriod: 15m}
option task = {name: "temperature_15m ", every: 15m}

from(bucket: "signalk_metrics")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "temperature"))
	|> filter(fn: (r) =>
		(r["_field"] == "value"))
	|> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false)
	|> set(key: "_field", value: "average")
	|> yield(name: "average")
	|> to(bucket: "signalk_weather", org: "Dev SignalK")
from(bucket: "signalk_metrics")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "temperature"))
	|> filter(fn: (r) =>
		(r["environment"] != "forecast"))
	|> filter(fn: (r) =>
		(r["_field"] == "value"))
	|> aggregateWindow(every: v.windowPeriod, fn: min, createEmpty: false)
	|> set(key: "_field", value: "minimum")
	|> yield(name: "minimum")
	|> to(bucket: "signalk_weather", org: "Dev SignalK")
from(bucket: "signalk_metrics")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "temperature"))
	|> filter(fn: (r) =>
		(r["environment"] == "forecast"))
	|> filter(fn: (r) =>
		(r["_field"] == "minimum"))
	|> aggregateWindow(every: v.windowPeriod, fn: min, createEmpty: false)
	|> set(key: "_field", value: "minimum")
	|> to(bucket: "signalk_weather", org: "Dev SignalK")
from(bucket: "signalk_metrics")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "temperature"))
	|> filter(fn: (r) =>
		(r["environment"] != "forecast"))
	|> filter(fn: (r) =>
		(r["_field"] == "value"))
	|> aggregateWindow(every: v.windowPeriod, fn: max, createEmpty: false)
	|> set(key: "_field", value: "maximum")
	|> yield(name: "maximum")
	|> to(bucket: "signalk_weather", org: "Dev SignalK")
from(bucket: "signalk_metrics")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "temperature"))
	|> filter(fn: (r) =>
		(r["environment"] == "forecast"))
	|> filter(fn: (r) =>
		(r["_field"] == "maximum"))
	|> aggregateWindow(every: v.windowPeriod, fn: max, createEmpty: false)
	|> set(key: "_field", value: "maximum")
	|> to(bucket: "signalk_weather", org: "Dev SignalK")
from(bucket: "signalk_metrics")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "temperature"))
	|> filter(fn: (r) =>
		(r["environment"] == "forecast"))
	|> filter(fn: (r) =>
		(r["_field"] == "feelslike"))
	|> aggregateWindow(every: v.windowPeriod, fn: max, createEmpty: false)
	|> yield(name: "feelslike")
	|> to(bucket: "signalk_weather", org: "Dev SignalK")
from(bucket: "signalk_metrics")
	|> range(start: v.timeRangeStart, stop: v.timeRangeStop)
	|> filter(fn: (r) =>
		(r["_measurement"] == "temperature"))
	|> filter(fn: (r) =>
		(r["environment"] == "forecast"))
	|> filter(fn: (r) =>
		(r["_field"] == "dewpoint"))
	|> aggregateWindow(every: v.windowPeriod, fn: min, createEmpty: false)
	|> yield(name: "dewpoint")
	|> to(bucket: "signalk_weather", org: "Dev SignalK")