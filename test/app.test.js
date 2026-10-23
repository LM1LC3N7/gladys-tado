// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and a fake tado.
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { TadoApp, configFingerprint } from '../src/app.js';
import {
  ACTIONS,
  CONFIG_KEYS,
  SCENE_ACTIONS,
  SCENE_TRIGGERS,
  TOKEN_KEYS,
  WIDGETS,
} from '../src/constants.js';
import { installFetch, json } from './helpers/fakeFetch.js';
import { createFakeTimers } from './helpers/fakeTimers.js';
import * as v2 from './fixtures/v2.js';
import * as x from './fixtures/x.js';

const quiet = {
  info() {},
  warn: (...a) => process.env.DEBUG_TEST && console.error(...a),
  error() {},
  debug() {},
};

let fake;
afterEach(() => fake?.restore());

const NOW = Date.parse('2026-10-13T12:00:00Z');
const HOME = 'ext:tado:home:1234';
const SALON = 'ext:tado:zone:1234:1';
const WATER = 'ext:tado:zone:1234:3';

/** The classic home 1234, with overridable zone states and presence. */
function v2Routes(state = {}) {
  state.zones ??= v2.zoneStates();
  state.presence ??= v2.homeState();
  return [
    ['POST', /oauth2\/token/, () => json(v2.tokens)],
    ['GET', /\/api\/v2\/me$/, () => json(v2.me)],
    ['GET', /\/homes\/1234$/, () => json(v2.home)],
    ['GET', /\/homes\/1234\/zones$/, () => json(v2.zones)],
    [
      'GET',
      /\/zones\/3\/capabilities$/,
      () => json({ type: 'HOT_WATER', canSetTemperature: false }),
    ],
    ['GET', /\/homes\/1234\/zoneStates$/, () => json(state.zones)],
    ['GET', /\/homes\/1234\/state$/, () => json(state.presence)],
    ['GET', /\/homes\/1234\/weather$/, () => json(v2.weather)],
    ['GET', /\/homes\/1234\/mobileDevices$/, () => json(v2.mobileDevices)],
    ['PUT', /\/zones\/\d+\/overlay$/, (call) => json({ ...call.body, type: 'MANUAL' })],
    ['DELETE', /\/zones\/\d+\/overlay$/, () => json(undefined, 204)],
    ['PUT', /\/presenceLock$/, () => json(undefined, 204)],
    ['DELETE', /\/presenceLock$/, () => json(undefined, 204)],
  ];
}

/** The tado X home 5678 (hops), without the account routes. */
function xRoutes() {
  return [
    ['GET', /\/homes\/5678$/, () => json(x.home)],
    ['GET', /hops.*\/homes\/5678\/roomsAndDevices$/, () => json(x.roomsAndDevices)],
    ['GET', /hops.*\/homes\/5678\/rooms$/, () => json(x.rooms())],
    ['GET', /\/homes\/5678\/state$/, () => json(v2.homeState())],
    ['GET', /\/homes\/5678\/weather$/, () => json(v2.weather)],
    ['POST', /rooms\/7\/manualControl$/, () => json(undefined, 204)],
    ['POST', /rooms\/7\/resumeSchedule$/, () => json(undefined, 204)],
  ];
}

/**
 * The app against the fake Gladys and a fake tado. `quota` ({ quota,
 * remaining }) puts the fake tado's daily counter in front of the routes
 * (see withQuota), on the same clock as the app; `now` sets that clock.
 */
function setup({
  config = { [TOKEN_KEYS.REFRESH]: 'ref0' },
  routes,
  state = {},
  quota,
  now = NOW,
} = {}) {
  const clock = { now };
  let tado;
  let all = routes ?? v2Routes(state);
  if (quota) {
    ({ tado, routes: all } = withQuota(clock, all, quota));
  }
  fake = installFetch(all);
  const gladys = createFakeGladys({ selector: 'tado', config });
  const timers = createFakeTimers();
  const app = new TadoApp({ gladys, logger: quiet, now: () => clock.now, timers });
  // What index.js wires.
  gladys.onScanRequest(() => app.scan());
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));
  gladys.onOAuthAuthorizeUrl((key) => app.authorizeUrl(key));
  gladys.onSceneAction(SCENE_ACTIONS.SET_TEMPERATURE, (f) => app.setTemperature(f));
  gladys.onSceneAction(SCENE_ACTIONS.RESUME_SCHEDULE, (f) => app.resumeSchedule(f));
  gladys.onSceneAction(SCENE_ACTIONS.SET_PRESENCE, (f) => app.setPresence(f));
  gladys.onSceneAction(SCENE_ACTIONS.GET_ZONE, (f) => app.getZone(f));
  for (const key of Object.values(WIDGETS)) {
    gladys.onWidgetGet(key, (request) => app.getWidget(key, request));
    gladys.onWidgetAction(key, (a, p, c) => app.widgetAction(key, a, p, c));
  }
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());
  gladys.onAction(ACTIONS.UNLINK, () => app.unlink());
  gladys.onConfigUpdated((c) => app.configUpdated(c));
  return { app, gladys, timers, clock, state, tado };
}

const feature = (device, key) => ({ external_id: `${device}:${key}` });

test('not linked: the status says so and nothing is read', async () => {
  const { app, gladys } = setup({ config: {} });
  await app.start({});
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.fr, /Aucun compte tado/);
  assert.equal(fake.calls.length, 0);
});

test('linked: discovers the home and zones, publishes devices and states, schedules the refresh', async () => {
  const { app, gladys, timers } = setup();
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  // The refresh token was rotated and persisted off-schema.
  assert.equal(gladys.fake.config[TOKEN_KEYS.REFRESH], 'ref1');
  const devices = gladys.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((d) => d.external_id),
    [HOME, SALON, 'ext:tado:zone:1234:2', WATER],
  );
  const salon = devices.find((d) => d.external_id === SALON);
  assert.equal(salon.name, 'tado° Salon');
  assert.deepEqual(
    salon.features.map((f) => f.external_id.split(':').at(-1)),
    [
      'target_temperature',
      'mode',
      'operating_state',
      'heating_power',
      'temperature',
      'humidity',
      'open_window',
      'low_battery',
    ],
  );
  const water = devices.find((d) => d.external_id === WATER);
  assert.deepEqual(
    water.features.map((f) => f.external_id.split(':').at(-1)),
    ['power', 'mode', 'low_battery'],
  );
  assert.equal(gladys.fake.lastState(`${SALON}:target_temperature`), 21.5);
  assert.equal(gladys.fake.lastState(`${SALON}:mode`), 1, 'manual');
  assert.equal(gladys.fake.lastState(`${SALON}:operating_state`), 1, 'heating');
  assert.equal(gladys.fake.lastState(`${SALON}:temperature`), 20.4);
  assert.equal(gladys.fake.lastState(`${SALON}:low_battery`), 1);
  assert.equal(gladys.fake.lastState(`${SALON}:open_window`), 1, 'closed');
  assert.equal(gladys.fake.lastState('ext:tado:zone:1234:2:mode'), 3, 'schedule');
  assert.equal(gladys.fake.lastState(`${WATER}:power`), 0);
  assert.equal(gladys.fake.lastState(`${HOME}:presence`), 1);
  assert.equal(gladys.fake.lastState(`${HOME}:presence_mode`), 'auto');
  assert.equal(gladys.fake.lastState(`${HOME}:outside_temperature`), 12.3);
  assert.equal(gladys.fake.lastState(`${HOME}:weather`), 'CLOUDY_PARTLY');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(gladys.fake.connectionStatus.message.en, /1 home, 3 zones/);
  // Free tier assumed (no rate-limit header in the fixtures): 7 calls spent
  // (me, home, zones, capabilities, zoneStates, state, weather), 93 left, 20
  // kept for the commands, 2 calls a reading, spread over the 22 h until
  // 12:00 Berlin.
  assert.equal(timers.timeouts().length, 1);
  assert.equal(timers.timeouts()[0].ms, Math.ceil((22 * 3600_000) / (73 / 2)));
  // No scene event on the first reading.
  assert.equal(gladys.fake.sceneEvents.length, 0);
  app.stop();
  assert.equal(timers.pending.size, 0);
});

