#!/usr/bin/env node

/**
 * Runs one task envelope from a file, and prints the job.
 *
 * This is how the agent is exercised with the browser (or desktop) in front of
 * you, before and after the HTTP endpoint is involved: when a run misbehaves
 * against a portal, the thing you want is to replay that exact envelope locally,
 * not to reproduce it through the platform.
 *
 *   node bin/run-task.js envelopes/growth-session.json
 *
 * The surface is chosen by REMOTE_AGENT_SURFACE (browser by default). What it
 * prints is the same shape the HTTP endpoint serves from GET /tasks/{id}.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import 'dotenv/config';

import { loadConfig } from '../src/config.js';
import { parseEnvelope } from '../src/envelope.js';
import { CredentialStore } from '../src/credentials.js';
import { buildAgent } from '../src/runTask.js';

const [, , envelopePath] = process.argv;

if (!envelopePath) {
	console.error('Usage: node bin/run-task.js <envelope.json>');
	process.exit(2);
}

// A local run does not serve HTTP, so it does not need the shared token/secret
const config = loadConfig({ server: false });
const envelope = parseEnvelope(JSON.parse(readFileSync(resolve(envelopePath), 'utf8')));
const credentials = new CredentialStore({ file: config.credentialsFile, env: config.env });

const steps = [];
const artifacts = [];
const controller = new AbortController();

const agent = await buildAgent(envelope, {
	config,
	credentials,
	signal: controller.signal,
	recordStep: (name, detail) => {
		steps.push({ step: steps.length + 1, at: new Date().toISOString(), name, detail: detail ?? null });
		console.error(`  · ${name}`);
	},
	putArtifact: (artifact) => {
		const record = { id: String(artifacts.length + 1), kind: artifact.kind, bytes: artifact.data?.length ?? 0, name: artifact.name ?? null };
		artifacts.push(record);
		return record;
	},
});

// Ctrl-C stops at the next step boundary rather than abandoning a half-filled form
process.on('SIGINT', () => {
	console.error('\nStopping after the current step...');
	controller.abort();
});

const outcome = await agent.run();

console.log(JSON.stringify({ ...outcome, steps, steps_taken: steps.length, artifacts }, null, 2));

process.exit(outcome.ok ? 0 : 1);
