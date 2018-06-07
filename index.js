/*
* Copyright 2017 Scott Bender <scott@scottbender.net> and Joachim Bakke
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
  var simpleTimeout, extendedTimeout, fullTimeout = undefined
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
      simpleRate: {
        type: "number",
        title: "API update limit for simple queries (minutes), negative to disable",
        default: 120
      },
      extendedRate: {
        type: "number",
        title: "API update limit for extended queries (minutes), negative to disable",
        default: 60
      },
      fullRate: {
        type: "number",
        title: "API update limit for full queries (minutes), negative to disable",
        default: 60
      },
      timespan: {
        type: "number",
        title: "Marinetraffic timespan, ignoring older updates (minutes)",
        default: 10
      },
      vessel: {
        type: "number",
        title: "optional vessel MMSI (for API PS07), 0 if not active",
        default: 0
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
    var update = function(msgType)
    {
      /*var test = `[{"MMSI":"304010417","IMO":"9015462","SHIP_ID":"359396","LAT":"47.758499","LON":"-5.154223","SPEED":"74","HEADING":"329","COURSE":"327","STATUS":"0","TIMESTAMP":"2017-05-19T09:39:57","DSRC":"TER","UTC_SECONDS":"54"},
      {"MMSI":"215819000","IMO":"9034731","SHIP_ID":"150559","LAT":"47.926899","LON":"-5.531450","SPEED":"122","HEADING":"162","COURSE":"157","STATUS":"0","TIMESTAMP":"2017-05-19T09:44:27","DSRC":"TER","UTC_SECONDS":"28"},
      {"MMSI":"255925000","IMO":"9184433","SHIP_ID":"300518","LAT":"47.942631","LON":"-5.116510","SPEED":"79","HEADING":"316","COURSE":"311","STATUS":"0","TIMESTAMP":"2017-05-19T09:43:53","DSRC":"TER","UTC_SECONDS":"52"}]`

      marineTrafficToDeltas(test)*/
      var endPoint = "http://services.marinetraffic.com/api/exportvessels/v:8/" + options.apikey + "/timespan:" + options.timespan + "/msgtype:" + msgType + "/protocol:jsono"
      //https://services.marinetraffic.com/api/exportvessels/v:8/YOUR-API-KEY/timespan:#minutes/protocol:value for PS02 and PS03
      if (options.vessel != 0){
        endPoint = "http://services.marinetraffic.com/api/exportvessels/v:5/" + options.apikey + "/timespan:" + options.timespan + "/mmsi:" + options.vessel + "/protocol:jsono"
      }
      //https://services.marinetraffic.com/api/exportvessel/v:5/YOUR-API-KEY/timespan:#minutes/mmsi:value for PS07
      debug("url: " + endPoint)

      agent('GET', endPoint).end().then(function(response) {
        marineTrafficToDeltas(response.text)
      })

    }

    var simpleRate = options.simpleRate
    var extendedRate = options.extendedRate
    var fullRate = options.fullRate

    update(fullRate>0?"full":extendedRate>0?"extended":"simple") //start with the most comprehensive call
    if(simpleRate > 0){
      simpleTimeout = setInterval(update, simpleRate * 60000, "simple")
    }
    if(extendedRate > 0){
      extendedTimeout = setInterval(update, extendedRate * 60000, "extended")
    }
    if(fullRate > 0){
      fullTimeout = setInterval(update, fullRate * 60000, "full")
    }

  }

  plugin.stop = function()
  {
    if ( simpleTimeout ) {
      clearInterval(simpleTimeout)
      simpleTimeout = undefined
    }
    if ( extendedTimeout ) {
      clearInterval(extendedTimeout)
      extendedTimeout = undefined
    }
    if ( fullTimeout ) {
      clearInterval(fullTimeout)
      fullTimeout = undefined
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
      return { latitude: parseFloat(val), longitude:parseFloat(vessel.LON) }
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
    path: "navigation.courseGreatCircle.activeRoute.estimatedTimeOfArrivalCalculated",//Not spec compliant
    key: "ETA_CALC",//How to distinguish between reported and MT calculated ETA?
    //"ETA_CALC"?"ETA_CALC":"ETA"
    conversion: convertTime
  },
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
    }/*
  },
  {
    path: "navigation.trip.distanceToGo",//Not in spec yet
    key: "DISTANCE_TO_GO",
    conversion: function(vessel, val) {
      return val / 1852
    }*/
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