test('a refresh fires the scene events of the transitions', async () => {
  const { app, gladys, timers, state } = setup();
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  state.presence = v2.homeState('AWAY', true);
  state.zones = v2.zoneStates({
    1: { openWindowDetected: true, activityDataPoints: { heatingPower: { percentage: 0 } } },
    2: { activityDataPoints: { heatingPower: { percentage: 30 } } },
  });
  await timers.runTimeouts();
  const keys = gladys.fake.sceneEvents.map((e) => e.key);
  assert.deepEqual(
    keys.sort(),
    [
      SCENE_TRIGGERS.HEATING_CHANGED,
      SCENE_TRIGGERS.HEATING_CHANGED,
      SCENE_TRIGGERS.OPEN_WINDOW,
      SCENE_TRIGGERS.PRESENCE_CHANGED,
    ].sort(),
  );
  const presence = gladys.fake.sceneEvents.find((e) => e.key === SCENE_TRIGGERS.PRESENCE_CHANGED);
  assert.deepEqual(presence.data, {
    device: HOME,
    presence: 'away',
    previous: 'home',
    locked: true,
  });
  const window = gladys.fake.sceneEvents.find((e) => e.key === SCENE_TRIGGERS.OPEN_WINDOW);
  assert.equal(window.data.device, SALON);
  assert.equal(gladys.fake.lastState(`${SALON}:open_window`), 0, 'open');
  assert.equal(gladys.fake.lastState(`${HOME}:presence_mode`), 'away');
  // A second identical reading fires nothing more.
  await timers.runTimeouts();
  assert.equal(gladys.fake.sceneEvents.length, 4);
});

test('commands: setpoint, schedule, off, presence', async () => {
  const { app, gladys } = setup();
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  const salon = gladys.fake.discoveredDevices.find((d) => d.external_id === SALON);
  const home = gladys.fake.discoveredDevices.find((d) => d.external_id === HOME);
  const before = fake.calls.length;
  await gladys.fake.setValue(salon, feature(SALON, 'target_temperature'), 19);
  const overlay = fake.calls.find((c, i) => i >= before && c.method === 'PUT');
  assert.match(overlay.url, /\/zones\/1\/overlay$/);
  assert.deepEqual(overlay.body, {
    setting: { type: 'HEATING', power: 'ON', temperature: { celsius: 19 } },
    termination: { typeSkillBasedApp: 'NEXT_TIME_BLOCK' },
  });
  await gladys.fake.setValue(salon, feature(SALON, 'mode'), 3);
  assert.ok(fake.calls.some((c) => c.method === 'DELETE' && /zones\/1\/overlay/.test(c.url)));
  await gladys.fake.setValue(salon, feature(SALON, 'mode'), 0);
  assert.deepEqual(
    fake.calls.at(-5).body?.setting ?? fake.calls.findLast((c) => c.method === 'PUT').body.setting,
    {
      type: 'HEATING',
      power: 'OFF',
    },
  );
  await gladys.fake.setValue(home, feature(HOME, 'presence_mode'), 'away');
  const lock = fake.calls.findLast((c) => /presenceLock/.test(c.url));
  assert.equal(lock.method, 'PUT');
  assert.deepEqual(lock.body, { homePresence: 'AWAY' });
  await gladys.fake.setValue(home, feature(HOME, 'presence_mode'), 'auto');
  assert.equal(fake.calls.findLast((c) => /presenceLock/.test(c.url)).method, 'DELETE');
  const bad = await gladys.fake.setValue(salon, feature(SALON, 'humidity'), 1);
  assert.equal(bad.success, false);
});

test('scene actions', async () => {
  const { app, gladys } = setup();
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  const set = await gladys.fake.sceneAction(SCENE_ACTIONS.SET_TEMPERATURE, {
    device: SALON,
    temperature: 22,
    termination: 'timer',
    minutes: 45,
  });
  assert.equal(set.success, true);
  assert.equal(set.data.outputs.zone, 'Salon');
  const put = fake.calls.findLast((c) => c.method === 'PUT');
  assert.deepEqual(put.body.termination, { typeSkillBasedApp: 'TIMER', durationInSeconds: 2700 });
  const resume = await gladys.fake.sceneAction(SCENE_ACTIONS.RESUME_SCHEDULE, { device: SALON });
  assert.equal(resume.success, true);
  const presence = await gladys.fake.sceneAction(SCENE_ACTIONS.SET_PRESENCE, {
    device: HOME,
    presence: 'home',
  });
  assert.equal(presence.success, true);
  assert.deepEqual(fake.calls.findLast((c) => /presenceLock/.test(c.url)).body, {
    homePresence: 'HOME',
  });
  const read = await gladys.fake.sceneAction(SCENE_ACTIONS.GET_ZONE, { device: SALON });
  assert.equal(read.data.outputs.temperature, 20.4);
  assert.equal(read.data.outputs.heating, true);
  assert.equal(read.data.outputs.mode, 'manual');
  const wrong = await gladys.fake.sceneAction(SCENE_ACTIONS.GET_ZONE, { device: HOME });
  assert.equal(wrong.success, false);
});

