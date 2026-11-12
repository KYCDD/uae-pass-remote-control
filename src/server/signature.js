/**
 * Request authentication.
 *
 * Every request carries a bearer token saying which caller it is, and an HMAC
 * over its own method, path, timestamp and body proving it was not tampered with
 * or replayed. The token alone would not be enough: this machine drives a
 * credentialed browser for anything that can reach the port, so a request
 * captured once must not be usable twice, and must not be redirectable at a
 * different job by editing its path.
 *
 * The scheme is fixed by the caller, {@link ../app/RemoteBrowser/RemoteAgent.php}
 * `sign()`, and must be reproduced byte for byte:
 *
 *     HMAC-SHA256( METHOD \n PATH \n TIMESTAMP \n SHA256(BODY) , secret )
 *
 * Three details in that are easy to get wrong and each one breaks every request:
 *
 *  - PATH is the path exactly as it arrived, still percent-encoded, without the
 *    query string and without the base URL. Normalising or decoding it first
 *    produces a different string from the one that was signed.
 *  - BODY is hashed over the raw bytes received. Re-serialising the parsed JSON
 *    is not the same thing: the caller encodes with PHP's JSON_UNESCAPED_UNICODE
 *    and JSON_UNESCAPED_SLASHES, and any difference in escaping, key order or
 *    spacing changes the hash.
 *  - A request with no body hashes the empty string, not the string "null".
 */

import crypto from 'node:crypto';

const HEADER_TIMESTAMP = 'x-kycdd-timestamp';
const HEADER_SIGNATURE = 'x-kycdd-signature';
const HEADER_IDEMPOTENCY = 'x-kycdd-idempotency-key';

/**
 * Signatures already seen, against the time they were seen.
 *
 * The timestamp window alone stops a request being replayed tomorrow, but not
 * from being replayed twice inside the window. Remembering each signature until
 * its window has passed closes that, and the set cannot grow without bound
 * because anything older than the window is both pruned and refused on its
 * timestamp anyway.
 *
 * @type {Map<string, number>}
 */
const seen = new Map();

/**
 * Compares two strings without leaking how much of them matched.
 *
 * Length is compared first and separately, because timingSafeEqual throws on
 * mismatched lengths; that leak is harmless here, since the lengths of a token
 * and of a hex digest are not secrets.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEquals(a, b) {
    const left = Buffer.from(String(a), 'utf8');
    const right = Buffer.from(String(b), 'utf8');

    if (left.length !== right.length) {
        return false;
    }

    return crypto.timingSafeEqual(left, right);
}

/**
 * The path as it was signed: what arrived, minus the query string.
 *
 * Taken from the raw request target rather than through the URL parser, which
 * would resolve away the very characters the caller signed.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
function signedPath(req) {
    const target = req.url || '/';
    const queryAt = target.indexOf('?');

    return queryAt === -1 ? target : target.slice(0, queryAt);
}

/**
 * Drops remembered signatures whose replay window has passed.
 *
 * @param {number} nowSeconds
 * @param {number} windowSeconds
 * @returns {void}
 */
function pruneSeen(nowSeconds, windowSeconds) {
    for (const [signature, at] of seen) {
        if (nowSeconds - at > windowSeconds) {
            seen.delete(signature);
        }
    }
}

/**
 * Authenticates one request.
 *
 * Returns a reason rather than throwing, so the caller decides the status code
 * and so the reason can be logged without any of the request's own content.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {Buffer} rawBody The exact bytes received.
 * @param {object} config
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function verify(req, rawBody, config) {
    const authorization = req.headers.authorization || '';
    const timestamp = req.headers[HEADER_TIMESTAMP];
    const signature = req.headers[HEADER_SIGNATURE];

    if (!authorization.startsWith('Bearer ')) {
        return {ok: false, reason: 'missing bearer token'};
    }

    if (!timingSafeEquals(authorization.slice('Bearer '.length), config.token)) {
        return {ok: false, reason: 'bearer token rejected'};
    }

    if (!timestamp || !signature) {
        return {ok: false, reason: 'missing signature headers'};
    }

    const sentAt = Number.parseInt(String(timestamp), 10);

    if (!Number.isInteger(sentAt)) {
        return {ok: false, reason: 'timestamp is not an integer'};
    }

    const nowSeconds = Math.floor(Date.now() / 1000);

    if (Math.abs(nowSeconds - sentAt) > config.clockSkewSeconds) {
        // Either genuine clock drift beyond what is tolerated, or a replay
        return {ok: false, reason: 'timestamp outside the accepted window'};
    }

    const payload = [
        String(req.method || '').toUpperCase(),
        signedPath(req),
        String(sentAt),
        crypto.createHash('sha256').update(rawBody).digest('hex'),
    ].join('\n');

    const expected = crypto.createHmac('sha256', config.secret).update(payload).digest('hex');

    if (!timingSafeEquals(String(signature), expected)) {
        return {ok: false, reason: 'signature did not verify'};
    }

    pruneSeen(nowSeconds, config.clockSkewSeconds);

    /**
     * A signature covers the method, the path, the timestamp and the body, so an
     * identical signature is necessarily the same request sent twice rather than
     * two requests that happen to look alike.
     *
     * Dispatches are the exception: KYCDD retries a dispatch it never got an
     * answer to, and that retry is the case idempotency keys exist to handle, so
     * it has to reach the handler to be collapsed onto the running job rather
     * than being refused here as a replay.
     */
    if (!req.headers[HEADER_IDEMPOTENCY]) {
        if (seen.has(String(signature))) {
            return {ok: false, reason: 'signature already used'};
        }

        seen.set(String(signature), nowSeconds);
    }

    return {ok: true};
}

/**
 * The idempotency key on a dispatch, if it carried one.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {string|null}
 */
function idempotencyKey(req) {
    const key = req.headers[HEADER_IDEMPOTENCY];

    return key ? String(key) : null;
}

export {verify, idempotencyKey, signedPath};
