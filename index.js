/*
* Copyright 2017 Scott Bender <scott@scottbender.net>
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*     http://www.apache.org/licenses/LICENSE-2.0

* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.

Typical API call:
http://services.marinetraffic.com/api/exportvessels/v:8/YOUR-API-KEY/timespan:#minutes/protocol:value

Read more at https://www.marinetraffic.com/en/ais-api-services/documentation/api-service:ps02/_:980110f21241cd398d04aaf0e9b2b4a3#fAPvtWjUcPLIYFQs.99
*/

const http = require('http')
const debug = require('debug')('signalk-marinetraffic-api')
const util = require('util')
const Promise = require('bluebird')
const agent = require('superagent-promise')(require('superagent'), Promise)
const fs = require("fs");
const _ = require('lodash')
const schema = require('@signalk/signalk-schema')

const stateMapping = {
  0: 'motoring',
  1: 'anchored',
  2: 'not under command',
  3: 'restricted manouverability',
  4: 'constrained by draft',
  5: 'moored',
  6: 'aground',
  7: 'fishing',
  8: 'sailing',
  9: 'hazardous material high speed',
  10: 'hazardous material wing in ground',
  14: 'ais-sart',
  15: undefined
}

module.exports = function(app)
{
  var plugin = {};
  var timeout = undefined
  let selfContext = 'vessels.' + app.selfId

  plugin.id = "signalk-marinetraffic-api"
  plugin.name = "Marinetraffic API"
  plugin.description = plugin.name

  plugin.schema = {
    type: "object",
    required: [
      "apikey"
    ],
    properties: {
      apikey: {
        type: "string",
        title: "API Key"
      },
      updaterate: {
        type: "number",
        title: "Rate to get updates from Marinetraffic(s > 120 or according to subscription)",
        default: 86400
      }
    }
  }

  function marineTrafficToDeltas(response)
  {
    var hub = JSON.parse(response)
    debug("response: " + JSON.stringify(hub))
    var status = hub
    if ( status.errors )
    {

      console.error("error response from Marinetraffic: " + JSON.stringify(status.errors[0].detail))
      return
    }

    hub.forEach(vessel => {
      debug(JSON.stringify(vessel))
      var delta = getVesselDelta(vessel)

      if ( delta == null ) {
        return
      }

      debug("vessel: " + JSON.stringify(delta))
      app.handleMessage(plugin.id, delta)
    })
  }

  plugin.start = function(options)
  {
    var update = function()
    {
      var test = `[{"MMSI":"304010417","IMO":"9015462","SHIP_ID":"359396","LAT":"47.758499","LON":"-5.154223","SPEED":"74","HEADING":"329","COURSE":"327","STATUS":"0","TIMESTAMP":"2017-05-19T09:39:57","DSRC":"TER","UTC_SECONDS":"54"},
      {"MMSI":"215819000","IMO":"9034731","SHIP_ID":"150559","LAT":"47.926899","LON":"-5.531450","SPEED":"122","HEADING":"162","COURSE":"157","STATUS":"0","TIMESTAMP":"2017-05-19T09:44:27","DSRC":"TER","UTC_SECONDS":"28"},
      {"MMSI":"255925000","IMO":"9184433","SHIP_ID":"300518","LAT":"47.942631","LON":"-5.116510","SPEED":"79","HEADING":"316","COURSE":"311","STATUS":"0","TIMESTAMP":"2017-05-19T09:43:53","DSRC":"TER","UTC_SECONDS":"52"}]`
      marineTrafficToDeltas(test)

      var url = "http://services.marinetraffic.com/api/exportvessels/v:8/" + options.apikey + "/timespan:10/protocol:jsono"
      debug("url: " + url)

      agent('GET', url).end().then(function(response) {
        marineTrafficToDeltas(response.text)
      })

    }

    var rate = options.updaterate

    if ( !rate || rate <=120 )
    rate = 121
    //rate = 1
    update()
    timeout = setInterval(update, rate * 1000)
  }

  plugin.stop = function()
  {
    if ( timeout ) {
      clearInterval(timeout)
      timeout = undefined
    }
  }

  return plugin
}

function degsToRadC(vessel, degrees) {
  return degrees * (Math.PI/180.0);
}

function degsToRad(degrees) {
  return degrees * (Math.PI/180.0);
}

function radsToDeg(radians) {
  return radians * 180 / Math.PI
}

function addValue(delta, path, value)
{
  if ( typeof value !== 'undefined' )
  {
    delta.updates[0].values.push({path: path, value: value})
  }
}

function convertTime(vessel, val)
{
  return val + "Z"
  //var tparts = val.split(' ')
  //return tparts[0] + "T" + tparts[1] + "Z"
}

function numberToString(vessel, num)
{
  return '' + num
}