test('widgets', async () => {
  const { app, gladys } = setup();
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  const zone = (
    await gladys.fake.widgetGet(WIDGETS.ZONE, { settings: { device: SALON }, language: 'fr' })
  ).data.content;
  assert.equal(zone.components[0].text, 'Salon');
  const tiles = zone.components.filter((c) => c.type === 'value' || c.type === 'gauge');
  assert.equal(tiles.length, 4);
  assert.equal(tiles[0].device_feature, `${SALON}:temperature`);
  const status = zone.components.find((c) => c.type === 'status');
  assert.equal(status.items[0].value, 'Minuterie');
  assert.ok(status.items.some((i) => i.label.fr === 'Batterie faible'));
  const buttons = zone.components.filter((c) => c.type === 'button');
  assert.deepEqual(
    buttons.map((b) => b.action.key),
    ['target', 'target', 'resume', 'off'],
  );
  assert.equal(buttons[1].action.params.target, 22);
  const tap = await gladys.fake.widgetAction(
    WIDGETS.ZONE,
    'target',
    { target: 22 },
    { settings: { device: SALON } },
  );
  assert.match(tap.data.message.en, /Done/);
  assert.equal(fake.calls.findLast((c) => c.method === 'PUT').body.setting.temperature.celsius, 22);
  const home = (await gladys.fake.widgetGet(WIDGETS.HOME, { settings: { device: HOME } })).data
    .content;
  assert.equal(
    home.components.filter((c) => c.type === 'value').length,
    3,
    'outside + 2 heating zones',
  );
  assert.match(home.components.find((c) => c.type === 'status').items[0].value, /Home/);
  const none = (await gladys.fake.widgetGet(WIDGETS.ZONE, { settings: {} })).data.content;
  assert.match(none.components[0].text.en, /Pick a zone/);
});

test('account linking through the device-code flow', async () => {
  let approved = false;
  const routes = v2Routes();
  routes.unshift(
    [
      'POST',
      /device_authorize/,
      () =>
        json({
          device_code: 'dc',
          user_code: 'ABC',
          verification_uri_complete: 'https://login.tado.com/oauth2/device?user_code=ABC',
          interval: 5,
          expires_in: 300,
        }),
    ],
    [
      'POST',
      /oauth2\/token/,
      (call) =>
        call.body.grant_type?.endsWith('device_code') && !approved
          ? json({ error: 'authorization_pending' }, 400)
          : json(v2.tokens),
    ],
  );
  const { app, gladys, timers, clock } = setup({ config: {}, routes });
  await app.start({});
  const ack = await gladys.fake.oauthAuthorizeUrl(CONFIG_KEYS.ACCOUNT);
  assert.equal(ack.success, true);
  assert.match(ack.data.url ?? JSON.stringify(ack.data), /user_code=ABC/);
  assert.match(gladys.fake.connectionStatus.message.en, /Waiting for your approval/);
  assert.equal(timers.timeouts().length, 1);
  await timers.runTimeouts(); // still pending
  assert.equal(gladys.fake.connectionStatus.connected, false);
  approved = true;
  await timers.runTimeouts();
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(gladys.fake.config[TOKEN_KEYS.REFRESH], 'ref1');
  assert.equal(gladys.fake.discoveredDevices.length, 4);
  // An expired flow stops polling and says so.
  approved = false;
  await gladys.fake.oauthAuthorizeUrl(CONFIG_KEYS.ACCOUNT);
  clock.now = NOW + 400_000;
  await timers.runTimeouts();
  assert.match(gladys.fake.connectionStatus.message.en, /link expired/);
});

test('an expired session stops the refresh and asks to link again', async () => {
  const routes = v2Routes();
  routes.unshift(['POST', /oauth2\/token/, () => json({ error: 'invalid_grant' }, 400)]);
  const { app, gladys, timers } = setup({ routes });
  await app.start({ [TOKEN_KEYS.REFRESH]: 'stale' });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /link the account again/);
  assert.equal(timers.pending.size, 0, 'no refresh scheduled');
  const unlink = await gladys.fake.action(ACTIONS.UNLINK);
  assert.match(unlink.data.message.en, /unlinked/);
  assert.equal(gladys.fake.config[TOKEN_KEYS.REFRESH], '');
});

test('a config update that only rotated the token does not restart', async () => {
  const { app, gladys } = setup();
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  const calls = fake.calls.length;
  await gladys.fake.configUpdated({ [TOKEN_KEYS.REFRESH]: 'ref1' });
  assert.equal(fake.calls.length, calls);
  await gladys.fake.configUpdated({ [TOKEN_KEYS.REFRESH]: 'ref1', refresh_interval: 300 });
  assert.equal(app.config.refreshInterval, 300, 'a real change restarts');
  assert.equal(fake.calls.length, calls, 'the homes are known: no reading out of turn');
  assert.notEqual(
    configFingerprint({ a: 1, [TOKEN_KEYS.REFRESH]: 'x' }),
    configFingerprint({ a: 2 }),
  );
});

test('a tado X home reads rooms through hops', async () => {
  const routes = [
    ['POST', /oauth2\/token/, () => json(v2.tokens)],
    ['GET', /\/api\/v2\/me$/, () => json({ ...v2.me, homes: [{ id: 5678, name: 'Loft' }] })],
    ...xRoutes(),
  ];
  const { app, gladys } = setup({ routes });
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  const room = 'ext:tado:zone:5678:7';
  assert.equal(gladys.fake.lastState(`${room}:temperature`), 22.1);
  assert.equal(gladys.fake.lastState(`${room}:target_temperature`), 23);
  assert.equal(gladys.fake.lastState(`${room}:mode`), 3);
  const device = gladys.fake.discoveredDevices.find((d) => d.external_id === room);
  await gladys.fake.setValue(device, feature(room, 'target_temperature'), 21);
  const post = fake.calls.findLast((c) => /manualControl/.test(c.url));
  assert.deepEqual(post.body, {
    setting: { power: 'ON', temperature: { value: 21 } },
    termination: { type: 'NEXT_TIME_BLOCK' },
  });
  await gladys.fake.setValue(device, feature(room, 'mode'), 3);
  assert.ok(fake.calls.some((c) => /resumeSchedule/.test(c.url)));
});

test('the phones become presence sensors when asked', async () => {
  const { app, gladys } = setup();
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0', track_phones: true });
  const phone = 'ext:tado:phone:1234:11';
  assert.ok(gladys.fake.discoveredDevices.some((d) => d.external_id === phone));
  assert.equal(gladys.fake.lastState(`${phone}:at_home`), 1);
});

test('the test button', async () => {
  const { app, gladys } = setup();
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  const ack = await gladys.fake.action(ACTIONS.TEST);
  assert.match(ack.data.message.en, /jane@example.com: Maison/);
});

// --- tado's daily quota ------------------------------------------------------------

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** 12:00 in Berlin the day after NOW (10:00 UTC in October). */
const RESET = Date.parse('2026-10-14T10:00:00Z');

/**
 * A fake tado counting the requests per day like the real one: `quota` per
 * day, reset at 12:00 Berlin, the budget in the headers of every API answer
 * (login.tado.com excepted) and a 429 once it is used up.
 */
