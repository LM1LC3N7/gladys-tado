// -----------------------------------------------------------------------------
// The only place that talks to the network: `fetch` with a timeout and an
// identifiable User-Agent. The tests replace it with `setFetch()`.
//
// tado's daily quota: a request given a `budget` (src/tado/ratelimit.js)
// feeds it the headers of every answer, errors included, and a 429 becomes a
// RateLimitError carrying the time the poller may try again.
// -----------------------------------------------------------------------------

import { HTTP_TIMEOUT, USER_AGENT } from './constants.js';
import { SHORT_PAUSE, parseRetryAfter } from './tado/ratelimit.js';

let fetchImpl = (...args) => globalThis.fetch(...args);

/** Replace the fetch implementation (tests only). Returns the previous one. */
export function setFetch(impl) {
  const previous = fetchImpl;
  fetchImpl = impl;
  return previous;
}

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} on ${new URL(url).pathname}${body ? `: ${body}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

/**
 * HTTP 429: no request until `retryAt` (a timestamp). `daily`: tado's daily
 * quota is used up (else a burst limit or a late reset: a short pause).
 */
export class RateLimitError extends HttpError {
  constructor(url, body, retryAt, daily = false) {
    super(429, url, body);
    this.name = 'RateLimitError';
    this.retryAt = retryAt;
    this.daily = daily;
  }
}

/**
 * One request. `body` is JSON-encoded (or form-encoded with `form: true`);
 * resolves the parsed JSON answer (undefined on an empty body), throws an
 * HttpError on a non-2xx status (a RateLimitError on a 429). `budget`, when
 * given, observes the rate-limit headers of the answer.
 */
export async function request(
  url,
  {
    method = 'GET',
    headers = {},
    body,
    form = false,
    timeout = HTTP_TIMEOUT,
    budget,
    now = Date.now,
  } = {},
) {
  const init = {
    method,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(Math.max(1, timeout)),
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
    init.body = form ? new URLSearchParams(body).toString() : JSON.stringify(body);
  }
  const response = await fetchImpl(url, init);
  const limited = budget?.observe(response.headers, response.status);
  const text = await response.text();
  if (response.status === 429) {
    const retryAt =
      limited?.retryAt ??
      parseRetryAfter(response.headers.get('retry-after') ?? '', now()) ??
      now() + SHORT_PAUSE;
    throw new RateLimitError(url, text.slice(0, 300), retryAt, limited?.daily ?? false);
  }
  if (!response.ok) {
    throw new HttpError(response.status, url, text.slice(0, 300));
  }
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
