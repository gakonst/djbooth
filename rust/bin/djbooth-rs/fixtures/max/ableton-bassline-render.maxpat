{
  "patcher": {
    "fileversion": 1,
    "appversion": {
      "major": 9,
      "minor": 0,
      "revision": 9,
      "architecture": "arm64",
      "modernui": 1
    },
    "classnamespace": "box",
    "rect": [0.0, 0.0, 900.0, 620.0],
    "boxes": [
      { "box": { "id": "load", "maxclass": "newobj", "text": "loadbang", "patching_rect": [30.0, 30.0, 60.0, 22.0], "numinlets": 1, "numoutlets": 1, "outlettype": ["bang"] } },
      { "box": { "id": "driver-msg", "maxclass": "message", "text": "NonRealTime", "patching_rect": [120.0, 30.0, 90.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": [""] } },
      { "box": { "id": "driver", "maxclass": "newobj", "text": "adstatus driver", "patching_rect": [230.0, 30.0, 95.0, 22.0], "numinlets": 2, "numoutlets": 2, "outlettype": ["", "int"] } },
      { "box": { "id": "dsp-delay", "maxclass": "newobj", "text": "delay 500", "patching_rect": [30.0, 75.0, 65.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": ["bang"] } },
      { "box": { "id": "dsp-on", "maxclass": "message", "text": "1", "patching_rect": [110.0, 75.0, 32.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": [""] } },
      { "box": { "id": "dac", "maxclass": "newobj", "text": "ezdac~", "patching_rect": [700.0, 410.0, 48.0, 22.0], "numinlets": 2, "numoutlets": 0 } },

      __INPUT_BOXES__
      { "box": { "id": "device", "maxclass": "newobj", "text": "amxd~ \"__AMXD__\"", "patching_rect": [330.0, 250.0, 500.0, 22.0], "numinlets": 3, "numoutlets": 4, "outlettype": ["signal", "signal", "signal", ""] } },
      { "box": { "id": "record", "maxclass": "newobj", "text": "sfrecord~ 2", "patching_rect": [430.0, 410.0, 75.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": ["int"] } },

      { "box": { "id": "open-delay", "maxclass": "newobj", "text": "delay 1200", "patching_rect": [30.0, 130.0, 75.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": ["bang"] } },
      { "box": { "id": "open", "maxclass": "message", "text": "open \"__OUTPUT__\" wave", "patching_rect": [120.0, 130.0, 260.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": [""] } },
      { "box": { "id": "record-delay", "maxclass": "newobj", "text": "delay 1400", "patching_rect": [30.0, 165.0, 75.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": ["bang"] } },
      { "box": { "id": "record-on", "maxclass": "message", "text": "1", "patching_rect": [120.0, 165.0, 32.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": [""] } },

      { "box": { "id": "note1-delay", "maxclass": "newobj", "text": "delay 1600", "patching_rect": [30.0, 220.0, 75.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": ["bang"] } },
      { "box": { "id": "note1", "maxclass": "message", "text": "midievent 144 __NOTE1__ __VELOCITY__", "patching_rect": [120.0, 220.0, 135.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": [""] } },
      { "box": { "id": "note1off-delay", "maxclass": "newobj", "text": "delay 2400", "patching_rect": [30.0, 255.0, 75.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": ["bang"] } },
      { "box": { "id": "note1off", "maxclass": "message", "text": "midievent 128 __NOTE1__ 0", "patching_rect": [120.0, 255.0, 125.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": [""] } },
      { "box": { "id": "note2-delay", "maxclass": "newobj", "text": "delay 2500", "patching_rect": [30.0, 290.0, 75.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": ["bang"] } },
      { "box": { "id": "note2", "maxclass": "message", "text": "midievent 144 __NOTE2__ __VELOCITY__", "patching_rect": [120.0, 290.0, 135.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": [""] } },
      { "box": { "id": "note2off-delay", "maxclass": "newobj", "text": "delay 3300", "patching_rect": [30.0, 325.0, 75.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": ["bang"] } },
      { "box": { "id": "note2off", "maxclass": "message", "text": "midievent 128 __NOTE2__ 0", "patching_rect": [120.0, 325.0, 125.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": [""] } },

      { "box": { "id": "stop-delay", "maxclass": "newobj", "text": "delay __STOP_DELAY__", "patching_rect": [30.0, 380.0, 75.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": ["bang"] } },
      { "box": { "id": "record-off", "maxclass": "message", "text": "0", "patching_rect": [120.0, 380.0, 32.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": [""] } },
      { "box": { "id": "quit-delay", "maxclass": "newobj", "text": "delay __QUIT_DELAY__", "patching_rect": [30.0, 415.0, 75.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": ["bang"] } },
      { "box": { "id": "quit", "maxclass": "message", "text": ";\rmax quit", "patching_rect": [120.0, 415.0, 65.0, 35.0], "numinlets": 2, "numoutlets": 0 } }
    ],
    "lines": [
      { "patchline": { "source": ["load", 0], "destination": ["driver-msg", 0] } },
      { "patchline": { "source": ["driver-msg", 0], "destination": ["driver", 0] } },
      { "patchline": { "source": ["load", 0], "destination": ["dsp-delay", 0] } },
      { "patchline": { "source": ["dsp-delay", 0], "destination": ["dsp-on", 0] } },
      { "patchline": { "source": ["dsp-on", 0], "destination": ["dac", 0] } },

      { "patchline": { "source": ["load", 0], "destination": ["open-delay", 0] } },
      { "patchline": { "source": ["open-delay", 0], "destination": ["open", 0] } },
      { "patchline": { "source": ["open", 0], "destination": ["record", 0] } },
      { "patchline": { "source": ["load", 0], "destination": ["record-delay", 0] } },
      { "patchline": { "source": ["record-delay", 0], "destination": ["record-on", 0] } },
      { "patchline": { "source": ["record-on", 0], "destination": ["record", 0] } },

      __INPUT_LINES__
      { "patchline": { "source": ["load", 0], "destination": ["note1-delay", 0] } },
      { "patchline": { "source": ["note1-delay", 0], "destination": ["note1", 0] } },
      { "patchline": { "source": ["note1", 0], "destination": ["device", 0] } },
      { "patchline": { "source": ["load", 0], "destination": ["note1off-delay", 0] } },
      { "patchline": { "source": ["note1off-delay", 0], "destination": ["note1off", 0] } },
      { "patchline": { "source": ["note1off", 0], "destination": ["device", 0] } },
      { "patchline": { "source": ["load", 0], "destination": ["note2-delay", 0] } },
      { "patchline": { "source": ["note2-delay", 0], "destination": ["note2", 0] } },
      { "patchline": { "source": ["note2", 0], "destination": ["device", 0] } },
      { "patchline": { "source": ["load", 0], "destination": ["note2off-delay", 0] } },
      { "patchline": { "source": ["note2off-delay", 0], "destination": ["note2off", 0] } },
      { "patchline": { "source": ["note2off", 0], "destination": ["device", 0] } },

      { "patchline": { "source": ["device", 0], "destination": ["record", 0] } },
      { "patchline": { "source": ["device", 1], "destination": ["record", 1] } },
      { "patchline": { "source": ["device", 0], "destination": ["dac", 0] } },
      { "patchline": { "source": ["device", 1], "destination": ["dac", 1] } },

      { "patchline": { "source": ["load", 0], "destination": ["stop-delay", 0] } },
      { "patchline": { "source": ["stop-delay", 0], "destination": ["record-off", 0] } },
      { "patchline": { "source": ["record-off", 0], "destination": ["record", 0] } },
      { "patchline": { "source": ["load", 0], "destination": ["quit-delay", 0] } },
      { "patchline": { "source": ["quit-delay", 0], "destination": ["quit", 0] } }
    ]
  }
}
