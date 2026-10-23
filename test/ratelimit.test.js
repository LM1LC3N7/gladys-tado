// -----------------------------------------------------------------------------
// tado's daily quota: header parsing, the budget, the delay of the next
// reading, the 429 of the HTTP layer. Pure, no network.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FREE_QUOTA,
  MAX_WAIT,
  RESET_MARGIN,
  RateBudget,
  SHORT_PAUSE,
  nextDailyReset,
  previousDailyReset,
  parseRateLimit,
  parseRateLimitPolicy,
  parseRetryAfter,
  pollDelay,
} from '../src/tado/ratelimit.js';
import { RateLimitError, request } from '../src/http.js';
import { installFetch, json } from './helpers/fakeFetch.js';

const NOW = Date.parse('2026-10-13T12:00:00Z'); // 14:00 in Berlin (CEST)
const HOUR = 3600_000;

test('the ratelimit header: valid, partial, garbage', () => {
  assert.deepEqual(parseRateLimit('"perday";r=42;t=3600'), { remaining: 42, resetIn: 3600 });
  assert.deepEqual(parseRateLimit('perday; r = 7'), { remaining: 7, resetIn: undefined });
  assert.deepEqual(parseRateLimit('"perday";r="12";t=60'), { remaining: 12, resetIn: 60 });
  assert.deepEqual(parseRateLimit('"perday";R=0'), { remaining: 0, resetIn: undefined });
  // Several policies: the daily one wins.
  assert.equal(parseRateLimit('"perminute";r=5, "perday";r=50').remaining, 50);
  const nothing = { remaining: undefined, resetIn: undefined };
  for (const garbage of [
    undefined,
    null,
    '',
    'garbage',
    '"perday"',
    '"perday";r=-1;t=x',
    '"perday";r=1e3',
    '"perday";r=;t',
    '"perday";=5',
    '"perday";r=99999999999',
    42,
  ]) {
    assert.deepEqual(parseRateLimit(garbage), nothing, String(garbage));
  }
});

test('the ratelimit-policy header', () => {
  assert.deepEqual(parseRateLimitPolicy('"perday";q=100;w=86400'), { quota: 100, window: 86400 });
  assert.equal(parseRateLimitPolicy('"perday";q=20000').quota, 20000);
  assert.equal(parseRateLimitPolicy('"perday";q=0;w=86400').quota, undefined);
  assert.equal(parseRateLimitPolicy('"perday";w=86400').quota, undefined);
  assert.equal(parseRateLimitPolicy('nonsense;;;').quota, undefined);
});

test('Retry-After: seconds or an HTTP date', () => {
  assert.equal(parseRetryAfter('120', NOW), NOW + 120_000);
  assert.equal(parseRetryAfter(new Date(NOW + HOUR).toUTCString(), NOW), NOW + HOUR);
  assert.equal(parseRetryAfter(new Date(NOW - HOUR).toUTCString(), NOW), undefined, 'past');
  assert.equal(parseRetryAfter('soon', NOW), undefined);
  assert.equal(parseRetryAfter('', NOW), undefined);
  assert.equal(parseRetryAfter(undefined, NOW), undefined);
});

test('the daily reset is the next 12:00 in Berlin, DST included', () => {
  const at = (iso) => new Date(nextDailyReset(Date.parse(iso))).toISOString();
  assert.equal(at('2026-10-13T12:00:00Z'), '2026-10-14T10:00:00.000Z', 'after noon: tomorrow');
  assert.equal(at('2026-10-13T09:00:00Z'), '2026-10-13T10:00:00.000Z', 'before noon: today');
  assert.equal(at('2026-10-13T10:00:00Z'), '2026-10-14T10:00:00.000Z', 'at noon: tomorrow');
  assert.equal(at('2026-12-01T08:00:00Z'), '2026-12-01T11:00:00.000Z', 'winter time');
  assert.equal(at('2026-10-24T12:00:00Z'), '2026-10-25T11:00:00.000Z', 'over the DST change');
  assert.equal(at('2026-03-28T12:00:00Z'), '2026-03-29T10:00:00.000Z', 'into summer time');
});

