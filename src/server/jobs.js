/**
 * The job store and the queue that runs them.
 *
 * Jobs are held in memory and executed strictly one at a time. The one-at-a-time
 * part is not a simplification to be optimised away later: the portals behind
 * this agent are reached with a single shared login each, and signing in again
 * while a session is open invalidates the session already held. Two concurrent
 * runs against the same portal would therefore not be twice as fast, they would
 * take each other's session away. A queue here is a real wait.
 *
 * The statuses are the ones KYCDD polls for, and the vocabulary is fixed by
 * {@link ../app/RemoteBrowser/RemoteAgent.php}: `queued` and `running` are
 * non-terminal, and `succeeded`, `failed` and `cancelled` are terminal. Once a
 * job is terminal it never changes again, which is what stops a runner that is
 * still unwinding from overwriting the outcome of a job that was cancelled or
 * timed out underneath it.
 */

import crypto from 'node:crypto';

import * as artifacts from './artifacts.js';

const STATUS_QUEUED = 'queued';
const STATUS_RUNNING = 'running';
const STATUS_SUCCEEDED = 'succeeded';
const STATUS_FAILED = 'failed';
const STATUS_CANCELLED = 'cancelled';

const TERMINAL_STATUSES = [STATUS_SUCCEEDED, STATUS_FAILED, STATUS_CANCELLED];

/**
 * Outcomes this layer produces. Anything a run reports from inside a portal
 * comes from that service's own `dead_ends` and passes through untouched, so
 * that "the portal had nothing" is never confused with "the agent broke".
 */
const OUTCOME_TIMED_OUT = 'run_timed_out';
const OUTCOME_CANCELLED = 'run_cancelled';
const OUTCOME_FAILED = 'run_failed';
const OUTCOME_QUEUE_FULL = 'agent_queue_full';

/**
 * How many steps of a run's log to keep.
 *
 * The log is for diagnosis, and a run that has taken more steps than this has
 * lost its way rather than made progress, so the tail is what matters. Keeping
 * it bounded also stops one confused run from growing until it is the only thing
 * in memory.
 */
const STEP_LOG_CAP = 200;

class Jobs {
    /**
     * @param {object} config
     * @param {function} runTask The task runner, see runner.js. Injected so the
     *        queue can be exercised without a browser, and so that this file has
     *        no opinion about how a task is actually performed.
     */
    constructor(config, runTask) {
        this.config = config;
        this.runTask = runTask;

        /** @type {Map<string, object>} */
        this.jobs = new Map();

        /** @type {string[]} */
        this.queue = [];

        this.running = null;

        this.sweeper = setInterval(() => this.sweep(), 60000);
        this.sweeper.unref();
    }

    /**
     * Accepts a task, or says why it was not accepted.
     *
     * @param {object} envelope
     * @param {string|null} idempotencyKey
     * @returns {{job: object, replayed: boolean} | {error: string}}
     */
    dispatch(envelope, idempotencyKey) {
        const invalid = this.validate(envelope);

        if (invalid) {
            return {error: invalid};
        }

        /**
         * A repeat dispatch rejoins the run it already started.
         *
         * This is the case the whole idempotency scheme exists for: KYCDD gives a
         * dispatch 30 seconds, and a response lost on the way back leaves it
         * believing nothing started. Without this, its retry would open a second
         * browser and sign in again as the same user, taking the session away
         * from the run already in progress.
         */
        if (idempotencyKey) {
            const existing = this.findByIdempotencyKey(idempotencyKey);

            if (existing) {
                return {job: existing, replayed: true};
            }
        }

        if (this.queue.length >= this.config.maxQueueDepth) {
            return {error: `the agent already has ${this.queue.length} tasks waiting`, outcome: OUTCOME_QUEUE_FULL};
        }

        const job = {
            id: crypto.randomBytes(16).toString('hex'),
            status: STATUS_QUEUED,
            envelope,
            idempotencyKey,

            outcome: null,
            error: null,
            result: null,

            steps: [],
            stepsTaken: 0,
            artifacts: [],

            created: Date.now(),
            started: null,
            finished: null,

            abort: new AbortController(),
            timer: null,
        };

        this.jobs.set(job.id, job);
        this.queue.push(job.id);

        this.pump();

        return {job, replayed: false};
    }

