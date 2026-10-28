// -----------------------------------------------------------------------------
// What the devices of every kind must satisfy for the Gladys core to accept the
// publication. The core refuses the WHOLE list when one device is wrong
// (externalIntegration.setDiscoveredDevices), so Discovery then lists nothing:
// a tado X home hit `supported_options: "[0].label" must be a string` because
// the labels were { en, fr } objects, which the SDK's fake Gladys never checks.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { buildHomeDevice, buildPhoneDevice, buildZoneDevice } from '../src/devices.js';
import { zoneFromV2, zoneFromX } from '../src/tado/model.js';
import * as v2 from './fixtures/v2.js';
import * as x from './fixtures/x.js';

// The core's own code, when a Gladys clone is at hand (GLADYS_CORE, else ~/code/Gladys;
// not on GitHub CI): the rules below are its schema, this is the proof.
const CORE = process.env.GLADYS_CORE ?? join(homedir(), 'code', 'Gladys');
const coreRequire = existsSync(join(CORE, 'server', 'utils', 'normalizeSupportedOptions.js'))
  ? createRequire(join(CORE, 'server', 'package.json'))
  : undefined;
const normalizeSupportedOptions = coreRequire?.(
  './utils/normalizeSupportedOptions.js',
).normalizeSupportedOptions;
const setDiscoveredDevices = coreRequire?.(
  './lib/external-integration/externalIntegration.setDiscoveredDevices.js',
).setDiscoveredDevices;

const gladys = createFakeGladys({ selector: 'tado', config: {} });
const home = { id: 1234, name: 'Maison' };

/** Every kind of device the integration can publish. */
function allDevices() {
  const water = (canSetTemperature) => ({
    ...zoneFromV2(v2.zones[2]),
    canSetTemperature,
  });
  const ac = { ...zoneFromV2({ id: 4, name: 'Clim', type: 'AIR_CONDITIONING', devices: [] }) };
  const room = x.rooms()[0];
  return [
    ['home', buildHomeDevice(gladys, home)],
    ['heating zone', buildZoneDevice(gladys, home, zoneFromV2(v2.zones[0]))],
    ['hot water, settable', buildZoneDevice(gladys, home, water(true))],
    ['hot water, fixed', buildZoneDevice(gladys, home, water(false))],
    ['air conditioning', buildZoneDevice(gladys, home, ac)],
    ['tado X room', buildZoneDevice(gladys, { id: 5678, name: 'Loft' }, zoneFromX(room))],
    ['phone', buildPhoneDevice(gladys, home, { id: 9, name: 'Jane', atHome: true })],
  ];
}

// The core's rules for `supported_options` (server/utils/normalizeSupportedOptions.js),
// copied so that GitHub CI, which has no Gladys clone, applies them too: a
// non-blank string label, a non-blank string (text/select only) or integer value,
// no two values alike in string form, an integer sort_order.
function checkOptions(options, where, allowStringValues) {
  assert.ok(Array.isArray(options) && options.length > 0, `${where}: options`);
  for (const [i, option] of options.entries()) {
    const at = `${where}[${i}]`;
    assert.equal(typeof option.label, 'string', `${at}.label must be a string`);
    assert.ok(option.label.trim().length > 0, `${at}.label is blank`);
    assert.ok(
      Number.isInteger(option.value) ||
        (allowStringValues && typeof option.value === 'string' && option.value.trim().length > 0),
      `${at}.value`,
    );
    assert.ok(
      option.sort_order === undefined || Number.isInteger(option.sort_order),
      `${at}.sort_order`,
    );
    // Joi object: no key beyond these (the core strips only its own DB columns).
    const known = ['value', 'label', 'sort_order', 'id', 'value_string', 'device_feature_id'];
    for (const key of Object.keys(option)) {
      assert.ok(known.includes(key), `${at}: unknown key ${key}`);
    }
  }
  const values = options.map((o) => `${o.value}`);
  assert.equal(new Set(values).size, values.length, `${where}: duplicate values`);
  if (normalizeSupportedOptions) {
    assert.doesNotThrow(() => normalizeSupportedOptions(options, { allowStringValues }), where);
  }
}

