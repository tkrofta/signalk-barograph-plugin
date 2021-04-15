const axios = require('axios');

let selfuri=''
let token=''
function init(uri, user, pwd, log) { 
    axios({
        method: 'post',
        url: uri+'/signalk/v1/auth/login',
        headers: { 
          'Content-Type': 'application/json'
        },
        data : {"username":user,"password":pwd}
      }).then( (response) => {
        selfuri = uri
        token = response.data.token;
      })
      .catch( (error) => {
        token = ''
        if (error.response && error.response.status===401)
          log("Unauthorized - review connection string configuration!")
        else
          log(error.response ? error.response : error);
      });
  }
  

let subscriptions = {};
function addSubcription (type, path) {
    subscriptions[type] = path;
}

let influx = {};
function addInflux (key, value) {
    influx[key] = value;
}

function setAppUserData (log) {
  if (token!=='') {
    let data = { subscriptions, influx };
    let config = {
      method: 'post',
      url: selfuri+'/signalk/v1/applicationData/user/signalk_barograph/0.1.0',
      headers: { 
        'Content-Type': 'application/json',
        'Cookie': 'JAUTHENTICATION='+token 
      },
      data : data
    };
    
    axios(config)
    .then( (response) => {
      log('Barograph Config')
      log({ path: subscriptions.pressure, influx: influx.url, config: response.status });
    })
    .catch( (error) => {
      log(error);
    });
  }
  else
    log('Barograph configuration error: invalid or empty token!')
}

module.exports = {
    init,
    addSubcription,
    addInflux,
    setAppUserData
}