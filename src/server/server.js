/**
 * The HTTP endpoint KYCDD talks to.
 *
 * This is the other half of `app/RemoteBrowser/RemoteAgent.php`, and that file is
 * the specification: the four routes below, their field names, and the signing
 * scheme are all fixed by what it sends and reads. Changing any of them means
 * changing both sides together.
 *
 *     POST /tasks                             dispatch a task  -> {job_id}
 *     GET  /tasks/:id                         poll it          -> the job
 *     POST /tasks/:id/cancel                  stop it
 *     GET  /tasks/:id/artifacts/:artifactId   fetch one artifact's bytes
 *
 * Runs are long - a Growth session harvest waits on UAE Pass - so a dispatch
 * returns a job id immediately and KYCDD polls. That is why there is a job store
 * rather than a request that blocks: a dropped connection then costs a poll
 * rather than the whole run, and a run that has gone wrong can be cancelled from
 * the other side.
 *
 * Start it with `npm run serve` (`node src/server/server.js`). It refuses to
 * start without a token and secret, and binds to loopback unless
 * REMOTE_AGENT_HOST says otherwise.
 */

import http from 'node:http';
import fs from 'node:fs';

import { loadConfig, ConfigError } from '../config.js';
import * as signature from './signature.js';
import * as artifacts from './artifacts.js';
import { Jobs } from './jobs.js';
import { runTask } from '../runTask.js';

let config;

try {
	config = loadConfig({ server: true });
} catch (error) {
	console.error(error instanceof ConfigError ? error.message : String(error));
	process.exit(1);
}

const jobs = new Jobs(config, runTask);

/**
 * Reads the request body, refusing anything oversized.
 *
 * The raw bytes are kept, not a parsed object: the signature is computed over
 * exactly what was sent, and re-serialising parsed JSON would not reproduce it.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<{ok: true, raw: Buffer} | {ok: false, reason: string}>}
 */
function readBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        let bytes = 0;

        req.on('data', (chunk) => {
            bytes += chunk.length;

            if (bytes > config.maxBodyBytes) {
                // Stop reading rather than buffering the rest of it
                req.destroy();
                resolve({ok: false, reason: 'the request body is too large'});
                return;
            }

            chunks.push(chunk);
        });

        req.on('end', () => resolve({ok: true, raw: Buffer.concat(chunks)}));
        req.on('error', (error) => resolve({ok: false, reason: error.message}));
    });
}

/**
 * Sends a JSON response.
 *
 * Failures always carry an `error` string, because that is the field
 * `RemoteAgent::request()` reads to explain a non-2xx to the platform log.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {object} payload
 * @returns {void}
 */
function sendJson(res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');

    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': body.length,

        // Nothing here should ever be cached or indexed by anything in between
        'Cache-Control': 'no-store',
    });

    res.end(body);
}

/**
 * Splits the request path into decoded segments.
 *
 * The encoded form is what gets signed (see signature.js); this decoded form is
 * only used to route and to read ids out of.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {string[]}
 */
function segments(req) {
    return signature.signedPath(req)
        .split('/')
        .filter((segment) => segment.length > 0)
        .map((segment) => {
            try {
                return decodeURIComponent(segment);
            } catch (error) {
                // A malformed escape cannot match a route, so leave it as it came
                return segment;
            }
        });
}

/**
 * Handles one authenticated request.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {Buffer} raw
 * @returns {void}
 */
function route(req, res, raw) {
    const parts = segments(req);
    const method = String(req.method || '').toUpperCase();

    if (parts[0] !== 'tasks') {
        sendJson(res, 404, {error: 'no such route'});
        return;
    }

    // POST /tasks
    if (parts.length === 1) {
        if (method !== 'POST') {
            sendJson(res, 405, {error: 'only POST is accepted here'});
            return;
        }

        dispatch(req, res, raw);
        return;
    }

    const job = jobs.get(parts[1]);

    /**
     * A job that has been purged is indistinguishable from one that never
     * existed, and both are a 404. KYCDD only polls inside a run, and retention
     * is far longer than any run, so this normally means a stale id.
     */
    if (!job) {
        sendJson(res, 404, {error: 'no such job'});
        return;
    }

    res.jobId = job.id;

    // GET /tasks/:id
    if (parts.length === 2) {
        if (method !== 'GET') {
            sendJson(res, 405, {error: 'only GET is accepted here'});
            return;
        }

        sendJson(res, 200, Jobs.toJson(job));
        return;
    }

    // POST /tasks/:id/cancel
    if (parts.length === 3 && parts[2] === 'cancel') {
        if (method !== 'POST') {
            sendJson(res, 405, {error: 'only POST is accepted here'});
            return;
        }

        jobs.cancel(job.id);
        sendJson(res, 200, {job_id: job.id, status: job.status});
        return;
    }

    // GET /tasks/:id/artifacts/:artifactId
    if (parts.length === 4 && parts[2] === 'artifacts') {
        if (method !== 'GET') {
            sendJson(res, 405, {error: 'only GET is accepted here'});
            return;
        }

        sendArtifact(res, job, parts[3]);
        return;
    }

    sendJson(res, 404, {error: 'no such route'});
}