const mappings = [
  {
    path: "mmsi",
    key: "MMSI",
    root: true,
    conversion: numberToString
  },
  {
    path: "name",
    key: "SHIPNAME",
    root: true
  },
  {
    path: "callsign",
    key: "CALLSIGN",
    root: true
  },
  {
    path: "imo",
    key: "IMO",
    root: true,
    conversion: numberToString
  },
  {
    path: "navigation.courseOverGroundTrue",
    key: "COURSE",
    conversion: function(vessel, val) {
      if ( val == 360 )
      return null;
      return degsToRadC(vessel, val)
    }
  },
  {
    path: "navigation.headingTrue",
    key: "HEADING",
    conversion: function(vessel, val) {
      if ( val == 511 )
      return null;
      return degsToRadC(vessel, val);
    }
  },
  {
    path: "navigation.destination.commonName",
    key: "DESTINATION"
  },
  {
    path: "sensors.ais.fromBow",
    key: 'A',
    conversion: function(vessel, val) {
      var length = vessel.A + vessel.B
      if ( length == 0 )
      return null
      return val
    }
  },
  {
    path: "sensors.ais.fromCenter",
    key: 'C',
    conversion: function(vessel, to_port) {
      var to_starboard = vessel.D
      var to_port = vessel.C
      var width = to_port + to_starboard

      if ( width == 0 )
      return null

      if ( to_starboard > (width/2) )
      {
        return (to_starboard - (width/2)) * -1;
      }
      else
      {
        return (width/2) - to_starboard;
      }
    }
  },
  {
    path: "design.length",
    key: "A",
    conversion: function(vessel, to_bow) {
      var to_stern = vessel.B
      var length = to_stern + to_bow
      if ( length == 0 )
      return null
      return { overall: length }
    }
  },
  {
    path: "design.beam",
    key: "C",
    conversion: function(vessel, to_port) {
      var to_starboard = vessel.D
      var beam = to_port + to_starboard
      if ( beam == 0 )
      return null
      return beam
    }
  },
  {
    path: "design.draft",
    key: "DRAUGHT",
    conversion: function(vessel, val) {
      if ( val == 0 )
      return null
      return { maximum: val / 10}
    }
  },
  {
    path: 'navigation.position',
    key: "LAT",
    conversion: function(vessel, val) {
      return { latitude: val, longitude:vessel.LON }
    }
  },
  {
    path: "navigation.speedOverGround",
    key: "SPEED",
    conversion: function(vessel, val) {
      return val / 10 *0.514444
    }
  },
  {
    path: "design.aisShipType",
    key: "SHIPTYPE",
    conversion: function(vessel, val) {
      const name = schema.getAISShipTypeName(val)
      if ( name ) {
        return { id: val, 'name': name }
      } else {
        return null
      }
    }
  },
  {
    path: "navigation.state",
    key: "STATUS",
    conversion: function(vessel, val) {
      var res = stateMapping[val]
      return res ? res : undefined
    }
  },
  {
    path: "navigation.courseGreatCircle.activeRoute.estimatedTimeOfArrival",
    key: "ETA",//How to distinguish between reported and MT calculated ETA?
    //"ETA_CALC"?"ETA_CALC":"ETA"
    conversion: convertTime
  },/*
  {
    path: "navigation.courseGreatCircle.activeRoute.distanceToGo",//Not in spec yet
    key: "DISTANCE_TO_GO",
    conversion: function(vessel, val) {
      return val / 1852
    }
  },*/
  {
    path: "navigation.logTrip",
    key: "DISTANCE_TRAVELLED",
    conversion: function(vessel, val) {
      return val / 1852
    }
  }
]

function getVesselDelta(vessel)
{
  var delta = {
    "context": "vessels.urn:mrn:imo:mmsi:" + vessel.MMSI,
    "updates": [
      {
        "timestamp": convertTime(vessel, vessel.TIMESTAMP),
        "source": {
          "label": "marinetraffic-" + vessel.DSRC
        },
        "values": []
      }
    ]
  }
  mappings.forEach(mapping => {
    var val = vessel[mapping.key]
    if ( typeof val !== 'undefined' )
    {
      if ( typeof val === 'string' && val.length == 0 )
      return

      if ( mapping.conversion )
      {
        val = mapping.conversion(vessel, val)
        if ( val == null )
        return
      }
      var path = mapping.path
      if ( mapping.root )
      {
        var nval = {}
        nval[path] = val
        val = nval
        path = ''
      }
      addValue(delta, path, val)
    }
  })
  return delta;
}

function mod(x,y){
  return x-y*Math.floor(x/y)
}

function calc_position_from(position, heading, distance)
{
  var dist = (distance / 1000) / 1.852  //m to nm
  dist /= (180*60/Math.PI)  // in radians

  heading = (Math.PI*2)-heading

  var lat = Math.asin(Math.sin(degsToRad(position.latitude)) * Math.cos(dist) + Math.cos(degsToRad(position.latitude)) * Math.sin(dist) * Math.cos(heading))

  var dlon = Math.atan2(Math.sin(heading) * Math.sin(dist) * Math.cos(degsToRad(position.latitude)), Math.cos(dist) - Math.sin(degsToRad(position.latitude)) * Math.sin(lat))

  var lon = mod(degsToRad(position.longitude) - dlon + Math.PI, 2 * Math.PI) - Math.PI

  return { "latitude": radsToDeg(lat),
  "longitude": radsToDeg(lon) }
}
