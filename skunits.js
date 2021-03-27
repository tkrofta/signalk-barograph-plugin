/*
    conversions-module - specifically for SignalK & Barograph
    reqired for OpenWeather Map | Squid Sailing Forecasting modules
*/

// returns Pressure at Station based on Pressure at SeaLevel, Elevation (m) and Temperature (K) at Station 
function toStationAltitude (pressure, elevation, temperature) {
    return pressure * Math.exp(-elevation / (temperature*29.263));
}

// returns Pressure at SeaLevel based on Pressure at Station, Elevation (m) and Temperature (K) at Station 
function toSeaLevel (pressure, elevation, temperature) {
    return pressure / Math.exp(-elevation / (temperature*29.263));
}

// converts to SignalK-Units
function toSignalK(units, value) {
    let skUnits
    if ( units === '%' ) {
        value = value / 100
        skUnits = 'ratio'
    } else if ( units === '°C' || units === 'deg' ) {
        value = value + 273.15
        skUnits = 'K'
    } else if ( units === '°F' ) {
        value = (value - 32) * (5/9) + 273.15
        skUnits = 'K'    
    } else if ( units === 'kmh' ) {
        value = value / 3.6
        skUnits = "m/s"
    } else if ( units === '°' ) {
        value = value * (Math.PI/180.0)
        skUnits = 'rad'
    } else if ( units === 'Pa' ) {
        skUnits = "Pa"
    } else if ( units === 'hPa' || units=== 'mbar' ) {
        value = value / 100
        skUnits = "Pa"
    } else if ( units === 'km' ) {
        value = value * 1000
        skUnits = "m"
    } else if ( units === 'nm' ) {
        value = value * 1852
        skUnits = "m"
    } else if ( units === 'm' ) {
        skUnits = "m"
    }
    return { value: value, units: skUnits }
}

// converts from SignalK-Units
function toTarget(skunit, value, target, precision) {
    let unit
    if ( skunit === 'ratio' && target===undefined ) {
        value = value * 100
        unit = ''
    } else if ( skunit === 'ratio' && ( target==='decimal' || target==='number' ) ) {
        unit = ''
    } else if ( skunit === 'K' && (target===undefined) ) {
        value = value
        unit = 'K'
    } else if ( skunit === 'K' && (target==="°C" || target==="deg") ) {
        value = value - 273.15
        unit = target
    } else if ( skunit === 'K' && (target==='°F') ) {
        value = (value - 273.15) * (9/5) + 32
        unit = target
    } else if ( skunit === 'm/s' && (target==='undefined') ) {
        unit = "m/s"
    } else if ( skunit === 'm/s' && (target==='kn') ) {
        value = value * 1.943844
        unit = target
    } else if ( skunit === 'm/s' && (target==='km') ) {
        value = value * 3.6
        unit = target
    } else if ( skunit ==='rad' && (target === '°' || target==='') ) {
        value = value * (180.0/Math.PI)
        unit = '°'
    } else if ( skunit === 'Pa' && (target===undefined) ) {
        unit = 'Pa'
    } else if ( skunit === 'Pa' && (target==='hPa' || units==='mbar' ) ) {
        value = value / 100
        unit = target
    } else if ( skunit === 'Pa' && (target ==='atm') ) {
        value = value / 101325
        unit = target        
    } else if ( skunit === 'm' && target === undefined ) {
        unit = 'm'
    } else if ( skunit === 'm' && target === 'km' ) {
        value = value / 1000
        unit = 'km'
    } else if ( skunit === 'm' && target === 'nm' ) {
        value = value / 1852
        unit ='nm' 
    } else {
        unit = skunit
    }
    return { value: value, units: unit }
}

module.exports = {
    toSeaLevel,
    toStationAltitude,
    toSignalK,
    toTarget
}     