test('the budget follows the answers', () => {
  const clock = { now: NOW };
  const budget = new RateBudget({ now: () => clock.now });
  // Nothing seen: the free tier, minus the calls counted locally.
  assert.equal(budget.limit, FREE_QUOTA);
  assert.equal(budget.subscribed, false);
  assert.equal(budget.reserve, 20);
  budget.observe(new Headers(), 200);
  assert.equal(budget.left(), 99);
  assert.equal(budget.resetAt, nextDailyReset(NOW));
  // The headers are authoritative.
  budget.observe(
    new Headers({ RateLimit: '"perday";r=50;t=600', 'RateLimit-Policy': '"perday";q=100;w=86400' }),
    200,
  );
  assert.deepEqual(
    { ...budget.snapshot() },
    {
      quota: 100,
      remaining: 50,
      resetAt: NOW + 600_000,
      reserve: 20,
      subscribed: false,
    },
  );
  // An answer without the header still costs one; plain objects work too.
  budget.observe({}, 200);
  assert.equal(budget.left(), 49);
  budget.observe({ RATELIMIT: '"perday";r=30' }, 500);
  assert.equal(budget.left(), 30, 'errors are tracked too');
  budget.observe({ ratelimit: 'garbage' }, 200);
  assert.equal(budget.left(), 29, 'garbage ignored');
  // Past the reset: a full quota again, until tado says otherwise.
  clock.now = NOW + 601_000;
  assert.equal(budget.left(), 100);
  assert.equal(budget.resetAt, nextDailyReset(clock.now));
  // A subscription.
  budget.observe({ 'ratelimit-policy': '"perday";q=20000;w=86400', ratelimit: '"perday";r=19000' });
  assert.equal(budget.subscribed, true);
  assert.equal(budget.reserve, 4000);
});

test('a 429 resolves the time to wait for', () => {
  const budget = (now = NOW) => new RateBudget({ now: () => now });
  assert.deepEqual(budget().observe({ ratelimit: '"perday";r=0;t=3600' }, 429), {
    retryAt: NOW + HOUR,
    daily: true,
  });
  assert.deepEqual(
    budget().observe({ ratelimit: '"perday";r=0;t=3600', 'retry-after': '120' }, 429),
    { retryAt: NOW + 120_000, daily: true },
    'Retry-After wins',
  );
  // 14:00 Berlin, 2 h after the reset, nothing said: the next daily reset.
  const blind = budget();
  assert.deepEqual(blind.observe({}, 429), { retryAt: nextDailyReset(NOW), daily: true });
  assert.equal(blind.left(), 0);
  assert.deepEqual(
    budget().observe({ ratelimit: '"perday";r=40' }, 429),
    { retryAt: NOW + SHORT_PAUSE, daily: false },
    'budget left: a short pause, not a day',
  );
  assert.equal(budget().observe({ ratelimit: '"perday";r=40' }, 200), undefined);
});

test('a 429 just after the expected reset: tado is late, short growing pauses', () => {
  const clock = { now: Date.parse('2026-10-13T10:06:00Z') }; // 12:06 in Berlin
  const budget = new RateBudget({ now: () => clock.now });
  const first = budget.observe({ ratelimit: '"perday";r=0' }, 429);
  assert.deepEqual(first, { retryAt: clock.now + SHORT_PAUSE, daily: false });
  clock.now = first.retryAt;
  const second = budget.observe({ ratelimit: '"perday";r=0' }, 429);
  assert.equal(second.retryAt, clock.now + 2 * SHORT_PAUSE, 'growing');
  clock.now = second.retryAt;
  budget.observe({ ratelimit: '"perday";r=99' }, 200);
  clock.now += 60_000;
  assert.equal(
    budget.observe({ ratelimit: '"perday";r=0' }, 429).retryAt,
    clock.now + SHORT_PAUSE,
    'an answer resets the streak',
  );
  // Past the 2 h window: the daily reset again.
  clock.now = Date.parse('2026-10-13T12:30:00Z');
  assert.deepEqual(budget.observe({ ratelimit: '"perday";r=0' }, 429), {
    retryAt: Date.parse('2026-10-14T10:00:00Z'),
    daily: true,
  });
});

test('huge t= or far Retry-After are capped at 2 days', () => {
  assert.equal(parseRateLimit('"perday";r=0;t=9999999').resetIn, MAX_WAIT / 1000);
  assert.equal(parseRetryAfter('9999999', NOW), NOW + MAX_WAIT);
  assert.equal(parseRetryAfter('Fri, 01 Jan 2100 00:00:00 GMT', NOW), NOW + MAX_WAIT);
  const budget = new RateBudget({ now: () => NOW });
  assert.equal(
    budget.observe({ ratelimit: '"perday";r=0;t=9999999' }, 429).retryAt,
    NOW + MAX_WAIT,
  );
});

