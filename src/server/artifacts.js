/**
 * The artifact store: screenshots and downloaded documents a run produced.
 *
 * Artifacts are deliberately not returned inside the poll response. A run that
 * captures the screen at every step is tens of megabytes, almost none of which
 * anyone ever looks at, so the poll carries only the records - id, kind, size -
 * and KYCDD fetches the bytes of the few it actually wants through
 * `RemoteAgent::fetchArtifact()`.
 *
 * They are written to disk rather than held in memory for the same reason: a
 * queue of finished jobs each holding a handful of full-page PNGs is how a
 * long-lived service on a desktop machine runs itself out of memory.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Only these are servable, and the extension each one is stored under.
 *
 * An allow-list rather than a free-text content type, because the value ends up
 * in a response header and in a filename, and neither should be attacker-chosen
 * even when the attacker is only a confused agent loop.
 */
const MEDIA_TYPES = Object.freeze({
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'application/json': '.json',
});

const DEFAULT_MEDIA_TYPE = 'application/octet-stream';

/**
 * Ids are hex, so a path can never be built out of one. Validated on the way out
 * as well as generated on the way in, because the id in a fetch request comes
 * from the network.
 */
const ID_PATTERN = /^[0-9a-f]{32}$/;
const JOB_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Makes sure the directory for a job exists.
 *
 * @param {string} artifactDir
 * @param {string} jobId
 * @returns {string}
 */
function jobDir(artifactDir, jobId) {
    if (!JOB_ID_PATTERN.test(jobId)) {
        throw new Error('Refusing to build an artifact path from a malformed job id.');
    }

    return path.join(artifactDir, jobId);
}

/**
 * Stores one artifact and returns the record that goes in the job's artifact
 * list.
 *
 * The record carries no path. KYCDD addresses an artifact by job and id, and
 * resolving that to a file is this module's business, so a path never travels
 * over the wire where it could be asked for directly.
 *
 * @param {object} config
 * @param {string} jobId
 * @param {{kind: string, mediaType: string, data: Buffer|string, name?: string}} artifact
 * @returns {{id: string, kind: string, media_type: string, bytes: number, name: string|null, created: string}}
 */
function put(config, jobId, artifact) {
    const mediaType = MEDIA_TYPES[artifact.mediaType] ? artifact.mediaType : DEFAULT_MEDIA_TYPE;
    const extension = MEDIA_TYPES[mediaType] || '.bin';

    const id = crypto.randomBytes(16).toString('hex');
    const data = Buffer.isBuffer(artifact.data) ? artifact.data : Buffer.from(String(artifact.data), 'utf8');

    const dir = jobDir(config.artifactDir, jobId);
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, `${id}${extension}`), data);

    return {
        id,
        kind: String(artifact.kind || 'unknown'),
        media_type: mediaType,
        bytes: data.length,
        name: artifact.name ? String(artifact.name) : null,
        created: new Date().toISOString(),
    };
}

/**
 * Reads one artifact back.
 *
 * @param {object} config
 * @param {string} jobId
 * @param {string} artifactId
 * @param {Array<object>} records The job's artifact records.
 * @returns {{mediaType: string, data: Buffer}|null} NULL when there is no such
 *          artifact, which the caller answers as a 404.
 */
function read(config, jobId, artifactId, records) {
    if (!ID_PATTERN.test(artifactId)) {
        return null;
    }

    /**
     * Served only if the job actually recorded it. Checking the record rather
     * than probing the filesystem means a request can only ever reach a file
     * this run itself produced.
     */
    const record = (records || []).find((candidate) => candidate.id === artifactId);

    if (!record) {
        return null;
    }

    const extension = MEDIA_TYPES[record.media_type] || '.bin';
    const file = path.join(jobDir(config.artifactDir, jobId), `${artifactId}${extension}`);

    if (!fs.existsSync(file)) {
        // Purged, or never finished being written
        return null;
    }

    return {mediaType: record.media_type, data: fs.readFileSync(file)};
}

/**
 * Removes everything a job wrote.
 *
 * Called when the job is purged. Screenshots of a portal session are not
 * something to leave lying on a desktop machine any longer than the run needed
 * them.
 *
 * @param {object} config
 * @param {string} jobId
 * @returns {void}
 */
function purge(config, jobId) {
    try {
        fs.rmSync(jobDir(config.artifactDir, jobId), {recursive: true, force: true});
    } catch (error) {
        // A purge that cannot complete must not take the service down
        console.error(`[artifacts] could not purge ${jobId}: ${error.message}`);
    }
}

export {put, read, purge, MEDIA_TYPES};
