# kycdd-remote-desktop-control

Drives legacy services on a Windows machine, on behalf of the KYCDD platform.

KYCDD runs on Linux and talks to most providers directly. A few cannot be
reached that way: they need a real browser, a real sign-in, and in Growth's case
a session that only a signed-in browser can produce. This agent is the machine
that does that part. KYCDD sends it a task; it drives the portal and sends back a
result.

The platform side of the contract is `App\RemoteBrowser\RemoteInstruction` and
`App\RemoteBrowser\RemoteAgent` in the KYCDD repository. The two halves have to
be changed together.

## Deterministic first, model as fallback

A known portal is worked from a **scripted recipe** (`src/flows/`), driving the
page by DOM selectors with no external AI in the loop. The model-driven loop is
the *exception* — used only for a service with no recipe, or as a fallback when a
deterministic run hits an unexpected page (`REMOTE_AGENT_MODE=deterministic` is
the default; set `REMOTE_AGENT_AI_FALLBACK=0` to never use the model at all, and
then no model key is needed). The pieces that were never the model's job anyway —
reading the session off the network log (`src/extractors/`) and approving on the
phone (`src/twofactor/`) — are shared by both paths.

A recipe needs the page's selectors, which live in configuration, not code
(`REMOTE_AGENT_GROWTH_SELECTORS`). Discover them against the live pages with
`node bin/inspect-dom.js <url>`.

## One loop, two surfaces

There is a single agent loop (`src/Agent.js`): look at the screen, ask the model,
carry out the action it asks for through the shared vocabulary in
`src/actions.js`, look again. The same loop drives either of two **surfaces**,
chosen by `REMOTE_AGENT_SURFACE`:

| | **browser** (`src/surface/BrowserSurface.js`) | **desktop** (`src/surface/DesktopSurface.js`) |
|---|---|---|
| Drives | a real Chromium through Puppeteer | the real Windows mouse, keyboard and screen, via a PowerShell host |
| Good for | portals reachable in a browser; the Growth session harvest | portals that refuse automation, native dialogs, anything outside a browser window |
| Can `navigate` | yes (with an origin allowlist) | no — reach the page by working the screen |
| Can `capture` | yes — it records the network log over CDP | only with a tapped Chrome (see below), once `start_recording` is called |
| Dependencies | Puppeteer (loaded only when this surface is used) | none but Node and Windows PowerShell |

Because the loop talks to a surface only through `execute()` and `screenshot()`,
neither the loop nor the model driver knows which surface is underneath. The
model always gives coordinates in the pixels of the picture it was last shown,
and the surface maps them back to its own target (`src/view.js`).

## How a task arrives

Everything the agent is allowed to know comes in the envelope. There is no
prompt, no playbook and no portal credential stored on this machine — only the
*alias* of one.

```
POST /tasks
  { version, service, inputs, instructions: { operating_rules, playbook,
    dead_ends }, result_schema, limits, artifacts, two_factor }
  -> { job_id }

GET  /tasks/{id}            -> { status, outcome, result, error, steps, artifacts }
POST /tasks/{id}/cancel
GET  /tasks/{id}/artifacts/{artifact_id}
```

Requests are signed (a bearer token plus an HMAC over method, path, timestamp and
body hash) and dispatch is idempotent, so a retried dispatch rejoins the job it
already started rather than opening a second browser against the same portal. The
server (`src/server/`) holds jobs, runs one at a time, and serves artifacts by id.

## Layout

| Path | Does |
|---|---|
| `src/flows/` | Deterministic recipes (no model): the FlowRunner and `recipes/` |
| `src/Agent.js` | The model-driven loop, used when a recipe can't be (fallback) |
| `src/actions.js` | The action vocabulary both surfaces speak, and the task's tool specs |
| `src/view.js` | A screenshot plus the mapping from its pixels back to the surface |
| `src/envelope.js` | Validates the inbound envelope; refuses an unknown version |
| `src/config.js` | Every setting, read from the environment |
| `src/credentials.js` | Alias → secret (file and/or env), and the log redactor |
| `src/surface/` | `BrowserSurface`, `DesktopSurface`, the PowerShell host, the CDP network log |
| `src/drivers/` | Vendor translation. `OpenAiDriver` offers the actions as function tools |
| `src/extractors/` | Reads answers off the wire instead of asking the model (Growth session) |
| `src/twofactor/` | One-time code from a file, or UAE Pass app approval on an emulator |
| `src/server/` | The HTTP endpoint, job store and queue, artifact store, request signing |
| `src/preflight.js` | Checks a Windows machine can run the desktop surface |
| `bin/run-task.js` | Replays one envelope locally with the surface in front of you |
| `docs/windows-desktop-agent.md` | Deploying the desktop surface on a Windows machine |