test('reset() forgets the account in place; a subscription is inferred from r', () => {
  const budget = new RateBudget({ now: () => NOW });
  budget.observe({ ratelimit: '"perday";r=15000' }, 200);
  assert.equal(budget.limit, 15000, 'no policy, r above the free tier');
  assert.equal(budget.subscribed, true);
  budget.reset();
  assert.equal(budget.limit, FREE_QUOTA);
  assert.equal(budget.left(), FREE_QUOTA);
  budget.observe({ ratelimit: '"perday";r=80' }, 200);
  assert.equal(budget.limit, FREE_QUOTA, 'r under 100 says nothing about the tier');
});

test('the delay of the next reading', () => {
  const base = { now: NOW, resetAt: NOW + 24 * HOUR, minDelay: 120_000 };
  // Free tier: 80 calls above the reserve, 2 a reading -> 40 readings a day.
  const free = pollDelay({ ...base, left: 100, reserve: 20, callsPerCycle: 2 });
  assert.deepEqual(free, { delay: 36 * 60_000, paused: false });
  // track_phones: 3 a reading -> 26.7 readings a day.
  const phones = pollDelay({ ...base, left: 100, reserve: 20, callsPerCycle: 3 });
  assert.equal(phones.delay, 54 * 60_000);
  // Subscription: the user's interval.
  const subscribed = pollDelay({ ...base, left: 19_000, reserve: 4000, callsPerCycle: 3 });
  assert.deepEqual(subscribed, { delay: 120_000, paused: false });
  // Never faster than the user's interval, even just before the reset.
  const late = pollDelay({
    ...base,
    resetAt: NOW + 60_000,
    left: 80,
    reserve: 20,
    callsPerCycle: 2,
  });
  assert.equal(late.delay, 120_000);
  // Down to the reserve: wait for the reset.
  const low = pollDelay({ ...base, left: 21, reserve: 20, callsPerCycle: 2 });
  assert.deepEqual(low, { delay: 24 * HOUR + RESET_MARGIN, paused: true });
  // The delay grows as the budget shrinks.
  const half = pollDelay({ ...base, left: 60, reserve: 20, callsPerCycle: 2 });
  assert.ok(half.delay > free.delay);
});

test('the HTTP layer feeds the budget and turns a 429 into a RateLimitError', async () => {
  const budget = new RateBudget({ now: () => NOW });
  let status = 200;
  const fake = installFetch([
    [
      'GET',
      /127\.0\.0\.1/,
      () =>
        json(status === 200 ? { ok: true } : { errors: [] }, status, {
          ratelimit: `"perday";r=${status === 200 ? 5 : 0};t=3600`,
          'ratelimit-policy': '"perday";q=100;w=86400',
        }),
    ],
  ]);
  try {
    assert.deepEqual(await request('http://127.0.0.1/x', { budget, now: () => NOW }), {
      ok: true,
    });
    assert.equal(budget.left(), 5);
    status = 429;
    const err = await request('http://127.0.0.1/x', { budget, now: () => NOW }).catch((e) => e);
    assert.ok(err instanceof RateLimitError);
    assert.equal(err.status, 429);
    assert.equal(err.retryAt, NOW + HOUR);
    assert.equal(budget.left(), 0);
    // Without a budget (the OAuth host), Retry-After or a short pause.
    const bare = await request('http://127.0.0.1/x', { now: () => NOW }).catch((e) => e);
    assert.equal(bare.retryAt, NOW + SHORT_PAUSE);
  } finally {
    fake.restore();
  }
});

