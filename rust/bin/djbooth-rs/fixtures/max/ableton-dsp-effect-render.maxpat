{
  "patcher": {
    "fileversion": 1,
    "appversion": { "major": 9, "minor": 0, "revision": 9, "architecture": "arm64", "modernui": 1 },
    "classnamespace": "box",
    "rect": [0.0, 0.0, 900.0, 500.0],
    "boxes": [
      { "box": { "id": "load", "maxclass": "newobj", "text": "loadbang", "patching_rect": [30.0, 30.0, 60.0, 22.0], "numinlets": 1, "numoutlets": 1, "outlettype": ["bang"] } },
      { "box": { "id": "driver-msg", "maxclass": "message", "text": "NonRealTime", "patching_rect": [120.0, 30.0, 90.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": [""] } },
      { "box": { "id": "driver", "maxclass": "newobj", "text": "adstatus driver", "patching_rect": [230.0, 30.0, 95.0, 22.0], "numinlets": 2, "numoutlets": 2, "outlettype": ["", "int"] } },
      { "box": { "id": "dsp-delay", "maxclass": "newobj", "text": "delay 500", "patching_rect": [30.0, 75.0, 65.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": ["bang"] } },
      { "box": { "id": "dsp-on", "maxclass": "message", "text": "1", "patching_rect": [110.0, 75.0, 32.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": [""] } },
      { "box": { "id": "dac", "maxclass": "newobj", "text": "ezdac~", "patching_rect": [700.0, 350.0, 48.0, 22.0], "numinlets": 2, "numoutlets": 0 } },

      { "box": { "id": "input-open-delay", "maxclass": "newobj", "text": "delay 1000", "patching_rect": [30.0, 125.0, 75.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": ["bang"] } },
      { "box": { "id": "input-open", "maxclass": "message", "text": "open \"__INPUT__\"", "patching_rect": [120.0, 125.0, 360.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": [""] } },
      { "box": { "id": "input-player", "maxclass": "newobj", "text": "sfplay~ 2", "patching_rect": [330.0, 180.0, 70.0, 22.0], "numinlets": 2, "numoutlets": 3, "outlettype": ["signal", "signal", "bang"] } },
      { "box": { "id": "play", "maxclass": "message", "text": "1", "patching_rect": [230.0, 215.0, 32.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": [""] } },
      __DEVICE_BOXES__
      { "box": { "id": "record", "maxclass": "newobj", "text": "sfrecord~ 2", "patching_rect": [430.0, 350.0, 75.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": ["int"] } },

      { "box": { "id": "open-delay", "maxclass": "newobj", "text": "delay 1200", "patching_rect": [30.0, 180.0, 75.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": ["bang"] } },
      { "box": { "id": "open", "maxclass": "message", "text": "open \"__OUTPUT__\" wave", "patching_rect": [120.0, 180.0, 260.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": [""] } },
      { "box": { "id": "record-delay", "maxclass": "newobj", "text": "delay 1500", "patching_rect": [30.0, 215.0, 75.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": ["bang"] } },
      { "box": { "id": "start", "maxclass": "newobj", "text": "t b b", "patching_rect": [120.0, 215.0, 45.0, 22.0], "numinlets": 1, "numoutlets": 2, "outlettype": ["bang", "bang"] } },
      { "box": { "id": "record-on", "maxclass": "message", "text": "1", "patching_rect": [120.0, 215.0, 32.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": [""] } },
      { "box": { "id": "stop-delay", "maxclass": "newobj", "text": "delay __STOP_DELAY__", "patching_rect": [30.0, 270.0, 95.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": ["bang"] } },
      { "box": { "id": "record-off", "maxclass": "message", "text": "0", "patching_rect": [140.0, 270.0, 32.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": [""] } },
      { "box": { "id": "quit-delay", "maxclass": "newobj", "text": "delay __QUIT_DELAY__", "patching_rect": [30.0, 305.0, 95.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": ["bang"] } },
      { "box": { "id": "quit", "maxclass": "message", "text": ";\rmax quit", "patching_rect": [140.0, 305.0, 65.0, 35.0], "numinlets": 2, "numoutlets": 0 } }
    ],
    "lines": [
      { "patchline": { "source": ["load", 0], "destination": ["driver-msg", 0] } },
      { "patchline": { "source": ["driver-msg", 0], "destination": ["driver", 0] } },
      { "patchline": { "source": ["load", 0], "destination": ["dsp-delay", 0] } },
      { "patchline": { "source": ["dsp-delay", 0], "destination": ["dsp-on", 0] } },
      { "patchline": { "source": ["dsp-on", 0], "destination": ["dac", 0] } },

      { "patchline": { "source": ["load", 0], "destination": ["input-open-delay", 0] } },
      { "patchline": { "source": ["input-open-delay", 0], "destination": ["input-open", 0] } },
      { "patchline": { "source": ["input-open", 0], "destination": ["input-player", 0] } },
      __DEVICE_LINES__

      { "patchline": { "source": ["load", 0], "destination": ["open-delay", 0] } },
      { "patchline": { "source": ["open-delay", 0], "destination": ["open", 0] } },
      { "patchline": { "source": ["open", 0], "destination": ["record", 0] } },
      { "patchline": { "source": ["load", 0], "destination": ["record-delay", 0] } },
      { "patchline": { "source": ["record-delay", 0], "destination": ["start", 0] } },
      { "patchline": { "source": ["start", 1], "destination": ["record-on", 0] } },
      { "patchline": { "source": ["start", 0], "destination": ["play", 0] } },
      { "patchline": { "source": ["play", 0], "destination": ["input-player", 0] } },
      { "patchline": { "source": ["record-on", 0], "destination": ["record", 0] } },
      { "patchline": { "source": ["load", 0], "destination": ["stop-delay", 0] } },
      { "patchline": { "source": ["stop-delay", 0], "destination": ["record-off", 0] } },
      { "patchline": { "source": ["record-off", 0], "destination": ["record", 0] } },
      { "patchline": { "source": ["load", 0], "destination": ["quit-delay", 0] } },
      { "patchline": { "source": ["quit-delay", 0], "destination": ["quit", 0] } }
    ]
  }
}