function withQuota(clock, base, { quota = 100, remaining = quota, late = 0, noT = false } = {}) {
  const tado = { quota, remaining, resetAt: RESET + late, calls: [], refused: 0 };
  while (tado.resetAt - DAY > clock.now) {
    tado.resetAt -= DAY;
  }
  const routes = base.map(([method, pattern, handler]) => [
    method,
    pattern,
    async (call) => {
      if (/oauth2/.test(call.url)) {
        return handler(call);
      }
      while (clock.now >= tado.resetAt) {
        tado.remaining = tado.quota;
        tado.resetAt += DAY;
      }
      tado.calls.push({ at: clock.now, url: call.url, method: call.method });
      const t = noT ? '' : `;t=${Math.ceil((tado.resetAt - clock.now) / 1000)}`;
      const policy = `"perday";q=${tado.quota};w=86400`;
      if (tado.remaining <= 0) {
        tado.refused += 1;
        return json({ errors: [{ code: 'tooManyRequests' }] }, 429, {
          'ratelimit-policy': policy,
          ratelimit: `"perday";r=0${t}`,
        });
      }
      tado.remaining -= 1;
      const response = await handler(call);
      response.headers.set('ratelimit-policy', policy);
      response.headers.set('ratelimit', `"perday";r=${tado.remaining}${t}`);
      return response;
    },
  ]);
  return { tado, routes };
}

/** Let the fake time run: the next timeout fires at its time, until `until`. */
async function runUntil(timers, clock, until) {
  for (;;) {
    const [next] = timers.timeouts();
    if (!next || clock.now + next.ms > until) {
      return;
    }
    clock.now += next.ms;
    await timers.runTimeouts();
  }
}

const callsIn = (tado, from, to = from + DAY) =>
  tado.calls.filter((c) => c.at >= from && c.at < to);

test('free tier: a whole day of readings stays under the quota, with the reserve kept', async () => {
  for (const trackPhones of [false, true]) {
    const { app, gladys, timers, clock, tado } = setup({ quota: {} });
    await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0', track_phones: trackPhones });
    // Three days: the first one starts at 14:00, count the second one.
    await runUntil(timers, clock, RESET + 2 * DAY);
    const inDay = callsIn(tado, RESET);
    const readings = inDay.filter((c) => /homes\/1234\/state$/.test(c.url)).length;
    if (process.env.DEBUG_TEST) {
      console.error({ trackPhones, calls: inDay.length, readings });
    }
    assert.ok(inDay.length <= 80, `${inDay.length} calls (phones ${trackPhones})`);
    assert.ok(inDay.length >= 70, `the budget is used: ${inDay.length} calls`);
    assert.ok(readings >= (trackPhones ? 20 : 30), `${readings} readings`);
    assert.ok(
      inDay.filter((c) => /weather$/.test(c.url)).length <= 9,
      'the weather every 3 hours on a free account',
    );
    assert.equal(tado.refused, 0, 'no 429');
    assert.equal(gladys.fake.connectionStatus.connected, true);
    assert.ok(timers.timeouts()[0].ms >= 120_000);
    app.stop();
    fake.restore();
  }
});

test('free tier with two homes, one of them tado X: under the quota too', async () => {
  const routes = [
    [
      'GET',
      /\/api\/v2\/me$/,
      () =>
        json({
          ...v2.me,
          homes: [
            { id: 1234, name: 'Maison' },
            { id: 5678, name: 'Loft' },
          ],
        }),
    ],
    ...v2Routes(),
    ...xRoutes(),
  ];
  const { app, timers, clock, tado } = setup({ routes, quota: {} });
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  assert.ok(
    tado.calls.some((c) => /hops.*rooms$/.test(c.url)),
    'hops answers are counted',
  );
  await runUntil(timers, clock, RESET + 2 * DAY);
  const inDay = callsIn(tado, RESET);
  const classic = inDay.filter((c) => /homes\/1234\/state$/.test(c.url)).length;
  const loft = inDay.filter((c) => /homes\/5678\/state$/.test(c.url)).length;
  if (process.env.DEBUG_TEST) {
    console.error({ homes: 2, calls: inDay.length, readings: classic });
  }
  assert.ok(inDay.length <= 80 && inDay.length >= 65, `${inDay.length} calls`);
  assert.equal(classic, loft, 'both homes read at each reading');
  assert.ok(classic >= 14, `${classic} readings`);
  assert.equal(tado.refused, 0);
  app.stop();
});

test('subscription: the user interval applies, the weather every 15 minutes', async () => {
  const { app, timers, clock, tado } = setup({ quota: { quota: 20_000 } });
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  assert.equal(timers.timeouts()[0].ms, 120_000);
  await runUntil(timers, clock, NOW + HOUR);
  // Readings every 2 minutes, the weather once 15 minutes passed: 0, 16, 32, 48.
  assert.equal(tado.calls.filter((c) => /weather$/.test(c.url)).length, 4);
  assert.equal(tado.calls.filter((c) => /homes\/1234\/state$/.test(c.url)).length, 31);
  app.stop();
});

test('without a policy header, a large remaining count means a subscription', async () => {
  const routes = v2Routes().map(([m, p, h]) => [
    m,
    p,
    async (call) => {
      const response = await h(call);
      response.headers.set('ratelimit', '"perday";r=19500');
      return response;
    },
  ]);
  const { app, timers } = setup({ routes });
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  assert.equal(app.budget.subscribed, true);
  assert.equal(timers.timeouts()[0].ms, 120_000);
  app.stop();
});

/** The classic home with a zoneStates answer under the test's control. */
function zoneStatesRoutes(answer) {
  const routes = v2Routes();
  routes.unshift(['GET', /\/homes\/1234\/zoneStates$/, () => answer()]);
  return routes;
}

const OK_HEADERS = { ratelimit: '"perday";r=60;t=7200' };

test('a 429 pauses the readings until the reset, says so, then resumes', async () => {
  let exhausted = false;
  const { app, gladys, timers, clock } = setup({
    routes: zoneStatesRoutes(() =>
      exhausted
        ? json({ errors: [] }, 429, { ratelimit: '"perday";r=0;t=3600' })
        : json(v2.zoneStates(), 200, OK_HEADERS),
    ),
  });
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  exhausted = true;
  const apiCalls = () => fake.calls.filter((c) => !/oauth2/.test(c.url)).length;
  const before = apiCalls();
  clock.now += timers.timeouts()[0].ms;
  await timers.runTimeouts();
  // One call (the 429), no other read, no tight retry.
  assert.equal(apiCalls() - before, 1);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /daily API quota used up.*resume/);
  assert.match(gladys.fake.connectionStatus.message.fr, /Quota quotidien.*reprennent/);
  const [pause] = timers.timeouts();
  assert.equal(timers.timeouts().length, 1);
  assert.equal(pause.ms, HOUR + 60_000, 'until t=, plus a margin');
  // A config save or a reconnection to Gladys during the pause reads nothing.
  await gladys.fake.configUpdated({ [TOKEN_KEYS.REFRESH]: 'ref1', refresh_interval: 300 });
  app.stop();
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref1', refresh_interval: 300 });
  assert.equal(apiCalls() - before, 1);
  assert.equal(timers.timeouts()[0].ms, HOUR + 60_000);
  // The reset: readings come back by themselves.
  exhausted = false;
  clock.now += timers.timeouts()[0].ms;
  await timers.runTimeouts();
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(gladys.fake.connectionStatus.message.en, /Connected/);
  assert.ok(timers.timeouts()[0].ms < pause.ms);
  app.stop();
});