test('every supported_options label of every device is a plain string, as the core demands', () => {
  let lists = 0;
  for (const [kind, device] of allDevices()) {
    for (const feature of device.features) {
      if (feature.supported_options === undefined) {
        continue;
      }
      lists += 1;
      const selectText =
        feature.category === DEVICE_FEATURE_CATEGORIES.TEXT &&
        feature.type === DEVICE_FEATURE_TYPES.TEXT.SELECT;
      checkOptions(feature.supported_options, `${kind}/${feature.external_id}`, selectText);
    }
  }
  // home presence, heating, hot water, air conditioning: not vacuous
  assert.equal(lists, 6);
});

test('the option rules reject an { en, fr } label (the regression guard itself)', () => {
  const bad = [{ value: 0, label: { en: 'Off', fr: 'Arrêt' }, sort_order: 0 }];
  assert.throws(() => checkOptions(bad, 'bad', false), /label must be a string/);
  assert.throws(() => checkOptions([{ value: 0, label: ' ' }], 'bad', false), /blank/);
  assert.throws(
    () =>
      checkOptions(
        [
          { value: 1, label: 'a' },
          { value: '1', label: 'b' },
        ],
        'bad',
        true,
      ),
    /duplicate/,
  );
  if (normalizeSupportedOptions) {
    assert.throws(() => normalizeSupportedOptions(bad), /label/);
  }
});

test('the rest of the publication follows the core schema (setDiscoveredDevices)', () => {
  const categories = Object.values(DEVICE_FEATURE_CATEGORIES);
  const units = Object.values(DEVICE_FEATURE_UNITS);
  const types = Object.values(DEVICE_FEATURE_TYPES).flatMap((group) => Object.values(group));
  const prefix = 'ext:tado:';
  for (const [kind, device] of allDevices()) {
    assert.ok(typeof device.name === 'string' && device.name.length > 0, `${kind}: name`);
    assert.ok(device.external_id.startsWith(prefix), `${kind}: external_id`);
    assert.ok(Array.isArray(device.features) && device.features.length > 0, `${kind}: features`);
    const ids = new Set();
    for (const f of device.features) {
      const at = `${kind}/${f.external_id}`;
      assert.ok(typeof f.name === 'string' && f.name.length > 0, `${at}: name`);
      assert.ok(f.external_id.startsWith(prefix), `${at}: external_id`);
      assert.ok(!ids.has(f.external_id), `${at}: duplicate feature`);
      ids.add(f.external_id);
      assert.ok(categories.includes(f.category), `${at}: category`);
      assert.ok(types.includes(f.type), `${at}: type`);
      assert.ok(f.unit === undefined || f.unit === null || units.includes(f.unit), `${at}: unit`);
      assert.ok(
        f.step === undefined || (Number.isFinite(f.step) && f.step > 0),
        `${at}: step must be a positive number`,
      );
      // NOT NULL columns of the core's device_feature model (device creation).
      assert.ok(Number.isFinite(f.min) && Number.isFinite(f.max), `${at}: min/max`);
      for (const flag of ['read_only', 'has_feedback', 'keep_history']) {
        assert.equal(typeof f[flag], 'boolean', `${at}: ${flag} is required`);
      }
    }
    // No reserved GLADYS_* param name, no poll_frequency without a poll.
    for (const param of device.params ?? []) {
      assert.ok(!param.name.toUpperCase().startsWith('GLADYS_'), `${kind}: reserved ${param.name}`);
      assert.equal(typeof param.value, 'string', `${kind}: param ${param.name}`);
    }
    assert.equal(device.poll_frequency, undefined);
  }
});

test('the core accepts the whole publication (its own setDiscoveredDevices)', async (t) => {
  if (!setDiscoveredDevices) {
    t.skip('no Gladys clone (set GLADYS_CORE)');
    return;
  }
  const core = {
    discoveredDevices: new Map(),
    stateManager: { get: () => undefined },
    event: { emit() {} },
  };
  const devices = allDevices().map(([, device]) => device);
  const count = await setDiscoveredDevices.call(core, { id: 'svc', selector: 'tado' }, devices);
  assert.equal(count, devices.length);
});

test('the option rules also see an unknown key', () => {
  assert.throws(
    () => checkOptions([{ value: 0, label: 'Off', icon: 'x' }], 'bad', false),
    /unknown key icon/,
  );
});
