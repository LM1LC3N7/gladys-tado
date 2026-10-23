# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.2] - 2026-10-23

### Fixed

- tado's daily API quota (100 requests a day on a free account, 20,000 with
  a subscription) is respected: the readings are spread over the day from the
  budget tado advertises, a part of it is kept for the commands, and when the
  quota is used up (HTTP 429) the readings pause until tado's reset with a
  clear status, then resume by themselves. A command refused for the quota
  fails with a clear message. Rate-limit handling inspired by
  RouXx67/gladys-tado-integration.
- After a command, the value set shows in Gladys at once, even when the
  home is not read again to save tado's quota. "Back to the schedule" is
  always followed by a reading (tado alone knows what the schedule applies),
  limited to the zone states when the budget is low.
- A tado reset later than noon is detected: when, just after noon, the
  remaining count is still the old day's and too low to read, the
  integration looks again within minutes (15 min, then 30 min, 1 h, 2 h)
  instead of waiting a whole day. A low but usable count (another app busy
  on the account) keeps the normal pace.
- A configuration save or a reconnection to Gladys no longer reads tado out
  of turn; a network outage is retried after the refresh interval (doubling,
  at most 30 minutes); a temporary refusal of login.tado.com (network, 5xx, 429) no longer asks to link the account again.
- Docs: the outputs of the scene actions come from the variable list
  (`{{<step>.<action>.<key>}}`), not `{{<key>}}`.

### Changed

- On a free tado account the weather is read every 3 hours (instead of 15
  minutes) and the zone list twice a day (instead of hourly), to leave the
  daily quota to the zone states. The "Refresh interval" option is now the
  shortest delay between two readings.

## [0.1.1] - 2026-10-13

### Added

- Account linking through the tado device-code sign-in (no password stored,
  the session is kept in the Gladys configuration).
- One device per home (presence, presence mode auto / home / away, outside
  temperature, solar intensity, weather) and per zone: heating (setpoint,
  mode, heating state and power, temperature, humidity, open window, low
  battery), hot water (on/off, mode, setpoint when supported) and air
  conditioning (on/off, mode, setpoint). tado X rooms through the hops API.
- Optional presence sensor per phone with geofencing.
- Scene triggers "presence changed", "open window detected", "zone started /
  stopped heating" and "low battery".
- Scene actions "set a temperature", "back to the schedule", "set the
  presence" and "read a zone".
- Dashboard widgets "tado° home" and "tado° zone".
- "Test the connection" and "Unlink the account" buttons.

[Unreleased]: https://github.com/LM1LC3N7/gladys-tado/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/LM1LC3N7/gladys-tado/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/LM1LC3N7/gladys-tado/releases/tag/v0.1.1