test('a huge t= or a far Retry-After never makes a tight loop', async () => {
  for (const headers of [
    { ratelimit: '"perday";r=0;t=9999999' },
    { ratelimit: '"perday";r=0', 'retry-after': 'Fri, 01 Jan 2100 00:00:00 GMT' },
  ]) {
    let exhausted = false;
    const { app, timers, clock } = setup({
      routes: zoneStatesRoutes(() =>
        exhausted ? json({}, 429, headers) : json(v2.zoneStates(), 200, OK_HEADERS),
      ),
    });
    await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
    exhausted = true;
    clock.now += timers.timeouts()[0].ms;
    await timers.runTimeouts();
    assert.equal(timers.timeouts()[0].ms, 25 * HOUR, 'armed at most 25 h ahead');
    // At 25 h the pause (capped at 2 days) still runs: armed again for the rest.
    const calls = fake.calls.length;
    clock.now += timers.timeouts()[0].ms;
    await timers.runTimeouts();
    assert.equal(fake.calls.length, calls, 'no request while paused');
    assert.ok(timers.timeouts()[0].ms > 20 * HOUR);
    app.stop();
    fake.restore();
  }
});

test('a 429 without a time just after the expected reset: a short pause', async () => {
  let exhausted = false;
  const { app, gladys, timers, clock } = setup({
    now: Date.parse('2026-10-14T09:00:00Z'), // 11:00 in Berlin
    routes: zoneStatesRoutes(() =>
      exhausted ? json({}, 429, { ratelimit: '"perday";r=0' }) : json(v2.zoneStates()),
    ),
  });
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  exhausted = true;
  clock.now = Date.parse('2026-10-14T10:06:00Z'); // 12:06: tado has not reset yet
  timers.pending.clear();
  await app.cycle();
  assert.equal(timers.timeouts()[0].ms, 15 * 60_000 + 60_000);
  assert.match(gladys.fake.connectionStatus.message.en, /turning requests away for now/);
  assert.match(gladys.fake.connectionStatus.message.fr, /refuse les requêtes pour le moment/);
  // Still refused: a longer pause, never a whole day.
  clock.now += timers.timeouts()[0].ms;
  await timers.runTimeouts();
  assert.ok(timers.timeouts()[0].ms > 16 * 60_000 && timers.timeouts()[0].ms < 2 * HOUR);
  app.stop();
});

test('commands are sent while the readings are throttled, and their state shows', async () => {
  // 28 left: the start-up costs 7 (discovery + a reading), 21 stay, one
  // above the reserve of 20: not enough for a reading of 2 calls.
  const { app, gladys, timers, tado } = setup({ quota: { remaining: 28 } });
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(gladys.fake.connectionStatus.message.en, /readings paused until/);
  assert.match(gladys.fake.connectionStatus.message.fr, /lectures suspendues/);
  assert.ok(timers.timeouts()[0].ms > 20 * HOUR, 'next reading after the reset');
  // A config save at the reserve reads nothing.
  const atSave = tado.calls.length;
  await gladys.fake.configUpdated({ [TOKEN_KEYS.REFRESH]: 'ref1', track_phones: false, x: 1 });
  assert.equal(tado.calls.length, atSave);
  const salon = gladys.fake.discoveredDevices.find((d) => d.external_id === SALON);
  const home = gladys.fake.discoveredDevices.find((d) => d.external_id === HOME);
  const before = tado.calls.length;
  const ack = await gladys.fake.setValue(salon, feature(SALON, 'target_temperature'), 19);
  assert.equal(ack.success, true);
  const sent = tado.calls.slice(before);
  assert.equal(sent[0].method, 'PUT');
  // At the reserve: no extra reading after the command...
  assert.equal(sent.length, 1);
  // ...but Gladys shows what was set (the devices have feedback).
  assert.equal(gladys.fake.lastState(`${SALON}:target_temperature`), 19);
  assert.equal(gladys.fake.lastState(`${SALON}:mode`), 1, 'manual');
  await gladys.fake.setValue(salon, feature(SALON, 'mode'), 0);
  assert.equal(gladys.fake.lastState(`${SALON}:mode`), 0, 'off');
  await gladys.fake.setValue(home, feature(HOME, 'presence_mode'), 'away');
  assert.equal(gladys.fake.lastState(`${HOME}:presence_mode`), 'away');
  assert.equal(gladys.fake.lastState(`${HOME}:presence`), 0);
  assert.equal(tado.calls.length - before, 3, 'three commands, no reading');
  app.stop();
});

test('a stop while the status is being set leaves no timer armed', async () => {
  const { app, gladys, timers } = setup({ quota: { remaining: 28 } });
  const original = gladys.setConnectionStatus.bind(gladys);
  gladys.setConnectionStatus = async (connected, message) => {
    if (/readings paused/.test(message?.en ?? '')) {
      app.stop();
    }
    return original(connected, message);
  };
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  assert.match(gladys.fake.connectionStatus.message.en, /readings paused/);
  assert.equal(timers.pending.size, 0);
});

test('a command refused with a 429 fails with a clear message', async () => {
  const { app, gladys, timers, tado } = setup({ quota: {} });
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  tado.remaining = 0;
  const salon = gladys.fake.discoveredDevices.find((d) => d.external_id === SALON);
  const ack = await gladys.fake.setValue(salon, feature(SALON, 'target_temperature'), 19);
  assert.equal(ack.success, false);
  assert.match(ack.error, /daily API quota is used up until .* \/ .*quota quotidien/);
  assert.match(gladys.fake.connectionStatus.message.en, /daily API quota used up/);
  // The poller waits for the reset (12:00 Berlin = 10:00 UTC tomorrow).
  assert.equal(timers.timeouts()[0].ms, RESET - NOW + 60_000);
  const tap = await gladys.fake.widgetAction(
    WIDGETS.ZONE,
    'target',
    { target: 22 },
    { settings: { device: SALON } },
  );
  assert.match(tap.data.message.en, /refused the command/);
  assert.match(tap.data.message.fr, /a refusé la commande/);
  const scene = await gladys.fake.sceneAction(SCENE_ACTIONS.SET_TEMPERATURE, {
    device: SALON,
    temperature: 20,
  });
  assert.equal(scene.success, false);
  app.stop();
});

