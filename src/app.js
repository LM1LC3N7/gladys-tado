// -----------------------------------------------------------------------------
// The integration itself: account linking, the refresh loop, the devices and
// their states, the commands, the scene triggers and actions, the widgets.
// index.js only wires the SDK handlers to it.
//
// Pace: tado counts the requests of an account per day (100 on a free
// account, 20,000 with a subscription, src/tado/ratelimit.js). The refresh
// loop is a chain of timeouts whose delay comes from that budget: the calls
// left above a reserve kept for the commands, spread until the daily reset,
// never faster than `refresh_interval`. The weather and the device list are
// read less often on a free account. A 429 pauses the loop until tado's
// reset. Commands are never held back by the pacing; one refreshes its home
// right after, unless the budget is down to the reserve.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import {
  DEVICES_INTERVAL,
  DEVICES_INTERVAL_FREE,
  PRESENCE,
  MAX_TIMER_DELAY,
  RESUME_MARGIN,
  RETRY_BACKOFF_MAX,
  TEMPERATURE,
  TERMINATION,
  THERMOSTAT_MODE,
  TOKEN_KEYS,
  WATER_HEATER_MODE,
  WEATHER_INTERVAL,
  WEATHER_INTERVAL_FREE,
  WIDGETS,
} from './constants.js';
import {
  CommandError,
  homeCommand,
  presenceAfter,
  settingFor,
  terminationFor,
  zoneAfter,
  zoneCommand,
} from './commands.js';
import {
  FEATURE,
  buildHomeDevice,
  buildPhoneDevice,
  buildZoneDevice,
  homeStates,
  ids,
  parseExternalId,
  phoneStates,
  thermostatMode,
  zoneStates,
} from './devices.js';
import { HttpError, RateLimitError } from './http.js';
import { T, bothLanguages, timeLabel } from './i18n.js';
import { AuthError, TokenManager, pollDeviceFlow, startDeviceFlow } from './tado/auth.js';
import { TadoClient } from './tado/api.js';
import { RateBudget, pollDelay } from './tado/ratelimit.js';
import {
  GENERATIONS,
  ZONE_TYPES,
  isActive,
  phonesFromDevices,
  presenceFromState,
  weatherFromState,
  zoneFromV2,
  zoneFromX,
} from './tado/model.js';
import { homeEvents } from './triggers.js';
import { homeWidget, zoneWidget } from './widget.js';

const defaultTimers = { setTimeout, clearTimeout, setInterval, clearInterval };

/** A 429 swallowed by a best-effort read would hide the pause: rethrow it. */
const unlessRateLimited = (fallback) => (err) => {
  if (err instanceof RateLimitError) {
    throw err;
  }
  return fallback(err);
};

/** The config keys that restart the integration when they change. */
export function configFingerprint(raw = {}) {
  const { [TOKEN_KEYS.REFRESH]: _token, ...rest } = raw ?? {};
  return JSON.stringify(rest, Object.keys(rest).sort());
}