test('the previous reset, DST included; the late streak ends on a daily 429', () => {
  const at = (iso) => new Date(previousDailyReset(Date.parse(iso))).toISOString();
  assert.equal(at('2026-10-24T12:30:00Z'), '2026-10-24T10:00:00.000Z', 'Saturday before DST');
  assert.equal(at('2026-10-13T09:00:00Z'), '2026-10-12T10:00:00.000Z', 'before noon');
  assert.equal(at('2026-10-25T11:00:00Z'), '2026-10-25T11:00:00.000Z', 'exactly noon CET');
  // 14:30 CEST on that Saturday: 2.5 h after the reset, a daily 429.
  const clock = { now: Date.parse('2026-10-24T12:30:00Z') };
  const budget = new RateBudget({ now: () => clock.now });
  assert.equal(budget.observe({}, 429).daily, true);
  // Late streak, then a daily 429 with t=, then late again: back to the short pause.
  clock.now = Date.parse('2026-10-25T11:10:00Z'); // 12:10 CET
  budget.observe({ ratelimit: '"perday";r=0' }, 429);
  budget.observe({ ratelimit: '"perday";r=0' }, 429);
  assert.equal(budget.lateStreak, 1, 'two answers, one pause');
  clock.now += SHORT_PAUSE;
  budget.observe({ ratelimit: '"perday";r=0' }, 429);
  assert.equal(budget.lateStreak, 2);
  budget.observe({ ratelimit: '"perday";r=0;t=600' }, 429);
  assert.equal(budget.lateStreak, 0);
  assert.equal(budget.observe({ ratelimit: '"perday";r=0' }, 429).retryAt, clock.now + SHORT_PAUSE);
});

test('a 200 answer still carrying the old day: tado is late, look again soon', () => {
  const clock = { now: Date.parse('2026-10-13T09:50:00Z') }; // 11:50 in Berlin
  const budget = new RateBudget({ now: () => clock.now });
  budget.observe({ ratelimit: '"perday";r=18' }, 200);
  clock.now = Date.parse('2026-10-13T10:05:00Z'); // 12:05: the window rolled
  assert.equal(budget.left(), 100, 'assumed fresh');
  budget.observe({ ratelimit: '"perday";r=17' }, 200);
  assert.equal(budget.left(), 17);
  assert.equal(budget.resetAt, clock.now + SHORT_PAUSE, 'not tomorrow');
  clock.now += SHORT_PAUSE;
  budget.observe({ ratelimit: '"perday";r=16' }, 200);
  assert.equal(budget.resetAt, clock.now + 2 * SHORT_PAUSE, 'growing');
  // tado reset: a fresh count, the next reset is tomorrow's.
  clock.now += 2 * SHORT_PAUSE;
  budget.observe({ ratelimit: '"perday";r=99' }, 200);
  assert.equal(budget.lateStreak, 0);
  assert.equal(budget.resetAt, Date.parse('2026-10-14T10:00:00Z'));
  // Hours later, a low count is just a busy day.
  clock.now = Date.parse('2026-10-13T15:00:00Z');
  budget.observe({ ratelimit: '"perday";r=10' }, 200);
  assert.equal(budget.resetAt, Date.parse('2026-10-14T10:00:00Z'));
});

test('the late pause grows once per pause, whatever the number of answers', () => {
  for (const answers of [1, 4]) {
    const clock = { now: Date.parse('2026-10-13T10:05:00Z') }; // 12:05 in Berlin
    const budget = new RateBudget({ now: () => clock.now });
    budget.readingCost = 2 * answers;
    const stale = () => {
      for (let i = 0; i < answers; i++) {
        budget.observe({ ratelimit: '"perday";r=17' }, 200);
      }
    };
    stale();
    assert.equal(budget.resetAt, clock.now + SHORT_PAUSE, `${answers} answers: 15 min`);
    clock.now = budget.resetAt;
    stale();
    assert.equal(budget.resetAt, clock.now + 2 * SHORT_PAUSE, `${answers} answers: 30 min`);
    clock.now = budget.resetAt;
    stale();
    assert.equal(budget.resetAt, clock.now + 4 * SHORT_PAUSE, `${answers} answers: 1 h`);
  }
});

test('a low but usable count just after noon is a busy day, not a late tado', () => {
  const clock = { now: Date.parse('2026-10-13T10:05:00Z') };
  const budget = new RateBudget({ now: () => clock.now });
  budget.readingCost = 2;
  // Another app spent 30 requests since noon: 68 left, well above the reserve.
  budget.observe({ ratelimit: '"perday";r=68' }, 200);
  assert.equal(budget.resetAt, Date.parse('2026-10-14T10:00:00Z'), 'tomorrow, as usual');
  // At the reserve, the same doubt does pause briefly (the poller stops anyway).
  budget.observe({ ratelimit: '"perday";r=21' }, 200);
  assert.equal(budget.resetAt, clock.now + SHORT_PAUSE);
});
