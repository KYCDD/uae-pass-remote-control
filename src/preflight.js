/**
 * Checks this machine can actually run the agent, before anyone depends on it.
 *
 * Run it once after setting a machine up, and again whenever the agent starts
 * failing for no obvious reason. It is read-only: it captures the screen and
 * reads the environment, and it does not move the mouse, press a key or contact
 * the model provider.
 *
 * The checks are ordered so the first failure is the useful one - there is no
 * point reporting that a screenshot came back black if PowerShell never started.
 *
 *     npm run preflight   (node src/preflight.js)
 */

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as desktopControl from './surface/desktopHost.js';
import { View } from './view.js';

/**
 * Node 18 runs this, but its `fetch` is experimental and prints a warning on
 * every start, and `AbortSignal.any` only arrived in 20.3. 20 LTS or newer is
 * the version to deploy.
 */
const MINIMUM_NODE_MAJOR = 18;
const RECOMMENDED_NODE_MAJOR = 20;

/**
 * Above this ratio between the real screen and the image the model is sent, text
 * on a portal form stops being reliably readable. It is the single most common
 * reason a well-configured agent still cannot do anything.
 */
const MAX_COMFORTABLE_SHRINK = 2.0;

const REQUIRED_ENV = [
    ['REMOTE_AGENT_TOKEN', 'shared with KYCDD as remote_browser_agent_token'],
    ['REMOTE_AGENT_SECRET', 'shared with KYCDD as remote_browser_agent_secret'],
    ['OPENAI_API_KEY', 'the model provider key'],
    ['REMOTE_AGENT_MODEL', 'which model to use; there is deliberately no default'],
];

const results = [];

/**
 * @param {'ok'|'warn'|'fail'} state
 * @param {string} label
 * @param {string} [detail]
 * @returns {void}
 */
function record(state, label, detail) {
    results.push({state, label, detail});

    const mark = {ok: ' ok ', warn: 'warn', fail: 'FAIL'}[state];
    console.log(`[${mark}] ${label}${detail ? `\n       ${detail}` : ''}`);
}

