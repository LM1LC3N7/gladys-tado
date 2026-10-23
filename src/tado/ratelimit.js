// -----------------------------------------------------------------------------
// tado's daily API quota. Since late 2025 tado counts the requests of an
// account per day: 100 on a free account, 20,000 with an Auto-Assist /
// AI-Assist subscription, reset around 12:00 Europe/Berlin. Every API answer
// advertises the budget (IETF "RateLimit" draft headers):
//
//   ratelimit:        "perday";r=<remaining>[;t=<seconds until the reset>]
//   ratelimit-policy: "perday";q=<quota>;w=86400
//
// and an exhausted budget answers HTTP 429. RateBudget tracks these values;
// pollDelay() turns them into the delay of the next reading. Pure (the clock
// is injected), no network.
//
// The idea of a budget-aware poller comes from RouXx67/gladys-tado-integration
// (MIT); this is an independent implementation.
// -----------------------------------------------------------------------------

/** Assumed before tado sent any header: the free tier, so day one is safe. */
export const FREE_QUOTA = 100;
/** From this quota on, the account is subscribed: the user's interval applies. */
export const SUBSCRIPTION_QUOTA = 1000;
/** Share of the quota kept for the commands (setpoints from widgets, scenes). */
export const RESERVE_SHARE = 0.2;
export const MIN_RESERVE = 10;
/** tado resets "around" noon: resume a little after, not at the exact second. */
export const RESET_MARGIN = 5 * 60_000;
/** A 429 that is not the daily quota (budget left): a short pause only. */
export const SHORT_PAUSE = 15 * 60_000;
/**
 * A 429 without any time, this long after the expected reset: tado is late
 * to reset (its "around noon"), so retry soon (growing pauses) rather than
 * wait a whole day.
 */
export const LATE_RESET_WINDOW = 2 * 60 * 60_000;
/**
 * The longest wait a header may ask for. Past 2^31-1 ms Node fires a timer
 * after 1 ms: a huge `t=` or a far `Retry-After` would make a tight loop.
 */
export const MAX_WAIT = 2 * 24 * 60 * 60_000;
/**
 * What one reading costs at most for one home (zone states, presence,
 * weather, zone list, phones): the default of RateBudget.readingCost until
 * the app sets the real figure for all its homes.
 */
export const HOME_READING_COST = 5;

const DAY = 24 * 60 * 60_000;
const RESET_TIME_ZONE = 'Europe/Berlin';
const RESET_HOUR = 12;
/** Bigger numbers are garbage, not a tado quota. */
const MAX_SANE = 10_000_000;

// --- Header parsing ----------------------------------------------------------------

