export const OnglideWebSocketMessage = {
  "nested": {
    "OnglideWebSocketMessage": {
      "fields": {
        "tracks": {
          "type": "PilotTracks",
          "id": 1
        },
        "scores": {
          "type": "Scores",
          "id": 2
        },
        "positions": {
          "type": "Positions",
          "id": 3
        },
        "ka": {
          "type": "KeepAlive",
          "id": 4
        },
        "t": {
          "type": "uint32",
          "id": 5
        }
      }
    },
    "PilotTracks": {
      "fields": {
        "pilots": {
          "keyType": "string",
          "type": "PilotTrack",
          "id": 1
        }
      }
    },
    "PilotTrack": {
      "fields": {
        "compno": {
          "rule": "required",
          "type": "string",
          "id": 1
        },
        "posIndex": {
          "rule": "required",
          "type": "uint32",
          "id": 2
        },
        "t": {
          "type": "bytes",
          "id": 3
        },
        "positions": {
          "type": "bytes",
          "id": 4
        },
        "segmentIndex": {
          "type": "uint32",
          "id": 5
        },
        "indices": {
          "type": "bytes",
          "id": 6
        },
        "agl": {
          "type": "bytes",
          "id": 12
        },
        "recentIndices": {
          "type": "bytes",
          "id": 7
        },
        "climbRate": {
          "type": "bytes",
          "id": 8
        },
        "airSpeed": {
          "type": "bytes",
          "id": 9
        },
        "altitudeBand": {
          "type": "bytes",
          "id": 10
        },
        "leg": {
          "type": "bytes",
          "id": 11
        },
        "partial": {
          "type": "bool",
          "id": 13
        }
      }
    },
    "Scores": {
      "fields": {
        "pilots": {
          "keyType": "string",
          "type": "PilotScore",
          "id": 1
        }
      }
    },
    "SpeedDist": {
      "fields": {
        "distance": {
          "type": "double",
          "id": 1
        },
        "distancedone": {
          "type": "double",
          "id": 2
        },
        "distancetonext": {
          "type": "double",
          "id": 11
        },
        "remainingdistance": {
          "type": "double",
          "id": 12
        },
        "grremaining": {
          "type": "uint32",
          "id": 20
        },
        "legspeed": {
          "type": "double",
          "id": 30
        },
        "taskspeed": {
          "type": "double",
          "id": 31
        }
      }
    },
    "Legs": {
      "fields": {
        "leg": {
          "type": "uint32",
          "id": 1
        },
        "time": {
          "type": "uint32",
          "id": 2
        },
        "duration": {
          "type": "uint32",
          "id": 3
        },
        "lat": {
          "type": "double",
          "id": 4
        },
        "lng": {
          "type": "double",
          "id": 5
        },
        "alt": {
          "type": "uint32",
          "id": 6
        },
        "agl": {
          "type": "uint32",
          "id": 7
        },
        "handicapped": {
          "type": "SpeedDist",
          "id": 10
        },
        "actual": {
          "type": "SpeedDist",
          "id": 11
        }
      }
    },
    "Wind": {
      "fields": {
        "speed": {
          "type": "uint32",
          "id": 1
        },
        "direction": {
          "type": "uint32",
          "id": 2
        }
      }
    },
    "Stats": {
      "fields": {
        "start": {
          "type": "uint32",
          "id": 1
        },
        "end": {
          "type": "uint32",
          "id": 2
        },
        "state": {
          "type": "string",
          "id": 3
        },
        "wind": {
          "type": "Wind",
          "id": 4
        },
        "turncount": {
          "type": "uint32",
          "id": 5
        },
        "distance": {
          "type": "double",
          "id": 6
        },
        "achievedDistance": {
          "type": "double",
          "id": 7
        },
        "delta": {
          "type": "int32",
          "id": 8
        },
        "avgDelta": {
          "type": "double",
          "id": 9
        },
        "direction": {
          "type": "uint32",
          "id": 10
        },
        "heightgain": {
          "type": "uint32",
          "id": 11
        },
        "heightloss": {
          "type": "uint32",
          "id": 12
        }
      }
    },
    "PilotScore": {
      "fields": {
        "class": {
          "type": "string",
          "id": 1
        },
        "compno": {
          "type": "string",
          "id": 2
        },
        "dbstatus": {
          "type": "string",
          "id": 3
        },
        "datafromscoring": {
          "type": "string",
          "id": 4
        },
        "scoredstatus": {
          "type": "string",
          "id": 5
        },
        "utcstart": {
          "type": "uint32",
          "id": 6
        },
        "start": {
          "type": "string",
          "id": 7
        },
        "finish": {
          "type": "string",
          "id": 8
        },
        "duration": {
          "type": "string",
          "id": 9
        },
        "forcetp": {
          "type": "uint32",
          "id": 10
        },
        "name": {
          "type": "string",
          "id": 11
        },
        "glidertype": {
          "type": "string",
          "id": 12
        },
        "handicap": {
          "type": "double",
          "id": 13
        },
        "image": {
          "type": "string",
          "id": 14
        },
        "daypoints": {
          "type": "uint32",
          "id": 15
        },
        "dayrank": {
          "type": "uint32",
          "id": 16
        },
        "dayrankordinal": {
          "type": "string",
          "id": 18
        },
        "country": {
          "type": "string",
          "id": 17
        },
        "prevtotalrank": {
          "type": "uint32",
          "id": 19
        },
        "totalrank": {
          "type": "uint32",
          "id": 20
        },
        "hdistancedone": {
          "type": "double",
          "id": 21
        },
        "distancedone": {
          "type": "double",
          "id": 22
        },
        "speed": {
          "type": "double",
          "id": 23
        },
        "hspeed": {
          "type": "double",
          "id": 24
        },
        "maxdistancedone": {
          "type": "uint32",
          "id": 25
        },
        "min": {
          "type": "uint32",
          "id": 26
        },
        "max": {
          "type": "uint32",
          "id": 27
        },
        "taskduration": {
          "type": "uint32",
          "id": 28
        },
        "lat": {
          "type": "double",
          "id": 29
        },
        "lng": {
          "type": "double",
          "id": 30
        },
        "altitude": {
          "type": "uint32",
          "id": 31
        },
        "agl": {
          "type": "uint32",
          "id": 32
        },
        "lastUpdated": {
          "type": "uint32",
          "id": 33
        },
        "startFound": {
          "type": "bool",
          "id": 34
        },
        "legs": {
          "keyType": "uint32",
          "type": "Legs",
          "id": 36
        },
        "lasttp": {
          "type": "uint32",
          "id": 37
        },
        "status": {
          "type": "string",
          "id": 38
        },
        "remainingdistance": {
          "type": "double",
          "id": 39
        },
        "hremainingdistance": {
          "type": "double",
          "id": 40
        },
        "grremaining": {
          "type": "uint32",
          "id": 41
        },
        "hgrremaining": {
          "type": "uint32",
          "id": 42
        },
        "stats": {
          "rule": "repeated",
          "type": "Stats",
          "id": 43
        },
        "scoredpoints": {
          "rule": "repeated",
          "type": "float",
          "id": 52
        },
        "gainXsecond": {
          "type": "uint32",
          "id": 45
        },
        "lossXsecond": {
          "type": "uint32",
          "id": 46
        },
        "Xperiod": {
          "type": "uint32",
          "id": 47
        },
        "average": {
          "type": "double",
          "id": 48
        },
        "total": {
          "type": "uint32",
          "id": 49
        },
        "stationary": {
          "type": "bool",
          "id": 50
        },
        "at": {
          "type": "uint32",
          "id": 51
        },
        "task": {
          "type": "string",
          "id": 53
        }
      }
    },
    "Positions": {
      "fields": {
        "positions": {
          "keyType": "string",
          "type": "PilotPositions",
          "id": 1
        }
      }
    },
    "PilotPositions": {
      "fields": {
        "c": {
          "type": "string",
          "id": 1
        },
        "lat": {
          "type": "double",
          "id": 2
        },
        "lng": {
          "type": "double",
          "id": 3
        },
        "a": {
          "type": "uint32",
          "id": 4
        },
        "g": {
          "type": "uint32",
          "id": 5
        },
        "t": {
          "type": "uint32",
          "id": 6
        },
        "b": {
          "type": "uint32",
          "id": 7
        },
        "s": {
          "type": "uint32",
          "id": 8
        },
        "v": {
          "type": "string",
          "id": 9
        }
      }
    },
    "KeepAlive": {
      "fields": {
        "keepalive": {
          "type": "bool",
          "id": 1
        },
        "t": {
          "type": "string",
          "id": 2
        },
        "at": {
          "type": "uint32",
          "id": 3
        },
        "listeners": {
          "type": "uint32",
          "id": 4
        },
        "airborne": {
          "type": "uint32",
          "id": 5
        }
      }
    },
    "google": {
      "nested": {
        "protobuf": {
          "nested": {
            "Any": {
              "fields": {
                "type_url": {
                  "type": "string",
                  "id": 1
                },
                "value": {
                  "type": "bytes",
                  "id": 2
                }
              }
            }
          }
        }
      }
    }
  }
}