## Three decisions worth knowing

**The model never sees the values it is collecting.** A Growth session is a
`Cookie` header, a CSRF token and version strings out of JSON request bodies.
Asking a model to transcribe that would eventually drop a character, would send a
live session cookie and an identity token into a third party's request logs, and
is unnecessary because the browser already sent those exact bytes and this machine
recorded them. So the model navigates, calls `capture`, and is told only *which*
values were found. See `src/extractors/growthSession.js`.

**Limits are enforced, not requested.** An origin allowlist checked after every
step (browser), a step cap and a deadline, a `finish` validated against the
task's own schema, a credential that is typed but never returned, and a safety
check that stops the run rather than being waved through.

**The browser profile persists, per credential alias.** Signing in again through
UAE Pass invalidates the session already held, so a profile that forgets does not
merely waste a run — it destroys working sessions. Deleting the profile directory
signs every portal out.

## Running one task

```bash
npm install
cp .env.example .env                        # add OPENAI_API_KEY, REMOTE_AGENT_MODEL
cp credentials.example.json credentials.json # add the portal login (browser surface)
node bin/run-task.js envelopes/growth-session.json
```

The surface is chosen by `REMOTE_AGENT_SURFACE` (browser by default). Ctrl-C
stops at the next step boundary. What it prints is the job object KYCDD will see.

To run the server KYCDD talks to: `npm run serve`. To check a Windows machine can
drive the desktop surface: `npm run preflight`.

## Prompting it directly

`bin/prompt.js` takes a plain-language instruction instead of an envelope, and
works it on the **desktop surface** with the real mouse and keyboard, with no
automated browser involved. Use it for portals that flag Puppeteer, such as the
reCAPTCHA on UAE Pass. It runs the same loop, credential handling, two-factor
channels and limits as a KYCDD task (`src/promptEnvelope.js` builds the envelope).

```bash
npm run prompt -- "Open https://www.growth.gov.ae/G2C/ and sign in" -c growth_uae_pass --two-factor uae_pass
npm run prompt -- -i -c growth_uae_pass --two-factor uae_pass   # keep prompting
```

- **Interactive mode (`-i`)** asks for another task after each one. The last few
  tasks' summaries are passed along as context, and windows are left open, so
  "now open the licence enquiry" carries on from where the last task stopped.
  Type `forget` to drop that context, or `exit` to quit.
- **Credentials (`-c ALIAS`)** offers `type_credential` for that alias. The value
  is typed on this machine and never shown to the model.
- **Two-factor (`--two-factor uae_pass`)** approves on the phone when
  `REMOTE_AGENT_UAE_PASS_APPROVAL=auto`; otherwise it waits for a code in
  `2fa.txt`.
- **To stop a run**, push the mouse pointer into the **top-left corner of the
  main screen**. Ctrl-C only works while the terminal has focus, which it loses
  at the agent's first click. Turn the failsafe off with
  `REMOTE_AGENT_DESKTOP_FAILSAFE=0`.
- **Bot checks:** the model is told not to solve CAPTCHAs. If one appears, it stops
  with `blocked_by_bot_check` and leaves the screen for you to deal with.