export class TadoApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'tado' }),
    now = Date.now,
    timers = defaultTimers,
    clientFactory = (tokens, options) => new TadoClient({ tokens, ...options }),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.clientFactory = clientFactory;
    // Per account and per day at tado: kept across restarts of the app.
    this.budget = new RateBudget({ now });
    this.pausedUntil = 0; // after a 429
    this.nextAt = undefined; // the time of the next reading
    this.failures = 0; // readings in a row without an HTTP answer
    this.discoverPending = false; // a discovery deferred by a pause
    this.config = normalizeConfig();
    this.tokens = undefined;
    this.client = undefined;
    /** homeId -> { home, zones: Map, presence, weather, phones: Map, readAt, weatherAt, devicesAt } */
    this.homes = new Map();
    this.previous = new Map();
    this.refreshTimer = undefined;
    this.pending = undefined; // the device flow in progress
    this.lastStatus = undefined;
    this.fingerprint = undefined;
    this.refreshing = undefined;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    this.fingerprint = configFingerprint(raw);
    this.config = normalizeConfig(raw);
    this.tokens = new TokenManager({
      refreshToken: this.config.refreshToken,
      onRefreshToken: (token) => this.persistToken(token),
      now: this.now,
    });
    this.client = this.clientFactory(this.tokens, { budget: this.budget, now: this.now });
    if (!this.tokens.linked) {
      await this.setStatus(false, T.notLinked);
      return;
    }
    if (this.homes.size > 0) {
      await this.resumeAccount();
    } else {
      await this.connectAccount();
    }
  }

  /** A configuration update: only the tokens changed -> nothing to restart. */
  async configUpdated(raw = {}) {
    if (configFingerprint(raw) === this.fingerprint) {
      const token = typeof raw[TOKEN_KEYS.REFRESH] === 'string' ? raw[TOKEN_KEYS.REFRESH] : '';
      if (this.tokens && token && token !== this.tokens.refreshToken) {
        this.tokens.refreshToken = token;
      }
      return;
    }
    await this.start(raw);
  }

  stop() {
    this.stopLoop();
    // A cycle still in flight must not schedule the next one.
    this.loop = undefined;
    this.cancelPending();
  }

  stopLoop() {
    this.timers.clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  async persistToken(token) {
    await this.gladys
      .setConfig({ [TOKEN_KEYS.REFRESH]: token })
      .catch((err) => this.logger.warn(`Saving the tado session failed: ${err.message}`));
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /** Linked: discover, read once, then read on a timer. */
  async connectAccount() {
    this.stopLoop();
    this.loop = {};
    await this.cycle({ discover: true });
  }

  /**
   * A restart with the homes already known (a config save, a reconnection
   * to Gladys): no discovery and no reading out of turn, they would eat the
   * reserve or waste a 429. The next reading keeps its planned time, unless
   * the budget now allows an earlier one.
   */
  async resumeAccount() {
    this.stopLoop();
    this.loop = {};
    await this.publishDevices().catch((err) =>
      this.logger.warn(`Publishing the devices failed: ${err.message}`),
    );
    const planned = this.nextDelay();
    const left = this.nextAt === undefined ? Infinity : this.nextAt - this.now();
    const delay = planned.paused ? planned.delay : Math.max(0, Math.min(planned.delay, left));
    this.arm(delay);
  }

  /**
   * One turn of the refresh loop, then the next one scheduled from the
   * budget. A home list still empty (discovery failed) is discovered again.
   */
  async cycle({ discover = false } = {}) {
    const loop = this.loop;
    this.refreshTimer = undefined;
    // A discovery asked for (a new link) waits for the end of a pause.
    this.discoverPending ||= discover;
    if (this.pausedUntil > this.now() || this.nextDelay().paused) {
      // Paused (429 or budget at the reserve): woken early, the timer being
      // capped at 25 h, or linked meanwhile. Read nothing, arm again.
      await this.scheduleNext();
      return;
    }
    let transient = false;
    const answers = this.budget.answers;
    try {
      if (this.discoverPending || this.homes.size === 0) {
        await this.discover();
        this.discoverPending = false;
      }
      await this.refresh();
      this.failures = 0;
    } catch (err) {
      await this.reportError(err);
      if (err instanceof AuthError) {
        return;
      }
      // No answer from tado at all (network down, timeout): it cost no
      // request. An error after an answer (Gladys refusing the states...)
      // did cost some: paced by the budget like a reading.
      transient = !(err instanceof HttpError) && this.budget.answers === answers;
    }
    if (loop && loop === this.loop) {
      await this.scheduleNext({ transient });
    }
  }

  /** The calls one reading of every home costs at `at` (see refreshHome). */
  cycleCalls(at = this.now()) {
    let calls = 0;
    for (const entry of this.homes.values()) {
      calls += this.homeCalls(entry, at);
    }
    // No home yet: a discovery (me, home, zones, capabilities).
    return calls || 4;
  }

  homeCalls(entry, at = this.now()) {
    let calls = 2; // zoneStates (or X rooms) + homeState
    if (this.config.trackPhones) {
      calls += 1;
    }
    if (at - entry.weatherAt >= this.weatherInterval()) {
      calls += 1;
    }
    if (at - entry.devicesAt >= this.devicesInterval()) {
      calls += 1;
    }
    return calls;
  }

  weatherInterval() {
    return this.budget.subscribed ? WEATHER_INTERVAL : WEATHER_INTERVAL_FREE;
  }

  devicesInterval() {
    return this.budget.subscribed ? DEVICES_INTERVAL : DEVICES_INTERVAL_FREE;
  }

  /** The delay of the next reading (ms) and whether polling is paused. */
  nextDelay() {
    const now = this.now();
    const minDelay = this.config.refreshInterval * 1000;
    if (this.pausedUntil > now) {
      return { delay: Math.max(minDelay, this.pausedUntil - now + RESUME_MARGIN), paused: true };
    }
    // The budget needs it to tell a late tado reset from a busy day.
    this.budget.readingCost = this.cycleCalls(now);
    const budget = this.budget.snapshot();
    return pollDelay({
      left: budget.remaining,
      reserve: budget.reserve,
      resetAt: budget.resetAt,
      now,
      callsPerCycle: this.cycleCalls(now),
      minDelay,
    });
  }

  /**
   * Arm the next reading. `transient`: the last one got no HTTP answer, so
   * retry sooner (refresh_interval, doubling, at most RETRY_BACKOFF_MAX)
   * than the budget would say, unless the budget is at the reserve.
   */
  async scheduleNext({ transient = false } = {}) {
    const loop = this.loop;
    const planned = this.nextDelay();
    let { delay } = planned;
    if (transient && !planned.paused) {
      this.failures = (this.failures ?? 0) + 1;
      const backoff = Math.min(
        this.config.refreshInterval * 1000 * 2 ** (this.failures - 1),
        RETRY_BACKOFF_MAX,
      );
      delay = Math.min(delay, backoff);
    }
    // Armed before any await: a stop() meanwhile clears it.
    this.arm(delay);
    const budget = this.budget.snapshot();
    this.logger.debug(
      `Next tado reading in ${Math.round(delay / 60_000)} min ` +
        `(${budget.remaining}/${budget.quota} requests left today)`,
    );
    if (planned.paused && this.pausedUntil <= this.now() && loop === this.loop) {
      // The poller stops at the reserve: the status says why it is quiet.
      await this.setStatus(true, T.budgetLow(this.timeLabel(this.now() + delay)));
    }
  }

  arm(delay) {
    this.stopLoop();
    // Never past 25 h: Node fires a timer over 2^31-1 ms after 1 ms.
    const ms = Math.min(Math.max(0, delay), MAX_TIMER_DELAY);
    this.nextAt = this.now() + ms;
    this.refreshTimer = this.timers.setTimeout(() => this.cycle(), ms);
  }

  timeLabel(at) {
    const [first] = this.homes.values();
    return timeLabel(at, first?.home.timeZone);
  }

  /**
   * A 429: no reading until `retryAt`, the status says until when, and a
   * running loop is re-armed (a cycle in progress arms itself).
   */
  async rateLimited(err) {
    this.pausedUntil = Math.max(this.pausedUntil, err.retryAt);
    const until = this.timeLabel(this.pausedUntil + RESUME_MARGIN);
    this.logger.warn(
      `tado answered 429 (${err.daily ? 'daily quota used up' : 'short limit'}), ` +
        `readings paused until ${new Date(this.pausedUntil).toISOString()}`,
    );
    if (this.refreshTimer !== undefined) {
      await this.scheduleNext();
    }
    await this.setStatus(false, err.daily ? T.rateLimited(until) : T.rateLimitedShort(until));
  }

  async reportError(err) {
    if (err instanceof AuthError) {
      this.logger.warn(`tado session invalid (${err.code}): ${err.message}`);
      this.stopLoop();
      await this.setStatus(false, err.code === 'not_linked' ? T.notLinked : T.tokenExpired);
      return;
    }
    if (err instanceof RateLimitError) {
      await this.rateLimited(err);
      return;
    }
    this.logger.warn(`tado unreachable: ${err.message}`);
    await this.setStatus(this.homes.size > 0, T.unreachable(err.message));
  }

  /**
   * "Scan" in Gladys: discover and read now (a user action, not paced). A
   * 429 or an expired session goes through the loop's own handling.
   */
  async scan() {
    try {
      await this.discover();
      await this.refresh();
    } catch (err) {
      await this.reportError(err);
      throw err;
    }
  }

  // --- Account linking (device code flow) ----------------------------------------

  cancelPending() {
    if (this.pending) {
      this.timers.clearTimeout(this.pending.timer);
      this.pending = undefined;
    }
  }

  /** "Link my tado° account" clicked: the URL the user opens. */
  async authorizeUrl() {
    this.cancelPending();
    const flow = await startDeviceFlow({ now: this.now });
    this.pending = { ...flow, timer: undefined };
    this.schedulePoll(flow.interval);
    await this.setStatus(false, T.linking(flow.url));
    this.logger.info(`Device flow started, user code ${flow.userCode}`);
    return flow.url;
  }

  schedulePoll(delay) {
    if (!this.pending) {
      return;
    }
    this.pending.timer = this.timers.setTimeout(() => this.pollLink(), delay);
  }

  async pollLink() {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    if (this.now() > pending.expiresAt) {
      this.cancelPending();
      await this.setStatus(false, T.linkExpired);
      return;
    }
    let tokens;
    try {
      tokens = await pollDeviceFlow(pending.deviceCode, { now: this.now });
    } catch (err) {
      this.logger.warn(`Device flow failed (${err.code}): ${err.message}`);
      this.cancelPending();
      await this.setStatus(false, T.linkExpired);
      return;
    }
    if (!tokens) {
      this.schedulePoll(pending.interval);
      return;
    }
    this.cancelPending();
    await this.tokens.adopt(tokens);
    this.logger.info('tado account linked');
    await this.connectAccount();
  }

  async unlink() {
    this.stop();
    this.tokens?.forget();
    this.homes.clear();
    this.previous.clear();
    // Another account may be linked next: forget this one's budget, in
    // place (the API client holds the same object).
    this.budget.reset();
    this.pausedUntil = 0;
    this.nextAt = undefined;
    await this.persistToken('');
    await this.setStatus(false, T.notLinked);
    return T.unlinked;
  }

  // --- Discovery -------------------------------------------------------------------

  /** The homes and their zones; publishes the Gladys devices. */
  async discover() {
    const me = await this.client.me();
    const homes = new Map();
    for (const entry of me.homes ?? []) {
      const detail = await this.client.home(entry.id).catch(unlessRateLimited(() => ({})));
      const home = {
        id: String(entry.id),
        name: entry.name ?? detail.name ?? `Home ${entry.id}`,
        timeZone: detail.dateTimeZone ?? null,
        generation: detail.generation === 'LINE_X' ? GENERATIONS.X : GENERATIONS.V2,
      };
      const known = this.homes.get(home.id);
      homes.set(home.id, {
        home,
        zones: new Map(),
        presence: known?.presence,
        weather: known?.weather,
        phones: known?.phones ?? new Map(),
        weatherAt: known?.weatherAt ?? 0,
        devicesAt: 0,
      });
    }
    this.homes = homes;
    for (const entry of this.homes.values()) {
      await this.readZones(entry);
    }
    await this.publishDevices();
  }

  /** The zone definitions (and batteries): /zones, or /roomsAndDevices on X. */
  async readZones(entry) {
    const { home } = entry;
    if (home.generation === GENERATIONS.X) {
      const answer = await this.client.roomsAndDevices(home.id);
      entry.roomDevices = new Map(
        (answer.rooms ?? []).map((room) => [String(room.id ?? room.roomId), room.devices ?? []]),
      );
      for (const room of answer.rooms ?? []) {
        const zone = zoneFromX(
          { id: room.id ?? room.roomId, name: room.roomName ?? room.name },
          room.devices ?? [],
        );
        entry.zones.set(zone.id, { ...(entry.zones.get(zone.id) ?? {}), ...zone });
      }
    } else {
      const raws = await this.client.zones(home.id);
      const previousDefinitions = entry.zoneDefinitions;
      entry.zoneDefinitions = new Map();
      for (const raw of raws) {
        const definition = { ...raw };
        if (raw.type === ZONE_TYPES.HOT_WATER && definition.canSetTemperature === undefined) {
          const known = previousDefinitions?.get(String(raw.id))?.canSetTemperature;
          definition.canSetTemperature =
            known ??
            (await this.client
              .zoneCapabilities(home.id, raw.id)
              .then((c) => c?.canSetTemperature === true)
              .catch(unlessRateLimited(() => false)));
        }
        entry.zoneDefinitions.set(String(raw.id), definition);
        const zone = zoneFromV2(definition, {});
        const current = entry.zones.get(zone.id);
        entry.zones.set(
          zone.id,
          current
            ? { ...current, name: zone.name, lowBattery: zone.lowBattery, devices: zone.devices }
            : zone,
        );
      }
    }
    entry.devicesAt = this.now();
  }

  async publishDevices() {
    const devices = [];
    for (const { home, zones, phones } of this.homes.values()) {
      devices.push(buildHomeDevice(this.gladys, home));
      for (const zone of zones.values()) {
        devices.push(buildZoneDevice(this.gladys, home, zone));
      }
      if (this.config.trackPhones) {
        for (const phone of phones.values()) {
          devices.push(buildPhoneDevice(this.gladys, home, phone));
        }
      }
    }
    await this.gladys.publishDiscoveredDevices(devices);
  }

  // --- Reading ---------------------------------------------------------------------

  /** Read every home. Single-flight. */
  refresh() {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = undefined;
      });
    }
    return this.refreshing;
  }

  async doRefresh() {
    let failure;
    for (const entry of this.homes.values()) {
      try {
        await this.refreshHome(entry);
      } catch (err) {
        if (err instanceof AuthError || err instanceof RateLimitError) {
          throw err;
        }
        failure = err;
      }
    }
    if (failure) {
      throw failure;
    }
    await this.setOk();
  }

  async setOk() {
    const zones = [...this.homes.values()].reduce((n, e) => n + e.zones.size, 0);
    await this.setStatus(true, T.ok(this.homes.size, zones));
  }

  async refreshHome(entry) {
    const { home } = entry;
    const now = this.now();
    if (now - entry.devicesAt >= this.devicesInterval()) {
      await this.readZones(entry);
    }
    await this.readZoneStates(entry);
    entry.presence = presenceFromState(await this.client.homeState(home.id));
    // A 429 on the optional reads: publish what was read, then pause.
    let limited;
    if (now - entry.weatherAt >= this.weatherInterval()) {
      try {
        entry.weather = weatherFromState(await this.client.weather(home.id));
        entry.weatherAt = now;
      } catch (err) {
        if (err instanceof RateLimitError) {
          limited = err;
        } else {
          // Not retried at every reading: each try costs a request.
          entry.weatherAt = now;
          this.logger.warn(`Weather of ${home.name} unavailable: ${err.message}`);
        }
      }
    }
    if (this.config.trackPhones && !limited) {
      const phones = phonesFromDevices(await this.client.mobileDevices(home.id));
      const before = entry.phones.size;
      entry.phones = new Map(phones.map((p) => [p.id, p]));
      if (entry.phones.size !== before) {
        await this.publishDevices();
      }
    }
    await this.publishStates(entry);
    if (limited) {
      throw limited;
    }
  }

  /** The live zone states of a home: one request (zoneStates, or X rooms). */
  async readZoneStates(entry) {
    const { home } = entry;
    if (home.generation === GENERATIONS.X) {
      for (const room of await this.client.rooms(home.id)) {
        const zone = zoneFromX(room, entry.roomDevices?.get(String(room.id)) ?? []);
        entry.zones.set(zone.id, zone);
      }
    } else {
      const { zoneStates: states = {} } = await this.client.zoneStates(home.id);
      for (const [zoneId, state] of Object.entries(states)) {
        const definition = entry.zoneDefinitions?.get(String(zoneId)) ?? {
          id: zoneId,
          name: `Zone ${zoneId}`,
        };
        entry.zones.set(String(zoneId), zoneFromV2(definition, state));
      }
    }
  }

  async publishStates(entry) {
    const { home } = entry;
    const states = [...homeStates(this.gladys, home, entry)];
    for (const zone of entry.zones.values()) {
      states.push(...zoneStates(this.gladys, home, zone));
    }
    if (this.config.trackPhones) {
      for (const phone of entry.phones.values()) {
        states.push(...phoneStates(this.gladys, home, phone));
      }
    }
    await this.gladys.publishChangedStates(states, { heartbeat: 30 * 60_000 });
    const previous = this.previous.get(home.id);
    const current = { presence: entry.presence, zones: new Map(entry.zones) };
    const events = homeEvents(
      {
        gladys: this.gladys,
        homeDeviceId: ids.home(this.gladys, home.id),
        zoneDeviceId: (zoneId) => ids.zone(this.gladys, home.id, zoneId),
      },
      previous,
      current,
    );
    this.previous.set(home.id, current);
    for (const event of events) {
      await this.gladys
        .publishSceneEvent(event.key, event.data)
        .catch((err) => this.logger.warn(`Scene event ${event.key} failed: ${err.message}`));
    }
    this.gladys.requestWidgetRefresh(WIDGETS.HOME);
    this.gladys.requestWidgetRefresh(WIDGETS.ZONE);
  }

  // --- Commands --------------------------------------------------------------------

  locate(externalId) {
    const parsed = parseExternalId(externalId);
    const entry = parsed && this.homes.get(parsed.homeId);
    if (!entry) {
      throw new CommandError(`Unknown tado device ${externalId}`);
    }
    if (parsed.kind === 'zone') {
      const zone = entry.zones.get(parsed.id);
      if (!zone) {
        throw new CommandError(`Unknown tado zone ${externalId}`);
      }
      return { kind: 'zone', entry, zone };
    }
    return { kind: parsed.kind, entry };
  }

  /** A command from Gladys (onSetValue). */
  async setValue(device, feature, value) {
    const key = String(feature.external_id).split(':').at(-1);
    const target = this.locate(device.external_id);
    if (target.kind === 'home') {
      await this.execute(target.entry, undefined, homeCommand(key, value));
    } else if (target.kind === 'zone') {
      await this.execute(
        target.entry,
        target.zone,
        zoneCommand(target.zone, key, value, this.config),
      );
    } else {
      throw new CommandError(`${device.external_id} accepts no command`);
    }
  }

  /**
   * Send a command. Never held back by the pacing: only a real 429 makes it
   * fail, with a bilingual message (`text`, for the widgets).
   */
  async execute(entry, zone, command) {
    try {
      await this.send(entry, zone, command);
    } catch (err) {
      if (!(err instanceof RateLimitError)) {
        throw err;
      }
      await this.rateLimited(err);
      const until = this.timeLabel(this.pausedUntil + RESUME_MARGIN);
      const text = err.daily ? T.commandRateLimited(until) : T.commandRateLimitedShort(until);
      throw Object.assign(new CommandError(bothLanguages(text)), { text });
    }
    const resume = command.kind === 'resume';
    if (!resume) {
      await this.publishCommanded(entry, zone, command);
    }
    if (this.pausedUntil > this.now()) {
      // tado took a command again: its quota is back before the expected time.
      this.pausedUntil = 0;
      await this.setOk(); // before scheduleNext, which may say "almost used"
      if (this.refreshTimer !== undefined) {
        await this.scheduleNext();
      }
    }
    // The fresh state costs a reading of the home: skipped when it would eat
    // into the reserve kept for the next commands. Not after a resume: only
    // tado knows what the schedule applies (on or off, which target), and a
    // guess could show a zone on (and fire scenes) while it is off.
    const atReserve = this.budget.left() - this.homeCalls(entry) < this.budget.reserve;
    if (!resume && atReserve) {
      this.logger.info('tado quota nearly used: no refresh after the command');
      return;
    }
    if (resume && this.budget.left() === 0) {
      // A read now would only get a 429 (and a red status).
      await this.publishScheduleMode(entry, zone);
      return;
    }
    try {
      if (atReserve) {
        // A resume at the reserve: the zone states only, one request.
        await this.readZoneStates(entry);
        await this.publishStates(entry);
      } else {
        await this.refreshHome(entry);
      }
    } catch (err) {
      if (err instanceof RateLimitError) {
        await this.rateLimited(err);
      } else {
        this.logger.warn(`Refresh after command failed: ${err.message}`);
      }
      if (resume) {
        await this.publishScheduleMode(entry, zone);
      }
    }
  }

  /**
   * A resume whose re-read failed: only the mode is known (the schedule);
   * the power and the target stay as they were until the next reading.
   */
  async publishScheduleMode(entry, zone) {
    entry.zones.set(zone.id, zoneAfter(zone, { kind: 'resume' }));
    const mode =
      zone.type === ZONE_TYPES.HEATING
        ? THERMOSTAT_MODE.AUTO
        : zone.type === ZONE_TYPES.HOT_WATER
          ? WATER_HEATER_MODE.AUTO
          : undefined; // air conditioning: the schedule's mode is unknown
    if (mode === undefined) {
      return;
    }
    const device = ids.zone(this.gladys, entry.home.id, zone.id);
    await this.gladys
      .publishChangedStates([
        { device_feature_external_id: ids.feature(device, FEATURE.MODE), state: mode },
      ])
      .catch((err) => this.logger.warn(`Publishing the command state failed: ${err.message}`));
    this.gladys.requestWidgetRefresh(WIDGETS.ZONE);
  }

  /**
   * What the command set, published at once: the devices have feedback, so
   * without it Gladys would show the old value until the next reading
   * (which may be hours away on a free tado account).
   */
  async publishCommanded(entry, zone, command) {
    const { home } = entry;
    let states;
    if (command.kind === 'presence') {
      entry.presence = presenceAfter(entry.presence, command.value);
      states = homeStates(this.gladys, home, entry);
    } else if (zone) {
      const after = zoneAfter(zone, command);
      entry.zones.set(zone.id, after);
      states = zoneStates(this.gladys, home, after);
    } else {
      return;
    }
    await this.gladys
      .publishChangedStates(states)
      .catch((err) => this.logger.warn(`Publishing the command state failed: ${err.message}`));
    this.gladys.requestWidgetRefresh(WIDGETS.HOME);
    this.gladys.requestWidgetRefresh(WIDGETS.ZONE);
  }

  async send(entry, zone, command) {
    const { home } = entry;
    if (command.kind === 'presence') {
      await this.client.setPresence(home.id, command.value);
    } else if (command.kind === 'resume') {
      if (home.generation === GENERATIONS.X) {
        await this.client.resumeRoomSchedule(home.id, zone.id);
      } else {
        await this.client.deleteOverlay(home.id, zone.id);
      }
    } else if (command.kind === 'overlay') {
      if (home.generation === GENERATIONS.X) {
        await this.client.setRoomManualControl(
          home.id,
          zone.id,
          command.setting,
          command.termination,
        );
      } else {
        await this.client.setOverlay(home.id, zone.id, command.setting, command.termination);
      }
    }
  }

  // --- Scene actions ---------------------------------------------------------------

  zoneOf(fields) {
    const target = this.locate(fields.device);
    if (target.kind !== 'zone') {
      throw new CommandError('Pick a tado zone, not the home');
    }
    return target;
  }

  async setTemperature(fields = {}) {
    const { entry, zone } = this.zoneOf(fields);
    const termination = Object.values(TERMINATION).includes(fields.termination)
      ? fields.termination
      : undefined;
    const config = {
      ...this.config,
      timerMinutes: Number(fields.minutes) > 0 ? Number(fields.minutes) : this.config.timerMinutes,
    };
    await this.execute(
      entry,
      zone,
      zoneCommand(zone, FEATURE.TARGET, fields.temperature, config, { termination }),
    );
    return this.zoneOutputs(entry.zones.get(zone.id) ?? zone);
  }

  async resumeSchedule(fields = {}) {
    const { entry, zone } = this.zoneOf(fields);
    await this.execute(entry, zone, { kind: 'resume' });
    return this.zoneOutputs(entry.zones.get(zone.id) ?? zone);
  }

  async setPresence(fields = {}) {
    const target = this.locate(fields.device);
    const mode = String(fields.presence ?? PRESENCE.AUTO);
    await this.execute(target.entry, undefined, homeCommand(FEATURE.PRESENCE_MODE, mode));
    return {
      presence: target.entry.presence?.presence ?? null,
      mode: target.entry.presence?.mode ?? mode,
    };
  }

  async getZone(fields = {}) {
    const { zone } = this.zoneOf(fields);
    return this.zoneOutputs(zone);
  }

  zoneOutputs(zone) {
    return {
      zone: zone.name,
      temperature: zone.temperature,
      humidity: zone.humidity,
      target_temperature: zone.targetTemperature,
      heating: isActive(zone),
      heating_power: zone.heatingPower,
      mode:
        zone.type === ZONE_TYPES.HEATING
          ? ['off', 'manual', 'cooling', 'schedule'][thermostatMode(zone)]
          : zone.power
            ? 'on'
            : 'off',
      manual: Boolean(zone.overlay),
      open_window: zone.openWindow,
      low_battery: zone.lowBattery,
    };
  }

  // --- Widgets ---------------------------------------------------------------------

  async getWidget(key, { settings = {}, language } = {}) {
    let target;
    try {
      target = this.locate(settings.device);
    } catch {
      return {
        ttl_seconds: 300,
        components: [
          {
            type: 'text',
            text: key === WIDGETS.ZONE ? T.widget.noZone : T.widget.noHome,
            variant: 'body',
          },
        ],
      };
    }
    if (key === WIDGETS.ZONE) {
      return zoneWidget({
        gladys: this.gladys,
        home: target.entry.home,
        zone: target.zone,
        language,
      });
    }
    return homeWidget({
      gladys: this.gladys,
      home: target.entry.home,
      reading: this.previous.get(target.entry.home.id),
      language,
    });
  }

  async widgetAction(key, actionKey, params = {}, { settings = {} } = {}) {
    try {
      const target = this.locate(settings.device);
      if (key === WIDGETS.ZONE && target.kind === 'zone') {
        const { entry, zone } = target;
        if (actionKey === 'resume') {
          await this.execute(entry, zone, { kind: 'resume' });
        } else if (actionKey === 'off') {
          await this.execute(entry, zone, {
            kind: 'overlay',
            setting: settingFor(zone, { power: false }),
            termination: terminationFor(zone.generation, this.config),
          });
        } else if (actionKey === 'target') {
          const t = Number(params.target);
          await this.execute(
            entry,
            zone,
            zoneCommand(
              zone,
              FEATURE.TARGET,
              Number.isFinite(t) ? t : TEMPERATURE.MIN,
              this.config,
            ),
          );
        }
      } else if (key === WIDGETS.HOME && actionKey === 'presence') {
        await this.execute(
          target.entry,
          undefined,
          homeCommand(FEATURE.PRESENCE_MODE, params.mode),
        );
      }
      return T.widget.done;
    } catch (err) {
      return err.text ?? T.widget.failed(err.message);
    }
  }

  // --- Configuration screen buttons --------------------------------------------------

  async testConnection() {
    if (!this.tokens?.linked) {
      return T.notLinked;
    }
    try {
      const me = await this.client.me();
      const homes = (me.homes ?? []).map((h) => h.name).join(', ');
      return {
        en: `Signed in as ${me.email ?? me.name ?? '?'}: ${homes || 'no home'}.`,
        fr: `Connecté en tant que ${me.email ?? me.name ?? '?'} : ${homes || 'aucune maison'}.`,
      };
    } catch (err) {
      if (err instanceof AuthError) {
        return T.tokenExpired;
      }
      return T.unreachable(err.message);
    }
  }
}

// Re-exported for the widgets and tests.
export { thermostatMode, TEMPERATURE };
