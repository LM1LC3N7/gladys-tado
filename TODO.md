# TODO

## Before announcing

- [ ] Test on a real Gladys 5.1+ with a real tado account (V3+): the sign-in
      flow end to end (does the Configuration screen open the returned URL
      in a new tab for an `account_link` field?), discovery, states, a
      setpoint from the thermostat widget, the two widgets, the four scene
      triggers over a day.
- [ ] Reserve "tado°" in the forum thread t/10385, then add the
      `gladys-assistant-integration` topic to publish in the store.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).

## To confirm with real hardware (built blind)

- [ ] `/zoneStates` is still served for every zone type (hot water and AC
      included) and `openWindowDetected` exists on current accounts.
- [ ] `/zones/{id}/capabilities` answers `canSetTemperature` for hot water.
- [ ] tado X (`generation: LINE_X`): the shape of `/roomsAndDevices`
      (`roomId` / `roomName` vs `id` / `name`), `/rooms`, `manualControl`
      and `resumeSchedule` on hops.tado.com; hot water on tado X is not
      handled yet.
- [ ] The home presence select (a text select) shows its labels as they are,
      in English, in the French interface: the core only accepts a plain string
      for a label and does not translate it. The thermostat, hot water and air
      conditioning selects are translated by the front from the value.
- [ ] The `unknown` category with a percent unit renders the heating power
      and solar intensity sensors correctly in the device widget and charts.
- [ ] The thermostat `mode` select shows the three labels of
      `supported_options` and sends integers back. The labels are plain
      English strings (the core's schema refuses `{ en, fr }`); the
      Discovery of a real tado X home lists its devices.
- [ ] The daily quota pacing on a real account: tado sends the `ratelimit`
      / `ratelimit-policy` headers on my.tado.com **and** hops.tado.com (an
      answer without them is counted locally), `t=` matches the 12:00
      Europe/Berlin reset, and a free account settles at about 35 readings a
      day for one home (23 with the phone sensors) without a 429.

## Ideas

- Hot water boost and timer on tado X (`/programmer/domesticHotWater`).
- The `THERMOSTAT.PRESET` feature mapped to tado's Home/Away (per zone
  comfort / eco temperatures).
- Energy IQ (tado's monthly heating estimate) as a daily consumption.
- Air comfort (`/airComfort`): freshness and comfort levels per zone.