test('a burst 429 (budget left) says "for now", not "daily quota"', async () => {
  const routes = v2Routes();
  routes.unshift([
    'PUT',
    /\/zones\/1\/overlay$/,
    () => json({}, 429, { ratelimit: '"perday";r=50', 'retry-after': '60' }),
  ]);
  const { app, gladys, timers } = setup({ routes });
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  const salon = gladys.fake.discoveredDevices.find((d) => d.external_id === SALON);
  const ack = await gladys.fake.setValue(salon, feature(SALON, 'target_temperature'), 19);
  assert.equal(ack.success, false);
  assert.match(ack.error, /refused the command for now .* \/ .*pour le moment/);
  assert.doesNotMatch(gladys.fake.connectionStatus.message.en, /daily/);
  assert.match(gladys.fake.connectionStatus.message.en, /for now/);
  assert.equal(timers.timeouts()[0].ms, 120_000, 'Retry-After 60 s, the user interval');
  app.stop();
});

test('a command that goes through lifts the pause', async () => {
  let exhausted = false;
  const routes = zoneStatesRoutes(() =>
    exhausted
      ? json({}, 429, { ratelimit: '"perday";r=0;t=7200' })
      : json(v2.zoneStates(), 200, OK_HEADERS),
  );
  routes.unshift(['PUT', /\/zones\/1\/overlay$/, (call) => json(call.body, 200, OK_HEADERS)]);
  const { app, gladys, timers, clock } = setup({ routes });
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  exhausted = true;
  clock.now += timers.timeouts()[0].ms;
  await timers.runTimeouts();
  assert.equal(timers.timeouts()[0].ms, 2 * HOUR + 60_000);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  exhausted = false; // tado reset early
  const salon = gladys.fake.discoveredDevices.find((d) => d.external_id === SALON);
  const ack = await gladys.fake.setValue(salon, feature(SALON, 'target_temperature'), 19);
  assert.equal(ack.success, true);
  assert.equal(app.pausedUntil, 0);
  assert.ok(timers.timeouts()[0].ms < HOUR, 'readings rescheduled from the budget');
  assert.equal(timers.timeouts().length, 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  app.stop();
});

test('a 429 is never swallowed by a best-effort read', async (t) => {
  const limited = () => json({}, 429, { ratelimit: '"perday";r=0;t=3600' });
  for (const [name, pattern] of [
    ['home detail', /\/homes\/1234$/],
    ['hot water capabilities', /\/zones\/3\/capabilities$/],
  ]) {
    await t.test(name, async () => {
      const routes = v2Routes();
      routes.unshift(['GET', pattern, limited]);
      const { app, gladys, timers } = setup({ routes });
      await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
      assert.match(gladys.fake.connectionStatus.message.en, /daily API quota used up/);
      assert.equal(timers.timeouts()[0].ms, HOUR + 60_000);
      assert.ok(!fake.calls.some((c) => /zoneStates/.test(c.url)), 'stopped at the 429');
      app.stop();
      fake.restore();
    });
  }
  await t.test('weather: the reading is published, then the pause', async () => {
    const routes = v2Routes();
    routes.unshift(['GET', /\/weather$/, limited]);
    const { app, gladys, timers } = setup({ routes, config: {} });
    await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0', track_phones: true });
    assert.equal(gladys.fake.lastState(`${SALON}:temperature`), 20.4);
    assert.ok(!fake.calls.some((c) => /mobileDevices/.test(c.url)), 'no call after the 429');
    assert.match(gladys.fake.connectionStatus.message.en, /daily API quota used up/);
    assert.equal(timers.timeouts()[0].ms, HOUR + 60_000);
    app.stop();
  });
});

test('a manual scan hitting the quota pauses the loop like a reading', async () => {
  let exhausted = false;
  const { app, gladys, timers } = setup({
    routes: zoneStatesRoutes(() =>
      exhausted
        ? json({}, 429, { ratelimit: '"perday";r=0;t=3600' })
        : json(v2.zoneStates(), 200, OK_HEADERS),
    ),
  });
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  exhausted = true;
  const ack = await gladys.fake.scanRequest().catch((err) => err);
  assert.ok(ack === undefined || ack instanceof Error || ack?.success === false);
  assert.match(gladys.fake.connectionStatus.message.en, /daily API quota used up/);
  assert.equal(timers.timeouts()[0].ms, HOUR + 60_000);
  assert.equal(timers.timeouts().length, 1);
  app.stop();
});

test('no answer at all (network down): retried soon, the budget untouched', async () => {
  let down = true;
  const routes = v2Routes().map(([m, p, h]) => [
    m,
    p,
    (call) => {
      if (down && !/oauth2/.test(call.url)) {
        throw new TypeError('fetch failed');
      }
      return h(call);
    },
  ]);
  const { app, gladys, timers, clock } = setup({ routes });
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  assert.match(gladys.fake.connectionStatus.message.en, /unreachable/);
  assert.equal(timers.timeouts()[0].ms, 120_000, 'refresh_interval');
  clock.now += 120_000;
  await timers.runTimeouts();
  assert.equal(timers.timeouts()[0].ms, 240_000, 'doubling');
  down = false;
  clock.now += 240_000;
  await timers.runTimeouts();
  assert.equal(gladys.fake.connectionStatus.connected, true);
  const paced = timers.timeouts()[0].ms;
  assert.ok(paced > 20 * 60_000, 'back to the budget pace');
  // A reading failing without an answer later on: retried at the user interval.
  down = true;
  clock.now += paced;
  await timers.runTimeouts();
  assert.equal(timers.timeouts()[0].ms, 120_000);
  app.stop();
});

test('login.tado.com refusing for now (429, network) does not ask to link again', async () => {
  let login = '429';
  const routes = v2Routes();
  routes.unshift([
    'POST',
    /oauth2\/token/,
    () => {
      if (login === 'net') {
        throw new TypeError('fetch failed');
      }
      return login === '429' ? json({}, 429, { 'retry-after': '600' }) : json(v2.tokens);
    },
  ]);
  const { app, gladys, timers, clock } = setup({ routes });
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  assert.doesNotMatch(gladys.fake.connectionStatus.message.en, /link the account again/);
  assert.match(gladys.fake.connectionStatus.message.en, /for now/);
  assert.equal(timers.timeouts()[0].ms, 600_000 + 60_000);
  login = 'net';
  clock.now += timers.timeouts()[0].ms;
  await timers.runTimeouts();
  assert.match(gladys.fake.connectionStatus.message.en, /unreachable/);
  assert.equal(timers.timeouts()[0].ms, 120_000);
  login = 'ok';
  clock.now += 120_000;
  await timers.runTimeouts();
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(gladys.fake.config[TOKEN_KEYS.REFRESH], 'ref1');
  app.stop();
});

test('unlink then link again: the client keeps counting in the same budget', async () => {
  const routes = v2Routes();
  routes.unshift([
    'POST',
    /device_authorize/,
    () =>
      json({
        device_code: 'dc',
        user_code: 'ABC',
        verification_uri_complete: 'https://login.tado.com/oauth2/device?user_code=ABC',
        interval: 5,
        expires_in: 300,
      }),
  ]);
  const { app, gladys, timers, clock, tado } = setup({ routes, quota: {} });
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  await runUntil(timers, clock, NOW + 3 * HOUR);
  await gladys.fake.action(ACTIONS.UNLINK);
  assert.equal(app.budget.left(), 100, 'forgotten');
  await gladys.fake.oauthAuthorizeUrl(CONFIG_KEYS.ACCOUNT);
  clock.now += 5000;
  await timers.runTimeouts(); // approved at once: discovery and a reading
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(app.client.budget, app.budget);
  assert.equal(app.budget.left(), tado.remaining, 'the budget follows tado again');
  await runUntil(timers, clock, RESET + 2 * DAY);
  const inDay = callsIn(tado, RESET);
  assert.ok(inDay.length <= 80, `${inDay.length} calls`);
  assert.equal(tado.refused, 0, 'no 429');
  app.stop();
});

test('a stop during a reading does not start the loop again', async () => {
  const { app, timers } = setup();
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  const [next] = timers.timeouts();
  timers.pending.delete(next.id);
  const reading = next.fn();
  app.stop();
  await reading;
  assert.equal(timers.pending.size, 0);
});

// --- Round 3: resume, pauses, deferred discovery, error kinds ------------------

const SCHEDULE_18 = {
  1: {
    overlayType: null,
    overlay: null,
    setting: { type: 'HEATING', power: 'ON', temperature: { celsius: 18 } },
  },
};

test('a resume at the reserve still re-reads: tado says what the schedule applies', async () => {
  const { app, gladys, tado, state } = setup({ quota: { remaining: 28 } });
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  assert.match(gladys.fake.connectionStatus.message.en, /readings paused/, 'at the reserve');
  const water = gladys.fake.discoveredDevices.find((d) => d.external_id === WATER);
  const salon = gladys.fake.discoveredDevices.find((d) => d.external_id === SALON);
  // Hot water whose schedule is OFF: resumed, it must stay off in Gladys.
  let before = tado.calls.length;
  assert.equal((await gladys.fake.setValue(water, feature(WATER, 'mode'), 1)).success, true);
  assert.ok(
    tado.calls.slice(before).some((c) => /zoneStates/.test(c.url)),
    're-read',
  );
  assert.equal(gladys.fake.lastState(`${WATER}:power`), 0);
  // Heating back to its schedule: the schedule's target, not the old manual one.
  state.zones = v2.zoneStates(SCHEDULE_18);
  before = tado.calls.length;
  assert.equal((await gladys.fake.setValue(salon, feature(SALON, 'mode'), 3)).success, true);
  assert.equal(tado.calls.length - before, 2, 'DELETE, then zoneStates only');
  assert.equal(gladys.fake.lastState(`${SALON}:target_temperature`), 18);
  assert.equal(gladys.fake.lastState(`${SALON}:mode`), 3);
  app.stop();
});

test('a resume leaving no request at all: no read, the mode only', async () => {
  const { app, gladys, tado } = setup({ quota: {} });
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  const salon = gladys.fake.discoveredDevices.find((d) => d.external_id === SALON);
  const water = gladys.fake.discoveredDevices.find((d) => d.external_id === WATER);
  assert.equal(gladys.fake.lastState(`${SALON}:target_temperature`), 21.5);
  tado.remaining = 1; // the DELETE takes the last request
  let before = tado.calls.length;
  assert.equal((await gladys.fake.setValue(salon, feature(SALON, 'mode'), 3)).success, true);
  assert.equal(tado.calls.length - before, 1, 'no read that could only get a 429');
  assert.equal(gladys.fake.lastState(`${SALON}:mode`), 3, 'schedule');
  assert.equal(gladys.fake.lastState(`${SALON}:target_temperature`), 21.5, 'untouched');
  assert.equal(gladys.fake.connectionStatus.connected, true, 'the resume succeeded');
  // Hot water off: the mode says schedule, the power stays.
  tado.remaining = 1;
  before = tado.calls.length;
  await gladys.fake.setValue(water, feature(WATER, 'mode'), 1);
  assert.equal(tado.calls.length - before, 1);
  assert.equal(gladys.fake.lastState(`${WATER}:power`), 0);
  assert.equal(gladys.fake.lastState(`${WATER}:mode`), 1, 'auto (schedule)');
  app.stop();
});

test('a resume whose re-read is refused publishes the mode only', async () => {
  let exhausted = false;
  const { app, gladys } = setup({
    routes: zoneStatesRoutes(() =>
      exhausted
        ? json({}, 429, { ratelimit: '"perday";r=0;t=3600' })
        : json(v2.zoneStates(), 200, OK_HEADERS),
    ),
  });
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  const salon = gladys.fake.discoveredDevices.find((d) => d.external_id === SALON);
  exhausted = true;
  assert.equal((await gladys.fake.setValue(salon, feature(SALON, 'mode'), 3)).success, true);
  assert.equal(gladys.fake.lastState(`${SALON}:mode`), 3, 'schedule');
  assert.equal(gladys.fake.lastState(`${SALON}:target_temperature`), 21.5, 'untouched');
  assert.match(gladys.fake.connectionStatus.message.en, /daily API quota used up/);
  app.stop();
});

test('a 429 on the re-read after a command: the command succeeded, the loop pauses', async () => {
  let exhausted = false;
  const { app, gladys, timers } = setup({
    routes: zoneStatesRoutes(() =>
      exhausted
        ? json({}, 429, { ratelimit: '"perday";r=0;t=3600' })
        : json(v2.zoneStates(), 200, OK_HEADERS),
    ),
  });
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  const salon = gladys.fake.discoveredDevices.find((d) => d.external_id === SALON);
  exhausted = true; // the PUT passes, the re-read gets the 429
  const ack = await gladys.fake.setValue(salon, feature(SALON, 'target_temperature'), 19);
  assert.equal(ack.success, true);
  assert.ok(fake.calls.some((c) => c.method === 'PUT'));
  assert.equal(gladys.fake.lastState(`${SALON}:target_temperature`), 19);
  assert.match(gladys.fake.connectionStatus.message.en, /daily API quota used up/);
  assert.equal(timers.timeouts()[0].ms, HOUR + 60_000);
  assert.equal(timers.timeouts().length, 1);
  app.stop();
});

test('lifting a pause at the reserve: the status says "almost used", not "Connected"', async () => {
  let exhausted = false;
  const routes = zoneStatesRoutes(() =>
    exhausted
      ? json({}, 429, { ratelimit: '"perday";r=0;t=7200' })
      : json(v2.zoneStates(), 200, OK_HEADERS),
  );
  // tado took the command, with 21 requests left: one above the reserve.
  routes.unshift([
    'PUT',
    /\/zones\/1\/overlay$/,
    (call) => json(call.body, 200, { ratelimit: '"perday";r=21;t=7000' }),
  ]);
  const { app, gladys, timers, clock } = setup({ routes });
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  exhausted = true;
  clock.now += timers.timeouts()[0].ms;
  await timers.runTimeouts();
  const salon = gladys.fake.discoveredDevices.find((d) => d.external_id === SALON);
  assert.equal(
    (await gladys.fake.setValue(salon, feature(SALON, 'target_temperature'), 19)).success,
    true,
  );
  assert.equal(app.pausedUntil, 0);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(gladys.fake.connectionStatus.message.en, /readings paused until/);
  app.stop();
});

test('an error after tado answered is paced by the budget, not retried soon', async () => {
  const { app, gladys, timers } = setup();
  const original = gladys.publishChangedStates.bind(gladys);
  let refuse = false;
  gladys.publishChangedStates = async (...args) => {
    if (refuse) {
      throw new Error('Gladys refused the states');
    }
    return original(...args);
  };
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  const paced = timers.timeouts()[0].ms;
  refuse = true;
  await timers.runTimeouts();
  assert.match(gladys.fake.connectionStatus.message.en, /unreachable/);
  assert.ok(timers.timeouts()[0].ms > 20 * 60_000, 'the budget pace, not 120 s');
  assert.ok(timers.timeouts()[0].ms >= paced * 0.9);
  app.stop();
});

test('a budget pause longer than 25 h: the wake-up reads nothing', async () => {
  const routes = v2Routes().map(([m, p, h]) => [
    m,
    p,
    async (call) => {
      const response = await h(call);
      if (!/oauth2/.test(call.url)) {
        response.headers.set('ratelimit', '"perday";r=21;t=100000'); // reset in 27.8 h
      }
      return response;
    },
  ]);
  const { app, timers, clock } = setup({ routes });
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  assert.equal(timers.timeouts()[0].ms, 25 * HOUR);
  const calls = fake.calls.length;
  clock.now += 25 * HOUR;
  await timers.runTimeouts();
  assert.equal(fake.calls.length, calls, 'no request');
  assert.ok(timers.timeouts()[0].ms < 3 * HOUR && timers.timeouts()[0].ms > 2 * HOUR);
  app.stop();
});

test('a link during a pause: the discovery waits for the end of the pause', async () => {
  let exhausted = false;
  const { app, timers, clock } = setup({
    routes: zoneStatesRoutes(() =>
      exhausted
        ? json({}, 429, { ratelimit: '"perday";r=0;t=3600' })
        : json(v2.zoneStates(), 200, OK_HEADERS),
    ),
  });
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  exhausted = true;
  clock.now += timers.timeouts()[0].ms;
  await timers.runTimeouts();
  const meCalls = () => fake.calls.filter((c) => /\/me$/.test(c.url)).length;
  const before = meCalls();
  const calls = fake.calls.length;
  await app.connectAccount(); // what a new device-code link does
  assert.equal(fake.calls.length, calls, 'nothing read during the pause');
  exhausted = false;
  clock.now += timers.timeouts()[0].ms;
  await timers.runTimeouts();
  assert.equal(meCalls(), before + 1, 'discovered at the end of the pause');
  app.stop();
});

test('a weather failure (not a 429) waits for the next weather slot', async () => {
  const routes = v2Routes();
  routes.unshift(['GET', /\/weather$/, () => json({ error: 'boom' }, 500)]);
  const { app, gladys, timers, clock } = setup({ routes });
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  assert.equal(gladys.fake.connectionStatus.connected, true, 'the reading goes on');
  assert.equal(gladys.fake.lastState(`${SALON}:temperature`), 20.4);
  const weather = () => fake.calls.filter((c) => /weather$/.test(c.url)).length;
  assert.equal(weather(), 1);
  clock.now += timers.timeouts()[0].ms;
  await timers.runTimeouts();
  assert.equal(weather(), 1, 'not retried at the next reading');
  app.stop();
});

test('tado resetting 15 minutes late, without t=: every tado day is used', async () => {
  const late = 15 * 60_000;
  const { app, timers, clock, tado } = setup({ quota: { late, noT: true } });
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  await runUntil(timers, clock, RESET + late + 3 * DAY);
  const days = [0, 1, 2].map((d) => callsIn(tado, RESET + late + d * DAY).length);
  if (process.env.DEBUG_TEST) {
    console.error({ late: '15 min', callsPerTadoDay: days });
  }
  // The stale 12:05 reading lands in tado's later day: a couple of calls
  // over 80, still well above the reserve for the commands.
  for (const calls of days) {
    assert.ok(calls >= 70 && calls <= 85, `calls per tado day: ${days}`);
  }
  assert.equal(tado.refused, 0, 'no 429');
  app.stop();
});

/** The longest time between two readings of home 1234 in [from, to). */
function maxGap(tado, from, to) {
  const reads = tado.calls
    .filter((c) => /homes\/1234\/state$/.test(c.url) && c.at >= from && c.at < to)
    .map((c) => c.at);
  // The edges count: no reading until the end of the window is a gap too.
  const points = [from, ...reads, to];
  let gap = 0;
  for (let i = 1; i < points.length; i++) {
    gap = Math.max(gap, points[i] - points[i - 1]);
  }
  return gap;
}

test('tado on time without t=, a busy noon (another app): no long gap', async () => {
  const { app, timers, clock, tado } = setup({ quota: { noT: true } });
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  await runUntil(timers, clock, RESET + 60_000);
  // 12:01: another app on the account spends 30 requests.
  while (clock.now >= tado.resetAt) {
    tado.remaining = tado.quota;
    tado.resetAt += DAY;
  }
  tado.remaining -= 30;
  await runUntil(timers, clock, RESET + DAY);
  const gap = maxGap(tado, RESET + 10 * 60_000, RESET + DAY);
  if (process.env.DEBUG_TEST) {
    console.error({ busyNoon: true, maxGapHours: (gap / HOUR).toFixed(1) });
  }
  assert.ok(gap <= 4 * HOUR, `max gap ${(gap / HOUR).toFixed(1)} h`);
  assert.equal(tado.refused, 0);
  app.stop();
});

test('tado 15 minutes late without t=, two homes: every tado day is used', async () => {
  const late = 15 * 60_000;
  const routes = [
    [
      'GET',
      /\/api\/v2\/me$/,
      () =>
        json({
          ...v2.me,
          homes: [
            { id: 1234, name: 'Maison' },
            { id: 5678, name: 'Loft' },
          ],
        }),
    ],
    ...v2Routes(),
    ...xRoutes(),
  ];
  const { app, timers, clock, tado } = setup({ routes, quota: { late, noT: true } });
  await app.start({ [TOKEN_KEYS.REFRESH]: 'ref0' });
  await runUntil(timers, clock, RESET + late + 3 * DAY);
  const days = [0, 1, 2].map((d) => callsIn(tado, RESET + late + d * DAY).length);
  if (process.env.DEBUG_TEST) {
    console.error({ late: '15 min, 2 homes', callsPerTadoDay: days });
  }
  for (const calls of days) {
    assert.ok(calls >= 65 && calls <= 85, `calls per tado day: ${days}`);
  }
  assert.ok(maxGap(tado, RESET + late + DAY, RESET + late + 2 * DAY) <= 4 * HOUR);
  assert.equal(tado.refused, 0);
  app.stop();
});
