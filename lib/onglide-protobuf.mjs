export const PilotTracks = {
  "nested": {
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
        }
      }
    }
  }
}