    /**
     * Checks the envelope is one this build can actually carry out.
     *
     * An unknown version is refused rather than run. It means KYCDD is sending
     * fields this agent does not know about, and quietly ignoring part of an
     * instruction while driving a logged-in browser is worse than not running.
     *
     * @param {object} envelope
     * @returns {string|null} The reason it was refused, or NULL if it is fine.
     */
    validate(envelope) {
        if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
            return 'the task envelope is not an object';
        }

        const version = String(envelope.version || '');

        if (!this.config.supportedEnvelopeVersions.includes(version)) {
            return `envelope version "${version}" is not supported by this agent`;
        }

        if (!envelope.service || typeof envelope.service !== 'object') {
            return 'the envelope names no service';
        }

        if (!envelope.instructions || typeof envelope.instructions !== 'object') {
            return 'the envelope carries no instructions';
        }

        if (!envelope.result_schema || typeof envelope.result_schema !== 'object') {
            return 'the envelope carries no result schema';
        }

        return null;
    }

    /**
     * Finds a job still inside its idempotency window for this key.
     *
     * The window matters because the key is derived from the service and the
     * inputs alone, with nothing per-attempt in it, so the same work next week
     * carries the same key. Collapsing has to expire or a legitimate second run
     * could never be asked for. A job that is still running always matches,
     * however old, because there is no sense in starting a second one while the
     * first holds the session.
     *
     * @param {string} key
     * @returns {object|null}
     */
    findByIdempotencyKey(key) {
        const cutoff = Date.now() - (this.config.idempotencyWindowSeconds * 1000);

        for (const job of this.jobs.values()) {
            if (job.idempotencyKey !== key) {
                continue;
            }

            if (!TERMINAL_STATUSES.includes(job.status) || job.created >= cutoff) {
                return job;
            }
        }

        return null;
    }

    /**
     * @param {string} id
     * @returns {object|undefined}
     */
    get(id) {
        return this.jobs.get(id);
    }

    /**
     * Stops a job.
     *
     * A queued job is dropped before it starts. A running job is marked
     * cancelled and its abort signal raised, so the runner stops at its next
     * check and closes the browser rather than being left holding a session
     * open. The job is terminal from this moment: whatever the runner reports as
     * it unwinds is discarded.
     *
     * @param {string} id
     * @returns {object|undefined}
     */
    cancel(id) {
        const job = this.jobs.get(id);

        if (!job || TERMINAL_STATUSES.includes(job.status)) {
            return job;
        }

        this.queue = this.queue.filter((queued) => queued !== id);
        this.settle(job, STATUS_CANCELLED, OUTCOME_CANCELLED, 'The run was cancelled.');
        job.abort.abort();

        return job;
    }

    /**
     * Starts the next job, if nothing is running.
     *
     * @returns {void}
     */
    pump() {
        if (this.running || this.queue.length === 0) {
            return;
        }

        const job = this.jobs.get(this.queue.shift());

        if (!job || TERMINAL_STATUSES.includes(job.status)) {
            // Cancelled while it waited
            this.pump();
            return;
        }

        this.running = job.id;
        job.status = STATUS_RUNNING;
        job.started = Date.now();

        /**
         * The agent holds its own deadline as well as being sent one, because
         * KYCDD's deadline only stops KYCDD waiting - it does nothing about a
         * browser still open on this machine. Whichever fires first, the run ends
         * and the session is released.
         */
        const timeoutSeconds = Number(envelopeLimit(job.envelope, 'timeout_seconds', 600));

        job.timer = setTimeout(() => {
            this.settle(job, STATUS_FAILED, OUTCOME_TIMED_OUT, `The run did not finish within ${timeoutSeconds} seconds.`);
            job.abort.abort();
        }, timeoutSeconds * 1000);

        this.execute(job).catch((error) => {
            // A runner that throws outside its own handling must not stall the queue
            this.settle(job, STATUS_FAILED, OUTCOME_FAILED, error && error.message ? error.message : String(error));
        });
    }

    /**
     * Runs one job and records what it reported.
     *
     * @param {object} job
     * @returns {Promise<void>}
     */
    async execute(job) {
        try {
            const outcome = await this.runTask({
                envelope: job.envelope,
                signal: job.abort.signal,
                config: this.config,

                /**
                 * Handed to the runner so progress is visible while a run is in
                 * flight: KYCDD polls every three seconds and shows these as the
                 * steps of the attempt. Nothing secret belongs in a step - the
                 * credentials are resolved on this machine precisely so they stay
                 * off the wire, and a step log is sent back over it.
                 */
                recordStep: (step, detail) => this.recordStep(job, step, detail),

                putArtifact: (artifact) => {
                    const record = artifacts.put(this.config, job.id, artifact);
                    job.artifacts.push(record);

                    return record;
                },
            });

            if (outcome && outcome.ok) {
                this.settle(job, STATUS_SUCCEEDED, 'succeeded', null, outcome.result);
                return;
            }

            /**
             * A failure the runner classified - typically one of the service's own
             * dead ends, such as a portal with no such licence or a rejected
             * sign-in. Passed through as reported, because that is more use to
             * KYCDD than a generic failure.
             */
            this.settle(
                job,
                STATUS_FAILED,
                (outcome && outcome.outcome) || OUTCOME_FAILED,
                (outcome && outcome.error) || 'The run failed.',
            );
        } catch (error) {
            this.settle(job, STATUS_FAILED, OUTCOME_FAILED, error && error.message ? error.message : String(error));
        }
    }

    /**
     * Appends to a job's step log.
     *
     * @param {object} job
     * @param {string} step
     * @param {object|null} detail
     * @returns {void}
     */
    recordStep(job, step, detail) {
        job.stepsTaken += 1;

        if (job.steps.length >= STEP_LOG_CAP) {
            return;
        }

        job.steps.push({
            step: job.stepsTaken,
            at: new Date().toISOString(),
            name: String(step),
            detail: detail === undefined ? null : detail,
        });
    }

    /**
     * Moves a job to a terminal status, once.
     *
     * Everything that ends a run goes through here - success, failure, the
     * deadline, a cancel - so there is one place where terminal means terminal.
     * A late report from a runner that was aborted finds the job already settled
     * and is dropped, which is what keeps a cancelled job cancelled.
     *
     * @param {object} job
     * @param {string} status
     * @param {string} outcome
     * @param {string|null} error
     * @param {object|null} result
     * @returns {void}
     */
    settle(job, status, outcome, error, result = null) {
        if (TERMINAL_STATUSES.includes(job.status)) {
            return;
        }

        job.status = status;
        job.outcome = outcome;
        job.error = error;
        job.result = result;
        job.finished = Date.now();

        if (job.timer) {
            clearTimeout(job.timer);
            job.timer = null;
        }

        if (this.running === job.id) {
            this.running = null;
            this.pump();
        }
    }

    /**
     * The job as KYCDD polls it.
     *
     * The field names are the ones `RemoteAgent::settle()` reads, so they are not
     * free to rename: `status`, `outcome`, `error`, `result`, `steps`,
     * `steps_taken` and `artifacts`. The artifact records go out; their bytes do
     * not, and are fetched separately.
     *
     * @param {object} job
     * @returns {object}
     */
    static toJson(job) {
        return {
            job_id: job.id,
            status: job.status,
            outcome: job.outcome,
            error: job.error,
            result: job.result,
            steps: job.steps,
            steps_taken: job.stepsTaken,
            artifacts: job.artifacts,
            created: new Date(job.created).toISOString(),
            started: job.started ? new Date(job.started).toISOString() : null,
            finished: job.finished ? new Date(job.finished).toISOString() : null,
        };
    }

    /**
     * Purges finished jobs and their artifacts once their retention has passed.
     *
     * Short retention is a security measure, not housekeeping. A finished Growth
     * job holds the session cookie it harvested, which carries an identity token
     * with the signed-in person's name, Emirates ID and telephone number. KYCDD
     * reads it within seconds of the run finishing and stores what it needs, so
     * there is no reason for it to stay here.
     *
     * @returns {void}
     */
    sweep() {
        const cutoff = Date.now() - (this.config.jobRetentionSeconds * 1000);

        for (const [id, job] of this.jobs) {
            if (!TERMINAL_STATUSES.includes(job.status) || !job.finished || job.finished > cutoff) {
                continue;
            }

            artifacts.purge(this.config, id);
            this.jobs.delete(id);
        }
    }
}

/**
 * Reads one of the envelope's limits, with a fallback.
 *
 * @param {object} envelope
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function envelopeLimit(envelope, name, fallback) {
    const value = Number(((envelope && envelope.limits) || {})[name]);

    return Number.isFinite(value) && value > 0 ? value : fallback;
}

export {
    Jobs,
    STATUS_QUEUED,
    STATUS_RUNNING,
    STATUS_SUCCEEDED,
    STATUS_FAILED,
    STATUS_CANCELLED,
    TERMINAL_STATUSES,
    envelopeLimit,
};
