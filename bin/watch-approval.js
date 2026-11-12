#!/usr/bin/env node

/**
 * Read-only: watches the phone and prints when a UAE Pass sign-in approval is
 * waiting. It only observes - it never taps, approves, or opens anything. Use it
 * to see the detector working, or as the thing that tells a human "approve now".
 *
 *   node bin/watch-approval.js [adb-serial]
 *   node bin/watch-approval.js --interval 2         # poll seconds (default 3)
 *   node bin/watch-approval.js --once               # check once and exit
 *   node bin/watch-approval.js --possible           # also report weak ("possible") signals
 *
 * The serial defaults to REMOTE_AGENT_EMULATOR_SERIAL; the package and approve
 * labels come from REMOTE_AGENT_UAE_PASS_PACKAGE / _APPROVE_TEXT (or defaults).
 * Exit code is 0 when it ends having seen a pending approval (with --once), 3
 * when it did not.
 */

import path from 'node:path';
import 'dotenv/config';

import { Adb } from '../src/twofactor/adb.js';
import { ApprovalDetector, PENDING, POSSIBLE } from '../src/twofactor/ApprovalDetector.js';

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--interval']);
const flag = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(name);

const positionals = args.filter((a, i) => !a.startsWith('-') && !VALUE_FLAGS.has(args[i - 1]));
const serial = positionals[0] || process.env.REMOTE_AGENT_EMULATOR_SERIAL;

if (!serial) {
	console.error('Usage: node bin/watch-approval.js <adb-serial>  (or set REMOTE_AGENT_EMULATOR_SERIAL)');
	process.exit(2);
}

const binary = process.env.REMOTE_AGENT_ADB
	|| path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe');

const pkg = process.env.REMOTE_AGENT_UAE_PASS_PACKAGE || 'ae.uaepass.mainapp';
const approveLabels = (process.env.REMOTE_AGENT_UAE_PASS_APPROVE_TEXT || 'approve,allow,confirm,موافق,تأكيد,السماح')
	.split(',').map((label) => label.trim()).filter(Boolean);

const intervalMs = (Number.parseFloat(flag('--interval')) || 3) * 1000;
const acceptPossible = has('--possible');

const adb = new Adb({ binary, serial });

if (!(await adb.isOnline())) {
	console.error(`Device "${serial}" is not online. Check "adb devices", then plug the phone in and accept the USB debugging prompt.`);
	process.exit(1);
}

const detector = new ApprovalDetector({ adb, package: pkg, approveLabels });
const stamp = () => new Date().toLocaleTimeString();

let last = null;

/**
 * Prints a status line only when it changes, so a long wait does not scroll.
 *
 * @param {{status: string, via: string|null, text: string|null, note?: string}} r
 */
function report(r) {
	const key = `${r.status}:${r.via}:${r.text}`;

	if (key === last) {
		return;
	}

	last = key;

	if (r.status === PENDING) {
		console.log(`[${stamp()}] APPROVAL PENDING via ${r.via}${r.text ? `: "${r.text}"` : ''} - approve it on the phone.`);
	} else if (r.status === POSSIBLE) {
		console.log(`[${stamp()}] possible approval via ${r.via}${r.note ? ` - ${r.note}` : ''}`);
	} else {
		console.log(`[${stamp()}] nothing pending${r.note ? ` (${r.note})` : ''}`);
	}
}

if (has('--once')) {
	const result = await detector.check();
	report(result);
	const seen = result.status === PENDING || (acceptPossible && result.status === POSSIBLE);
	process.exit(seen ? 0 : 3);
}

console.log(`Watching ${serial} for a ${pkg} approval. Poll every ${intervalMs / 1000}s. Ctrl-C to stop.\n`);

const controller = new AbortController();
process.on('SIGINT', () => {
	console.log('\nStopped.');
	controller.abort();
	process.exit(0);
});

// Poll forever, reporting each change. acceptPossible only affects what counts as "found" for a caller;
// here we print everything and never resolve, so pass a far-off timeout and let onPoll do the reporting.
await detector.waitForApproval({
	timeoutMs: Number.MAX_SAFE_INTEGER,
	intervalMs,
	acceptPossible: false,
	signal: controller.signal,
	onPoll: report,
}).catch(() => {});
