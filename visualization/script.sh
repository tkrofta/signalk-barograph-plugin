curl -XPOST localhost:8086/api/v2/query -sS \
  -H 'Accept:application/csv' \
  -H 'Content-type:application/vnd.flux' \
  -d 'from(bucket:"signalk_metrics")
        |> range(start:-5m)
        |> filter(fn:(r) => r._measurement == "cpu")'