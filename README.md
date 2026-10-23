# gladys-tado

[Gladys Assistant](https://gladysassistant.com) external integration for
**tado°** heating: thermostats and valves (V3+, V3, V2), hot water, air
conditioning and tado X rooms, with home presence, open window detection,
scene triggers and actions, and dashboard widgets. **Unofficial, not
affiliated with tado.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/app.js (TadoApp)
                 ├─ src/tado/auth.js   device-code sign-in, token refresh (login.tado.com)
                 ├─ src/tado/api.js    REST client: my.tado.com/api/v2 and hops.tado.com (tado X)
                 ├─ src/tado/ratelimit.js  daily quota: headers, budget, next delay (pure)
                 ├─ src/tado/model.js  tado JSON -> zones, presence, weather, phones (pure)
                 ├─ src/devices.js     zones -> Gladys devices and states (pure)
                 ├─ src/commands.js    Gladys command -> overlay / resume / presence (pure)
                 ├─ src/triggers.js    two readings -> scene events (pure)
                 └─ src/widget.js      the two widgets (pure)
```

- **Sign-in**: tado only accepts the OAuth2 device-code flow. The manifest
  declares an `account_link` field: Gladys calls `onOAuthAuthorizeUrl`, the
  app asks tado for a device code and returns the verification URL, then
  polls the token endpoint until the user approves. The rotated refresh token
  is saved in the Gladys configuration under an off-schema key.
- **Reading**: one `zoneStates` call per classic home (or `rooms` on tado
  X), one `state` call for the presence, the weather every 15 minutes and the
  zone list (batteries) every hour (every 3 h / 12 h on a free account).
  States go through `publishChangedStates`.
- **Daily quota** (`src/tado/ratelimit.js`): tado allows 100 requests a day
  on a free account, 20,000 with a subscription, and advertises the budget
  in the `ratelimit` / `ratelimit-policy` headers. The delay of the next
  reading is `max(refresh_interval, time to reset / ((left - reserve) / calls
per reading))`, the reserve (20 %, at least 10) staying for the commands;
  a 429 pauses the readings until tado's reset (12:00 Europe/Berlin), or
  briefly (growing pauses, once per pause) for a burst limit or a late
  reset; a 200 answer just after noon whose count is the old day's and too
  low for one reading (`readingCost`) counts as a late reset. A restart with
  the homes known does not read out of turn; no HTTP answer at all retries
  after `refresh_interval`, doubling up to 30 min. Timers never exceed 25 h.
- **Commands**: a setpoint or a mode becomes a tado overlay (manual
  setting) whose termination is the configured default; "Schedule" deletes
  the overlay. The commanded values are published at once (the devices
  have feedback); the home is re-read right after, unless the budget is
  down to the reserve. The pacing never holds a command back.
- **tado X** (`generation: LINE_X`): the hops endpoints `roomsAndDevices`,
  `rooms`, `manualControl` and `resumeSchedule`. Built without the hardware.

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npx github:GladysAssistant/integration-store .  # store admission checks
```

The tests run the app against the SDK's fake Gladys and recorded-shape tado
answers (`test/fixtures/`). To try the real API outside Gladys, run
`node index.js` with the three `GLADYS_*` variables of a dev instance.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0.