/**
 * Runs PowerShell once and returns its output.
 *
 * @param {string} shell
 * @param {string} script
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function runPowerShell(shell, script) {
    return new Promise((resolve) => {
        const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {windowsHide: true});

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });

        child.on('error', (error) => resolve({code: -1, stdout: '', stderr: error.message}));
        child.on('close', (code) => resolve({code, stdout: stdout.trim(), stderr: stderr.trim()}));
    });
}

(async () => {
    console.log('Checking this machine can run the KYCDD remote agent.\n');

    // ---- the platform -----------------------------------------------------
    const major = Number.parseInt(process.versions.node.split('.')[0], 10);

    if (major < MINIMUM_NODE_MAJOR) {
        record('fail', `Node ${process.versions.node} is too old`, `Install Node ${RECOMMENDED_NODE_MAJOR} LTS or newer.`);
    } else if (major < RECOMMENDED_NODE_MAJOR) {
        record('warn', `Node ${process.versions.node} will work`, `Node ${RECOMMENDED_NODE_MAJOR} LTS or newer is recommended: fetch is experimental before 21 and warns on every start.`);
    } else {
        record('ok', `Node ${process.versions.node}`);
    }

    if (typeof fetch !== 'function') {
        record('fail', 'global fetch is missing', 'The model client needs it. Use Node 18 or newer.');
    } else {
        record('ok', 'global fetch is available');
    }

    if (process.platform !== 'win32') {
        record('fail', `This is ${process.platform}, not Windows`, 'Direct desktop control is implemented through user32, so the agent only runs on Windows.');
    } else {
        record('ok', `Windows (${os.release()})`);
    }

    // ---- PowerShell and the .NET pieces the host needs --------------------
    const shell = (process.env.REMOTE_AGENT_POWERSHELL || '').trim() || 'powershell.exe';

    const version = await runPowerShell(shell, '$PSVersionTable.PSVersion.ToString()');

    if (version.code !== 0) {
        record('fail', `"${shell}" could not be run`, version.stderr || 'Set REMOTE_AGENT_POWERSHELL to its full path.');
    } else {
        record('ok', `PowerShell ${version.stdout} via "${shell}"`);
    }

    if (version.code === 0) {
        /**
         * Only that the assemblies load. Deliberately not reporting a screen
         * size from here: this one-off process is not DPI-aware, so on a scaled
         * display it reports the scaled size rather than the real one, and
         * printing that next to the host's own DPI-aware figure just looks like
         * a contradiction. The host's number, below, is the one that counts.
         */
        const assemblies = await runPowerShell(
            shell,
            'Add-Type -AssemblyName System.Drawing; Add-Type -AssemblyName System.Windows.Forms; "loaded"',
        );

        if (assemblies.code !== 0) {
            record('fail', 'System.Drawing / System.Windows.Forms could not be loaded', assemblies.stderr || 'On PowerShell 7 these need the Windows Desktop runtime; the in-box Windows PowerShell 5.1 has them already.');
        } else {
            record('ok', 'screen capture assemblies load');
        }

        const policy = await runPowerShell(shell, 'Get-ExecutionPolicy -Scope MachinePolicy');

        if (policy.code === 0 && /AllSigned|Restricted/i.test(policy.stdout)) {
            record('warn', `machine execution policy is ${policy.stdout}`, 'The host is launched with -ExecutionPolicy Bypass, which a machine policy can override. If the host fails to start, this is why.');
        }
    }

    // ---- the desktop itself ------------------------------------------------
    let shot = null;

    if (process.platform === 'win32' && version.code === 0) {
        /**
         * The sizing settings are read straight from the environment rather than
         * through config.js, which exits when the required credentials are
         * missing - and preflight has to be able to run before they are set.
         */
        const desktop = desktopControl.create(path.join(os.tmpdir(), 'kycdd-remote-agent', 'preflight'), {
            powershell: shell,
            screenshotWidth: Number.parseInt(process.env.REMOTE_AGENT_SCREENSHOT_WIDTH || '', 10) || null,
            maxShrink: Number.parseFloat(process.env.REMOTE_AGENT_MAX_SHRINK || '') || undefined,
            maxScreenshotWidth: Number.parseInt(process.env.REMOTE_AGENT_MAX_SCREENSHOT_WIDTH || '', 10) || undefined,
        });

        try {
            await desktop.call('ping');
            record('ok', 'the desktop host starts and answers');

            const screen = await desktop.call('screen_size');
            shot = await desktop.screenshot('primary');

            const bytes = fs.statSync(shot.path).size;

            /**
             * A capture from a session with no visible desktop - a Windows
             * service, or a disconnected RDP session - succeeds and returns a
             * black image, so size is the only way to tell from here. A real
             * desktop never compresses that small.
             */
            if (bytes < 5000) {
                record('fail', 'the screenshot came back essentially blank', 'The agent needs an interactive desktop: a logged-in session that is not locked and not a disconnected RDP session, and it cannot run as a Windows service.');
            } else {
                record('ok', `captured the screen (${shot.width}x${shot.height} image, ${(bytes / 1024).toFixed(0)}kb)`);
            }

            /**
             * The capture width is derived from this screen rather than fixed, so
             * what is being checked here is the ratio that came out of it, not
             * whether someone configured the right number.
             */
            const shrink = shot.shrink;

            if (shrink > MAX_COMFORTABLE_SHRINK) {
                record('warn', `whole-screen views are reduced ${shrink.toFixed(2)}x on this display`, `Expected on a screen this wide: the capture is capped at ${shot.width}px to bound token cost. Small print will be read with region captures instead, which cost a step each. Raise REMOTE_AGENT_MAX_SCREENSHOT_WIDTH, or lower the display resolution, if runs look slow.`);
            } else {
                record('ok', `whole-screen views reduced ${shrink.toFixed(2)}x (comfortable), captured at ${shot.width}x${shot.height}`);
            }

            /**
             * The thing that actually makes an unknown screen size workable: a
             * region has to come back unshrunk, so text can always be read by
             * looking closer however large the display turns out to be.
             */
            const side = Math.min(400, Math.floor(shot.width / 2), Math.floor(shot.height / 2));
            const shotView = new View({
                base64: '',
                width: shot.width,
                height: shot.height,
                srcX: shot.screenX,
                srcY: shot.screenY,
                srcW: shot.screenWidth,
                srcH: shot.screenHeight,
            });
            const zoom = await desktop.screenshotRegion(shotView.rectToTarget({x: 0, y: 0, width: side, height: side}));

            if (zoom.shrink > 1.05) {
                record('warn', `region captures are reduced ${zoom.shrink.toFixed(2)}x`, 'They should be close to 1:1. Small text may be unreadable even when looking closer.');
            } else {
                record('ok', `region captures come back at full size (${zoom.width}x${zoom.height} for a ${Math.round(side * shrink)}px area)`);
            }

            if (screen.width > shot.screenWidth) {
                record('warn', 'this machine has more than one monitor', `The agent captures the primary screen (${shot.screenWidth}x${shot.screenHeight}) out of a ${screen.width}x${screen.height} desktop. A window that opens on another monitor will not be seen unless the model asks for "all".`);
            }

            fs.rmSync(shot.path, {force: true});
            fs.rmSync(zoom.path, {force: true});
        } catch (error) {
            record('fail', 'the desktop host could not be used', error.message);
        } finally {
            desktop.close();
        }
    }

    // ---- configuration -----------------------------------------------------
    for (const [name, purpose] of REQUIRED_ENV) {
        if ((process.env[name] || '').trim()) {
            record('ok', `${name} is set`);
        } else {
            record('fail', `${name} is not set`, purpose);
        }
    }

    const aliases = Object.keys(process.env)
        .filter((name) => /^REMOTE_AGENT_CRED_.+_USERNAME$/.test(name))
        .map((name) => name.replace(/^REMOTE_AGENT_CRED_/, '').replace(/_USERNAME$/, '').toLowerCase());

    if (aliases.length) {
        record('ok', `portal credentials configured for: ${aliases.join(', ')}`);
    } else {
        record('warn', 'no portal credentials are configured', 'Any task whose service requires a login will fail immediately. See README.md, "Portal credentials".');
    }

    // ---- verdict -----------------------------------------------------------
    const failed = results.filter((result) => result.state === 'fail').length;
    const warned = results.filter((result) => result.state === 'warn').length;

    console.log('');

    if (failed) {
        console.log(`${failed} check(s) failed${warned ? `, ${warned} warning(s)` : ''}. The agent will not work until those are fixed.`);
        process.exit(1);
    }

    console.log(warned
        ? `All checks passed, with ${warned} warning(s) worth reading above.`
        : 'All checks passed. This machine can run the agent.');
})();
