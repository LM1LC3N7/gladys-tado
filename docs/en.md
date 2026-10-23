# tado°

**Unofficial connector, not affiliated with tado.** It brings your tado°
heating into Gladys: the thermostats and radiator valves of the V3+, V3 and V2
generations, hot water, air conditioning, and the rooms of tado X. tado is a
trademark of tado GmbH.

## What you get

| Surface                                            | Content                                                                                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One device per **home**                            | at home (presence sensor), presence mode (automatic / home / away), outside temperature, solar intensity, weather                                                               |
| One device per **heating zone**                    | setpoint, mode (off / manual / schedule), heating state and heating power, temperature, humidity, open window detected, low battery                                             |
| One device per **hot water** zone                  | on/off, mode, setpoint when the system supports it                                                                                                                              |
| One device per **air conditioning** zone           | on/off, mode (auto, cool, heat, dry, fan), setpoint, temperature, humidity                                                                                                      |
| Optional: one device per **phone** with geofencing | at home / away                                                                                                                                                                  |
| Scene triggers                                     | presence changed, open window detected, zone started / stopped heating, low battery                                                                                             |
| Scene actions                                      | set a temperature (until the next block, for a duration, or until changed), back to the schedule, set the presence, read a zone                                                 |
| Dashboard widgets                                  | **tado° home** (presence, outside, every zone, Home / Away / Auto buttons) and **tado° zone** (temperature, humidity, setpoint, heating gauge, mode, +/− 0.5 °C, schedule, off) |

## Setup

1. Install the integration and open its **Configuration** screen.
2. Click **Link my tado° account**: a tado sign-in page opens in a new tab.
   Sign in and approve the access. No password is stored in Gladys: tado
   gives the integration a session that it renews by itself.
3. Back in Gladys, the status turns green within a few seconds and the
   homes and zones appear in **Discovery**: add the devices you want.
4. Put the widgets on a dashboard, pick the home or the zone.

The session stays valid as long as the integration runs at least once a
month. After a long stop, the status asks you to link the account again.

## Setpoints

A setpoint sent from Gladys (the thermostat widget, a scene, the zone widget)
is a **manual setting** in tado, like one made on the device. The option
**A manual setpoint lasts** decides when it ends: at the next block of the
tado schedule (default), after a fixed duration, or when it is changed again.
The scene action **set a temperature** can override it per scene.

Setting the mode to **Schedule** ends the manual setting (tado resumes its
program); **Off** turns the zone off (frost protection stays on tado's side).

## Scenes

- **Presence changed**: the home went Home → Away or Away → Home, by
  geofencing or by a manual change. Lower the lights, arm the alarm.
- **Open window detected**: tado paused the heating of a zone because a
  window is open. Send a notification.
- **Zone started / stopped heating**: the heating power went above zero or
  back to zero. Switch a pump, count the heating hours.
- **Low battery**: a thermostat or valve of the zone reports a low battery.

The actions **set a temperature** and **back to the schedule** return the
zone's values; **read a zone** gives them for a condition that follows
(`temperature`, `heating`, `open_window`...). The following actions of the
scene find them in their variable list (written `{{<step>.<action>.<key>}}`,
for instance `{{0.0.temperature}}` when this action is the first of the
scene).

## tado's daily request limit

tado limits the number of requests each account can make per day: **100 a
day on a free account**, 20,000 with an Auto-Assist or AI-Assist
subscription. The counter resets around 12:00 (Berlin time). Every request
counts, including those of other apps and integrations using the same
account.

The integration reads the remaining budget tado sends back and paces itself:

- it keeps about a fifth of the quota (20 requests on a free account) for
  your **commands** (setpoints from a widget or a scene), which are never
  delayed;
- it spreads the rest of the budget over the day: on a free account with one
  home, a reading about every **40 minutes** (about an hour with the phone
  presence sensors); the weather every 3 hours, the battery list twice a day;
- with a subscription, the **Refresh interval** option applies as set
  (2 minutes by default), the weather every 15 minutes.

If the quota is used up anyway (another app sharing the account, many
commands), the status says **"tado° daily API quota used up"** with the time
the readings resume; commands fail with a clear message until tado's reset,
and everything resumes by itself afterwards. When tado only asks to slow down for a moment, the status says so ("for now") and the readings resume within minutes; a tado reset a little after noon is noticed within minutes too. Saving the configuration or a restart of Gladys does not
spend requests: the readings keep their pace. When tado cannot be reached at
all (network down), the integration retries after the refresh interval,
then less and less often (at most every 30 minutes).

## Privacy

The integration talks only to tado's servers (`login.tado.com`,
`my.tado.com`, `hops.tado.com`). The phone presence sensors are off by
default: they expose where the household members are.

## Troubleshooting

- **"tado° refused the saved session"**: the session expired (30 days
  without use) or was revoked in the tado app. Click **Link my tado° account**
  again.
- **The status says "waiting for your approval"**: finish the sign-in in the
  tab that opened; the link is valid 5 minutes.
- **Values move slowly**: on a free tado account the readings are spread
  over the day because of tado's daily limit (see above); with a
  subscription tado is read every 2 minutes by default (option **Refresh
  interval**). After a command, Gladys shows the value you set at once; the
  home is read again right after when the budget allows, otherwise at the
  next reading. **Schedule** is always followed by a reading: only tado
  knows what the schedule applies.
- **A hot water zone has no setpoint**: your installation only supports
  on/off (tado reports it).
- **tado X**: built from the public documentation of the hops API without
  the hardware; please report what does not match in the forum thread.
