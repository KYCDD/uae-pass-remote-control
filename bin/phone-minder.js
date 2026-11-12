#!/usr/bin/env node

/**
 * Minds the approval phone: keeps its screen lit AND watches for a UAE Pass
 * sign-in approval, alerting you the moment one is waiting. Leave it running
 * next to the agent; when it beeps, approve on the phone.
 *
 * It only keeps the screen on and observes. It never taps, approves, or enters a
 * PIN - approving stays with you.
 *
 *   node bin/phone-minder.js [adb-serial]
 *   node bin/phone-minder.js --poll 2            # seconds between checks (default 3)
 *   node bin/phone-minder.js --timeout 1800000   # also raise screen-off timeout (ms), restored on exit
 *   node bin/phone-minder.js --no-sound          # alert without the desktop beep (bell only)
 *   node bin/phone-minder.js --quiet-awake       # don't print the keep-awake heartbeat
 *
 * Serial defaults to REMOTE_AGENT_EMULATOR_SERIAL; package and approve labels
 * come from REMOTE_AGENT_UAE_PASS_PACKAGE / _APPROVE_TEXT. Ctrl-C stops it.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import 'dotenv/config';

import { Adb } from '../src/twofactor/adb.js';
import { PhoneMinder } from '../src/twofactor/PhoneMinder.js';
import { PENDING, POSSIBLE } from '../src/twofactor/ApprovalDetector.js';

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--poll', '--timeout']);
const flag = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(name);

const positionals = args.filter((a, i) => !a.startsWith('-') && !VALUE_FLAGS.has(args[i - 1]));
const serial = positionals[0] || process.env.REMOTE_AGENT_EMULATOR_SERIAL;

if (!serial) {
	console.error('Usage: node bin/phone-minder.js <adb-serial>  (or set REMOTE_AGENT_EMULATOR_SERIAL)');
	process.exit(2);
}

const binary = process.env.REMOTE_AGENT_ADB
	|| path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe');

const pkg = process.env.REMOTE_AGENT_UAE_PASS_PACKAGE || 'ae.uaepass.mainapp';
const approveLabels = (process.env.REMOTE_AGENT_UAE_PASS_APPROVE_TEXT || 'approve,allow,confirm,موافق,تأكيد,السماح')
	.split(',').map((label) => label.trim()).filter(Boolean);

const pollMs = (Number.parseFloat(flag('--poll')) || 3) * 1000;
const screenTimeoutMs = flag('--timeout') ? Number.parseInt(flag('--timeout'), 10) : null;
const sound = !has('--no-sound');
const quietAwake = has('--quiet-awake');

const adb = new Adb({ binary, serial });

if (!(await adb.isOnline())) {
	const seen = await adb.devices().catch(() => []);
	console.error(`Device "${serial}" is not online. Check "adb devices".`);
	console.error(seen.length
		? `adb currently sees: ${seen.map((d) => `${d.serial} (${d.state})`).join(', ')}`
		: 'adb sees no devices. Plug the phone in over USB and accept the "Allow USB debugging?" prompt.');
	process.exit(1);
}

const stamp = () => new Date().toLocaleTimeString();

/** A cross-the-room alert: terminal bell, plus a desktop beep unless --no-sound. */
function alert() {
	process.stdout.write('\x07');

	if (sound) {
		// Best-effort; a missing/blocked PowerShell just means bell-only.
		try {
			const beep = spawn('powershell', ['-NoProfile', '-Command', '[console]::beep(880,350); [console]::beep(660,350)'], { stdio: 'ignore', windowsHide: true });
			beep.on('error', () => {});
			beep.unref();
		} catch {
			// bell was enough
		}
	}
}

let awakeNote = null;
let sawSomething = false;

const minder = new PhoneMinder({
	adb,
	pollMs,
	screenTimeoutMs,
	package: pkg,
	approveLabels,
	onEvent: (event) => {
		switch (event.kind) {
			case 'awake': {
				if (quietAwake) {
					// Still surface a real problem (e.g. stay-awake not taking), once.
					if (event.note && event.note !== awakeNote) {
						awakeNote = event.note;
						console.error(`[${stamp()}] keep-awake: ${event.note}`);
					}

					break;
				}

				awakeNote = event.note ?? null;
				const screen = event.screenOn === true ? 'screen ON' : event.screenOn === false ? 'screen off -> woke it' : 'screen unreadable';
				const stay = event.mask === null ? 'stay-awake unreadable' : event.mask > 0 ? 'stay-awake set' : 'stay-awake NOT set';
				console.log(`[${stamp()}] ${screen}, ${stay}${event.note ? ` - ${event.note}` : ''}`);
				break;
			}

			case 'offline':
				console.error(`[${stamp()}] phone unreachable - ${event.note}`);
				break;

			case 'approval': {
				if (!event.changed) {
					break;
				}

				if (event.status === PENDING) {
					alert();
					console.log(`\n[${stamp()}] *** APPROVAL PENDING *** via ${event.via}${event.text ? `: "${event.text}"` : ''}`);
					console.log('    -> approve it on the phone.\n');
				} else if (event.status === POSSIBLE) {
					console.log(`[${stamp()}] possible approval via ${event.via}${event.note ? ` - ${event.note}` : ''}`);
				} else if (sawSomething) {
					// Only after a pending/possible, so a steady "nothing" doesn't chatter.
					console.log(`[${stamp()}] approval cleared.`);
				}

				sawSomething = event.status === PENDING || event.status === POSSIBLE;
				break;
			}

			case 'error':
				console.error(`[${stamp()}] error: ${event.note}`);
				break;

			default:
				break;
		}
	},
});

let stopping = false;
async function shutdown() {
	if (stopping) {
		return;
	}

	stopping = true;
	console.log('\nStopping. The screen will sleep again on its own timeout; nothing was approved.');
	await minder.stop();
	process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const model = (await adb.devices().catch(() => [])).find((d) => d.serial === serial)?.model;
console.log(`Minding ${serial}${model ? ` (${model})` : ''}: keeping it awake and watching for a ${pkg} approval.`);
console.log(`Poll every ${pollMs / 1000}s. It will ${sound ? 'beep' : 'ring the bell'} when an approval is waiting. Ctrl-C to stop.\n`);

await minder.start();

// Keep the process alive; the loop timer is unref'd.
setInterval(() => {}, 1 << 30);