- **Harvesting the Growth session (`--capture growth_session`).** The task gets
  a real Chrome of its own, started as a plain process with no Puppeteer, no
  automation flags and no `navigator.webdriver`. It uses its own profile
  (`profiles/desktop-<alias>`, so the sign-in persists) and a debugging port on
  127.0.0.1 (`REMOTE_AGENT_DESKTOP_CHROME_PORT`, default 9333). **Nothing
  attaches during sign-in.** Once signed in, the model calls `start_recording`,
  which enables only the CDP Network domain on each tab (never Runtime, which is
  how pages usually detect a CDP client). Then it runs the search, detail and
  PDF probe and calls `capture`. The harvest is written to a file under the
  artifact directory and never printed. Chrome is left open for the next task.
  Pass the probe licence with `--input probe_licence_number=...`.

  ```bash
  npm run prompt -- "Sign in to Growth" -c growth_uae_pass --two-factor uae_pass --capture growth_session --url https://www.growth.gov.ae/G2C/ --input probe_licence_number=2313602.01
  ```

  While that Chrome runs, any process on this machine can drive it, signed-in
  session included, through the port. The code for this is in
  `src/surface/ChromeTap.js`.

## Two-factor, including UAE Pass app approval

A task names a `two_factor.channel`; how this machine satisfies it is a property
of the machine (`src/twofactor/`):

- **file** (default): a code is written to `<workDir>/2fa.txt`, the mechanism
  KYCDD's own scrapers already use. The agent reads it, types it, and deletes it.
- **uae_pass, assist** (`REMOTE_AGENT_UAE_PASS_APPROVAL=assist`): the run reaches
  the sign-in approval, **alerts the operator and waits while they approve on the
  phone**, then carries on. It keeps the phone awake and watches (read-only) for
  the prompt to be handled; it never taps, approves, or enters a PIN. This is the
  mode for keeping a session alive across re-logins without handing the approval
  itself to a machine. It fails to `two_factor_timeout` only if it saw the prompt
  and it was never approved; if it never sees the prompt it proceeds unconfirmed
  and the next screenshot of the portal is the real check.
  See `src/twofactor/HumanApproval.js`.
- **uae_pass, auto** (`REMOTE_AGENT_UAE_PASS_APPROVAL=auto`): approve the UAE Pass
  push by itself on an Android emulator, fully unattended. It removes the human
  from the one step 2FA exists to keep them in, so it is opt-in and logs every
  approval. **It has not been run against the real UAE Pass app** — the flow and
  the approve-control labels are configurable, and the first run against an
  enrolled emulator is where it gets tuned. See `src/twofactor/UaePassApp.js`.

## Minding the approval phone (human-in-the-loop)

For the opposite stance — keep a person on the approve button, but make the tap
instant — three ADB tools mind the phone without ever approving anything. They
keep a connected device (a real phone over USB, or an emulator) awake and alert
you when a UAE Pass approval is waiting; you approve it on the phone. Serial comes
from `REMOTE_AGENT_EMULATOR_SERIAL`, package and approve labels from
`REMOTE_AGENT_UAE_PASS_PACKAGE` / `_APPROVE_TEXT`.

```bash
node bin/phone-minder.js            # keep awake + watch + beep when approval pending (the combined runner)
node bin/keep-awake.js              # keep the screen lit only
node bin/watch-approval.js          # watch for a pending approval only (read-only)
```

`phone-minder.js` ties the two pieces together (`src/twofactor/PhoneMinder.js`):
one loop keeps the screen on (`KeepAwake`, re-asserting the "stay awake while
charging" setting and waking a slept screen) and checks for a pending approval
(`ApprovalDetector`, read-only — a UAE Pass push notification, or an on-screen
approve control). On a pending approval it rings the terminal bell and beeps the
desktop; it never taps, approves, or enters a PIN. If the phone drops off ADB
(its USB can disconnect when it sleeps) it reports that and tries to reconnect.

**Not yet run against the real UAE Pass app.** The detector matches on the
`ae.uaepass.mainapp` package and approval keywords; the real notification wording
is confirmed and tuned with `bin/watch-approval.js` and `bin/inspect-screen.js`
on the first live approval.

## What is still open

- **Verification against a live portal.** Neither surface has been run against
  Growth, and the UAE Pass emulator channel is unproven. The module graph, the
  loop, the signing and the job lifecycle are tested; the portals themselves are
  not.
- **One credential source of truth.** Credentials resolve from `credentials.json`
  and from `REMOTE_AGENT_CRED_*` env vars; `login_origins` (which the browser
  allowlist needs) currently only come from the file.
