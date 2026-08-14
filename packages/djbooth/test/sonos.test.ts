import { describe, expect, it } from "vitest";

import { parseZoneGroupState } from "../src/sonos.js";

describe("Sonos topology", () => {
  it("maps a room to its group coordinator and ignores invisible satellites", () => {
    const zones = parseZoneGroupState(`
      <ZoneGroups>
        <ZoneGroup ID="RINCON_GROUP" Coordinator="RINCON_COORDINATOR">
          <ZoneGroupMember UUID="RINCON_COORDINATOR" ZoneName="Living Room" Location="http://192.168.1.20:1400/xml/device_description.xml" />
          <ZoneGroupMember UUID="RINCON_KITCHEN" ZoneName="Kitchen &amp; Dining" Location="http://192.168.1.21:1400/xml/device_description.xml" />
          <ZoneGroupMember UUID="RINCON_SUB" ZoneName="Living Room" Invisible="1" Location="http://192.168.1.22:1400/xml/device_description.xml" />
        </ZoneGroup>
      </ZoneGroups>
    `);

    expect(zones).toEqual([
      {
        coordinatorUuid: "RINCON_COORDINATOR",
        location: "http://192.168.1.20:1400/xml/device_description.xml",
        room: "Living Room",
        uuid: "RINCON_COORDINATOR",
      },
      {
        coordinatorUuid: "RINCON_COORDINATOR",
        location: "http://192.168.1.21:1400/xml/device_description.xml",
        room: "Kitchen & Dining",
        uuid: "RINCON_KITCHEN",
      },
    ]);
  });
});