/**
 * Accepts a task.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {Buffer} raw
 * @returns {void}
 */
function dispatch(req, res, raw) {
    let envelope;

    try {
        envelope = JSON.parse(raw.toString('utf8'));
    } catch (error) {
        sendJson(res, 400, {error: 'the request body is not valid JSON'});
        return;
    }

    const accepted = jobs.dispatch(envelope, signature.idempotencyKey(req));

    if (accepted.error) {
        /**
         * A full queue is the one refusal worth separating. Runs are serialised
         * because the portals share a login, so a backlog is a real wait and
         * KYCDD should see it as "ask again later" rather than as a broken agent.
         */
        const status = accepted.outcome === 'agent_queue_full' ? 429 : 400;
        sendJson(res, status, {error: accepted.error, outcome: accepted.outcome || null});
        return;
    }

    res.jobId = accepted.job.id;
    res.note = accepted.replayed ? 'idempotent replay' : 'accepted';

    sendJson(res, accepted.replayed ? 200 : 202, {
        job_id: accepted.job.id,
        status: accepted.job.status,
        idempotent_replay: accepted.replayed,
    });
}

/**
 * Streams one artifact's bytes.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {object} job
 * @param {string} artifactId
 * @returns {void}
 */
function sendArtifact(res, job, artifactId) {
    const artifact = artifacts.read(config, job.id, artifactId, job.artifacts);

    if (!artifact) {
        sendJson(res, 404, {error: 'no such artifact'});
        return;
    }

    res.writeHead(200, {
        'Content-Type': artifact.mediaType,
        'Content-Length': artifact.data.length,
        'Cache-Control': 'no-store',
    });

    res.end(artifact.data);
}

/**
 * One line per request, written once the response has actually been sent.
 *
 * Hooked to the response rather than called at each branch, so that every path
 * out of the handler is logged exactly once and no new branch can quietly skip
 * it. Handlers add context by setting `jobId` and `note` on the response.
 *
 * Deliberately narrow: method, path, status, job id, and a short note. No
 * headers, because they carry the bearer token; no body, because an envelope
 * names a credential alias and a result can hold a session cookie with an
 * identity token in it. A log on a desktop machine is the last place any of that
 * should end up.
 *
 * The one thing not logged is a successful poll. KYCDD polls every three
 * seconds for as long as a run takes, and a quarter of an hour of "200 OK" would
 * bury the lines that matter. Everything else - dispatches, cancels, artifact
 * fetches, and every failure - is logged.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 */
function logWhenSent(req, res) {
    res.on('finish', () => {
        const method = String(req.method || '').toUpperCase();
        const path = signature.signedPath(req);
        const isPoll = method === 'GET' && /^\/tasks\/[^/]+$/.test(path);

        if (isPoll && res.statusCode === 200) {
            return;
        }

        const parts = [new Date().toISOString(), method, path, String(res.statusCode)];

        if (res.jobId) {
            parts.push(`job=${res.jobId}`);
        }

        if (res.note) {
            parts.push(`(${res.note})`);
        }

        console.log(parts.join(' '));
    });
}

const server = http.createServer(async (req, res) => {
    logWhenSent(req, res);

    try {
        /**
         * Liveness only, and unauthenticated on purpose so that whatever watches
         * this process does not need the shared secret. It says nothing but that
         * the process is up.
         */
        if (signature.signedPath(req) === '/health') {
            sendJson(res, 200, {ok: true});
            return;
        }

        const body = await readBody(req);

        if (!body.ok) {
            res.note = body.reason;
            sendJson(res, 413, {error: body.reason});
            return;
        }

        const authenticated = signature.verify(req, body.raw, config);

        if (!authenticated.ok) {
            /**
             * The reason is logged, because a machine that suddenly fails to
             * authenticate is usually a clock that has drifted or a secret that
             * was rotated on one side only, and that is worth being able to see.
             * It is not returned: a caller that cannot sign a request has no business
             * being told which part of the signature was wrong.
             */
            res.note = authenticated.reason;
            sendJson(res, 401, {error: 'authentication failed'});
            return;
        }

        route(req, res, body.raw);
    } catch (error) {
        res.note = error.message;
        sendJson(res, 500, {error: 'the agent failed to handle the request'});
    }
});

/**
 * Stops cleanly.
 *
 * Cancelling the running job matters more than closing the socket: an abandoned
 * run leaves a signed-in browser open on this machine, and for the portals
 * behind this agent that session is the thing being protected.
 *
 * @param {string} reason
 * @returns {void}
 */
function shutdown(reason) {
    console.log(`[server] shutting down (${reason})`);

    server.close();

    for (const job of jobs.jobs.values()) {
        jobs.cancel(job.id);
    }

    // Give the runner a moment to close the browser before the process goes
    setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

fs.mkdirSync(config.artifactDir, {recursive: true});

server.listen(config.port, config.host, () => {
    console.log(`[server] listening on http://${config.host}:${config.port}`);
    console.log(`[server] artifacts in ${config.artifactDir}`);
    console.log(`[server] envelope versions supported: ${config.supportedEnvelopeVersions.join(', ')}`);
});