function header(headers, name) {
  if (!headers) {
    return undefined;
  }
  if (typeof headers.get === 'function') {
    return headers.get(name) ?? undefined;
  }
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

const unquote = (s) => s.trim().replace(/^"(.*)"$/, '$1');

/**
 * One header value of the RateLimit draft: a list of items
 * `"name";key=value;...`. Resolves the "perday" item (else the first one) as
 * { name, params } with the integer params only; anything else is ignored.
 */
export function parseRateLimitItem(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  const items = value.split(',').map((raw) => {
    const [name, ...parts] = raw.split(';');
    const params = {};
    for (const part of parts) {
      const at = part.indexOf('=');
      if (at <= 0) {
        continue;
      }
      const key = part.slice(0, at).trim().toLowerCase();
      const text = unquote(part.slice(at + 1));
      if (/^\d+$/.test(text) && Number(text) <= MAX_SANE) {
        params[key] = Number(text);
      }
    }
    return { name: unquote(name).toLowerCase(), params };
  });
  return items.find((i) => i.name === 'perday') ?? items[0];
}

/** { remaining, resetIn (s) } from `ratelimit`, each undefined when absent. */
export function parseRateLimit(value) {
  const params = parseRateLimitItem(value)?.params ?? {};
  const resetIn = params.t === undefined ? undefined : Math.min(params.t, MAX_WAIT / 1000);
  return { remaining: params.r, resetIn };
}

/** { quota, window (s) } from `ratelimit-policy`; a quota of 0 is garbage. */
export function parseRateLimitPolicy(value) {
  const params = parseRateLimitItem(value)?.params ?? {};
  return { quota: params.q > 0 ? params.q : undefined, window: params.w };
}

/**
 * `Retry-After` (seconds or an HTTP date) -> a timestamp, or undefined.
 * Capped at MAX_WAIT from now.
 */
export function parseRetryAfter(value, now) {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  const text = value.trim();
  let at;
  if (/^\d+$/.test(text)) {
    at = Number(text) <= MAX_SANE ? now + Number(text) * 1000 : undefined;
  } else {
    const date = Date.parse(text);
    at = Number.isFinite(date) && date > now ? date : undefined;
  }
  return at === undefined ? undefined : Math.min(at, now + MAX_WAIT);
}

// --- The reset time ----------------------------------------------------------------

/** Offset (ms) of Europe/Berlin from UTC at `at`. */
// Built once: a formatter is costly and the reset is computed at every answer.
const BERLIN = new Intl.DateTimeFormat('en-GB', {
  timeZone: RESET_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
});

function berlinOffset(at) {
  const parts = Object.fromEntries(BERLIN.formatToParts(at).map((p) => [p.type, Number(p.value)]));
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return wall - Math.floor(at / 60_000) * 60_000;
}

/** The 12:00 Europe/Berlin of the days around `now`, oldest first (DST-aware). */
function noonsAround(now) {
  const offset = berlinOffset(now);
  const wall = new Date(now + offset);
  const noons = [];
  for (let days = -1; days <= 2; days++) {
    const noonWall = Date.UTC(
      wall.getUTCFullYear(),
      wall.getUTCMonth(),
      wall.getUTCDate() + days,
      RESET_HOUR,
    );
    // The offset of the target day (it differs across a DST change).
    noons.push(noonWall - berlinOffset(noonWall - offset));
  }
  return noons;
}

/** The next 12:00 Europe/Berlin strictly after `now`. */
export function nextDailyReset(now) {
  return noonsAround(now).find((noon) => noon > now) ?? now + DAY;
}

/** The last 12:00 Europe/Berlin at or before `now`. */
export function previousDailyReset(now) {
  return noonsAround(now).findLast((noon) => noon <= now) ?? now - DAY;
}

// --- The budget --------------------------------------------------------------------

export class RateBudget {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.reset();
  }

  /** Forget everything (another account): in place, the client holds it. */
  reset() {
    this.quota = undefined; // from ratelimit-policy
    this.remaining = undefined; // from ratelimit, decremented in between
    this.peak = 0; // the highest `r` seen: a quota hint without a policy
    this.resetAt = undefined;
    this.spent = 0; // calls counted locally in the current window
    this.lateStreak = 0; // late pauses in a row while tado is late to reset
    this.lateUntil = 0; // the end of the current late pause
    this.readingCost = HOME_READING_COST; // set by the app: calls of one reading
    this.answers = 0; // every answer ever observed (never rolls)
  }

  /**
   * The quota: the policy header, else the highest remaining count seen
   * when it exceeds the free tier (a subscription), else the free tier.
   */
  get limit() {
    return this.quota ?? (this.peak > FREE_QUOTA ? this.peak : FREE_QUOTA);
  }

  get subscribed() {
    return this.limit >= SUBSCRIPTION_QUOTA;
  }

  /** Calls kept for the commands: the poller never goes below. */
  get reserve() {
    return Math.max(MIN_RESERVE, Math.ceil(this.limit * RESERVE_SHARE));
  }

  /** Past the reset: a fresh day, the remaining budget is the quota again. */
  roll() {
    const now = this.now();
    if (this.resetAt === undefined) {
      this.resetAt = nextDailyReset(now);
    } else if (now >= this.resetAt) {
      this.remaining = undefined;
      this.spent = 0;
      this.resetAt = nextDailyReset(now);
    }
  }

  /** The calls left until the reset (estimated when tado said nothing yet). */
  left() {
    this.roll();
    return this.remaining ?? Math.max(0, this.limit - this.spent);
  }

  /**
   * One tado answer (any status). For a 429, resolves { retryAt, daily }:
   * the time the poller has to wait for, and whether it is the daily quota
   * (else a burst limit or a late reset: a short pause). Undefined otherwise.
   */
  observe(headers, status) {
    this.roll();
    const now = this.now();
    this.spent += 1;
    this.answers += 1;
    const { quota } = parseRateLimitPolicy(header(headers, 'ratelimit-policy'));
    if (quota !== undefined) {
      this.quota = quota;
    }
    const { remaining, resetIn } = parseRateLimit(header(headers, 'ratelimit'));
    if (remaining !== undefined) {
      this.remaining = remaining;
      this.peak = Math.max(this.peak, remaining);
    } else if (this.remaining !== undefined) {
      // An answer without the header (another host?) still costs a call.
      this.remaining = Math.max(0, this.remaining - 1);
    }
    if (resetIn !== undefined) {
      this.resetAt = now + resetIn * 1000;
    }
    if (status !== 429) {
      if (remaining !== undefined && resetIn === undefined && this.staleAfterReset(remaining)) {
        // tado has not reset yet: this is still yesterday's budget. Look
        // again soon instead of waiting for tomorrow's reset.
        this.resetAt = now + this.latePause();
      } else if (remaining !== undefined) {
        this.lateStreak = 0;
        this.lateUntil = 0;
      }
      return undefined;
    }
    const retryAfter = parseRetryAfter(header(headers, 'retry-after'), now);
    if (remaining > 0) {
      // Budget left: a burst limit, not the daily quota.
      return { retryAt: retryAfter ?? now + SHORT_PAUSE, daily: false };
    }
    this.remaining = 0;
    if (retryAfter !== undefined) {
      this.lateStreak = 0;
      this.lateUntil = 0;
      this.resetAt = retryAfter;
      return { retryAt: retryAfter, daily: true };
    }
    if (resetIn !== undefined) {
      this.lateStreak = 0;
      this.lateUntil = 0;
      return { retryAt: this.resetAt, daily: true };
    }
    // No time given. Just after the expected reset, tado is only late.
    if (this.justAfterReset()) {
      this.resetAt = now + this.latePause();
      return { retryAt: this.resetAt, daily: false };
    }
    this.lateStreak = 0;
    this.lateUntil = 0;
    this.resetAt = nextDailyReset(now);
    return { retryAt: this.resetAt, daily: true };
  }

  justAfterReset() {
    const now = this.now();
    return now - previousDailyReset(now) < LATE_RESET_WINDOW;
  }

  /**
   * 15 min, 30 min, 1 h, 2 h: the pauses while tado is late to reset. The
   * sequence grows once per pause, not once per answer: the several answers
   * of one reading (several homes) share the same pause.
   */
  latePause() {
    const now = this.now();
    if (now < this.lateUntil) {
      return this.lateUntil - now;
    }
    const pause = Math.min(SHORT_PAUSE * 2 ** this.lateStreak, LATE_RESET_WINDOW);
    this.lateStreak += 1;
    this.lateUntil = now + pause;
    return pause;
  }

  /**
   * Just after the expected reset, without a `t=`, a remaining count far
   * below a fresh quota (minus the calls counted since, minus the reserve
   * for other apps sharing the account) is the old day's: tado is late.
   */
  staleAfterReset(remaining) {
    return (
      this.justAfterReset() &&
      remaining < this.limit - this.spent - this.reserve &&
      // Only when that count would stop the poller anyway: a low but usable
      // count is as likely a busy noon (another app on the account) as a
      // late tado, and a short window would squeeze the whole day's
      // readings into a few minutes.
      remaining - this.reserve < this.readingCost
    );
  }

  snapshot() {
    this.roll(); // resetAt must be the current window's
    return {
      quota: this.limit,
      remaining: this.left(),
      resetAt: this.resetAt,
      reserve: this.reserve,
      subscribed: this.subscribed,
    };
  }
}

/**
 * The delay of the next reading: the calls left above the reserve, spread
 * evenly until the reset, never faster than the user's interval.
 *
 *   cycles = (left - reserve) / callsPerCycle
 *   delay  = max(minDelay, (resetAt - now) / cycles)
 *
 * Not even one cycle above the reserve: wait for the reset (`paused`).
 */
export function pollDelay({ left, reserve, resetAt, now, callsPerCycle, minDelay }) {
  const window = Math.max(0, resetAt - now);
  const calls = Math.max(1, callsPerCycle);
  const usable = left - reserve;
  if (usable < calls) {
    return { delay: Math.max(minDelay, window + RESET_MARGIN), paused: true };
  }
  return { delay: Math.max(minDelay, Math.ceil(window / (usable / calls))), paused: false };
}
