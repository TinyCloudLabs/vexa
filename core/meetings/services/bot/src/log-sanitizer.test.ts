import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sanitizer = fileURLToPath(new URL('./log-sanitizer.ts', import.meta.url));
const script = `
  import { installProcessLogSanitizer } from ${JSON.stringify(sanitizer)};
  installProcessLogSanitizer();
  console.log(JSON.stringify({level:'info', event:'capture_signal.tape_started', meeting_id:12345, user_id:'SYNTH_USER_590', name:'SYNTH_NAME_591', text:'SYNTH_TRANSCRIPT_592', url:'https://meet.google.com/abc-defg-hij', passcode:'SYNTH_CODE_593', token:'SYNTH_TOKEN_594', session_uid:'SYNTH_SESSION_595', path:'/private/SYNTH_PATH_596', error:'SYNTH_PROVIDER_BODY_597', frames:7, status:401}));
  console.log(JSON.stringify({level:'info', event:'capture_signal.tape_started', meeting_id:'12345', native_code:'abc-defg-hij'}));
  console.log(JSON.stringify({ts:'2026-10-20T00:00:00.000Z', level:'warn', event:'join.gemini_notice_handled', platform:'google_meet', success:true, attempt:1, msg:'SYNTH_NOTICE_TEXT_640', title:'SYNTH_NAME_641'}));
  console.info(JSON.stringify({level:'info', event:'capture_signal.tape_started', frames:8}));
  console.warn({level:'warn', event:'capture_signal.tape_upload_failed', error_code:'upload_failed', attempts:3});
  console.log('SYNTH_NAME_592', {text:'SYNTH_TRANSCRIPT_592'});
  console.trace('SYNTH_PROVIDER_BODY_597');
  console.dir({token:'SYNTH_TOKEN_594'});
  console.table([{path:'/private/SYNTH_PATH_596'}]);
  console.assert(false, 'SYNTH_NAME_592');
  console.group('SYNTH_NAME_592'); console.groupEnd();
  console.count('SYNTH_NAME_592'); console.time('SYNTH_NAME_592'); console.timeEnd('SYNTH_NAME_592');
  process.stdout.write('plain SYNTH_TRANSCRIPT_592\\n');
  process.stderr.write('plain SYNTH_PROVIDER_BODY_597\\n');
`;
const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  encoding: 'utf8',
});
assert.equal(result.status, 0, result.stderr);
const output = result.stdout + result.stderr;
for (const canary of [
  'SYNTH_USER_590', 'SYNTH_NAME_591', 'SYNTH_TRANSCRIPT_592', 'https://meet.google.com/abc-defg-hij',
  'SYNTH_CODE_593', 'SYNTH_TOKEN_594', 'SYNTH_SESSION_595', '/private/SYNTH_PATH_596', 'SYNTH_PROVIDER_BODY_597',
  'abc-defg-hij',
]) assert.equal(output.includes(canary), false, `process output leaked ${canary}`);
assert.match(output, /"frames":7/);
assert.match(output, /"status":401/);
const noticeLine = output.split('\n').find((line) => line.includes('join.gemini_notice_handled'));
assert.ok(noticeLine, 'the TC-1606 Gemini-notice event must survive the sanitizer');
const notice = JSON.parse(noticeLine);
assert.equal(notice.event, 'join.gemini_notice_handled');
assert.equal(notice.platform, 'google_meet');
assert.equal(notice.success, true);
assert.equal(notice.attempt, 1);
assert.equal(Object.hasOwn(notice, 'msg') || Object.hasOwn(notice, 'title'), false);
assert.equal(output.includes('SYNTH_NOTICE_TEXT_640') || output.includes('SYNTH_NAME_641'), false, 'notice event leaked free text');
assert.equal([...output.matchAll(/"meeting_id":/g)].length, 1);
assert.doesNotMatch(output, /"user_id"|plain/);
const telemetryModule = fileURLToPath(new URL('./telemetry.ts', import.meta.url));
const importScript = `
  import ${JSON.stringify(telemetryModule)};
  console.log('SYNTH_IMPORT_OUTPUT_630');
`;
const importResult = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', importScript], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  encoding: 'utf8',
});
assert.equal(importResult.status, 0, importResult.stderr);
assert.match(importResult.stdout, /SYNTH_IMPORT_OUTPUT_630/);
const pipeline = fileURLToPath(new URL('./pipeline.ts', import.meta.url));
const adapterScript = `
  import { installProcessLogSanitizer } from ${JSON.stringify(fileURLToPath(new URL('./log-sanitizer.ts', import.meta.url)))};
  installProcessLogSanitizer();
  const load = async specifier => { const module = await import(specifier); return { ...(module.default ?? {}), ...module }; };
  // Import the adapter only after the sanitizer to test process-level defense in depth.
  const { createTranscribe } = await load(${JSON.stringify(pipeline)});
  let calls = 0;
  globalThis.fetch = async () => new Response('SYNTH_PROVIDER_BODY_598 TRANSCRIPT=MEETING_CANARY https://meet.google.com/abc-defg-hij TOKEN=SYNTH_TOKEN_599', {
    status: ++calls === 1 ? 503 : 401,
  });
  const transcribe = createTranscribe({
    platform:'teams', meetingUrl:'https://teams.microsoft.com/l/meetup-join/MEETING_CANARY',
    botName:'SYNTH_NAME_600', transcriptionServiceUrl:'http://stt.invalid',
    transcriptionServiceToken:'SYNTH_TOKEN_599',
  });
  try { await transcribe(new Float32Array([0]), 'en', 'SYNTH_TRANSCRIPT_601'); }
  catch (error) { console.error(error.message); }
`;
const adapterResult = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', adapterScript], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  encoding: 'utf8',
});
assert.equal(adapterResult.status, 0, adapterResult.stderr);
const adapterOutput = adapterResult.stdout + adapterResult.stderr;
for (const canary of ['SYNTH_PROVIDER_BODY_598', 'MEETING_CANARY', 'SYNTH_TOKEN_599', 'SYNTH_NAME_600', 'SYNTH_TRANSCRIPT_601']) {
  assert.equal(adapterOutput.includes(canary), false, `transcribe adapter leaked ${canary}`);
}
assert.match(adapterOutput, /"status":503/);
assert.match(adapterOutput, /"status":401/);
const telemetry = fileURLToPath(new URL('./telemetry.ts', import.meta.url));
const uploader = fileURLToPath(new URL('./signal-upload.ts', import.meta.url));
const tapeScript = `
  import { installProcessLogSanitizer } from ${JSON.stringify(fileURLToPath(new URL('./log-sanitizer.ts', import.meta.url)))};
  installProcessLogSanitizer();
  import { createServer } from 'node:http';
  import { mkdtempSync, rmSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  const load = async specifier => { const module = await import(specifier); return { ...(module.default ?? {}), ...module }; };
  const { createCaptureSignalRecorder } = await load(${JSON.stringify(telemetry)});
  const { uploadSignalTapes } = await load(${JSON.stringify(uploader)});
  const dir = mkdtempSync(join(tmpdir(), 'SYNTH_PATH_602'));
  const inv = {
    platform:'teams', meetingUrl:'https://teams.microsoft.com/l/meetup-join/MEETING_CANARY',
    botName:'SYNTH_NAME_603', redisUrl:'redis://SYNTH_HOST_604',
    connectionId:'SYNTH_SESSION_605', nativeMeetingId:'NATIVE_MEETING_606', meeting_id:98765,
    internalSecret:'SYNTH_TOKEN_607',
  };
  const server = createServer((_req, res) => { _req.resume(); res.end('SYNTH_PROVIDER_BODY_608'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  inv.recordingUploadUrl = 'http://127.0.0.1:' + port + '/upload?token=SYNTH_TOKEN_607';
  const rec = createCaptureSignalRecorder(inv, { dir, maxBytes:400 });
  rec.sink.captureFrame({ t:1, pcm:Buffer.alloc(320).toString('base64'), speaker:'SYNTH_NAME_603', seq:1, rms:0.1 });
  await rec.close();
  await uploadSignalTapes(rec, { inv, maxBytes:100000 });
  await new Promise(resolve => server.close(resolve));
  rmSync(dir, {recursive:true, force:true});
`;
const tapeResult = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', tapeScript], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  encoding: 'utf8',
});
assert.equal(tapeResult.status, 0, tapeResult.stderr);
const tapeOutput = tapeResult.stdout + tapeResult.stderr;
for (const canary of ['SYNTH_PATH_602', 'SYNTH_NAME_603', 'SYNTH_HOST_604', 'SYNTH_SESSION_605', 'NATIVE_MEETING_606',
  'SYNTH_TOKEN_607', 'SYNTH_PROVIDER_BODY_608', 'MEETING_CANARY']) {
  assert.equal(tapeOutput.includes(canary), false, `recorder process output leaked ${canary}`);
}
assert.match(tapeOutput, /"event":"capture_signal\.tape_started"/);
assert.match(tapeOutput, /"event":"capture_signal\.tape_capped"/);
assert.match(tapeOutput, /"event":"capture_signal\.tape_uploaded"/);
assert.match(tapeOutput, /"frames":\d+/);

const recordingService = fileURLToPath(new URL('../../../modules/recording/src/recording.ts', import.meta.url));
const recordingScript = `
  import { installProcessLogSanitizer } from ${JSON.stringify(fileURLToPath(new URL('./log-sanitizer.ts', import.meta.url)))};
  installProcessLogSanitizer();
  import { createServer } from 'node:http';
  // Load the sanitizer before this module to exercise the same process-boundary order as the bot.
  const load = async specifier => { const module = await import(specifier); return { ...(module.default ?? {}), ...module }; };
  const { RecordingService } = await load(${JSON.stringify(recordingService)});
  const server = createServer((req, res) => {
    req.resume();
    res.statusCode = 403;
    res.end('SYNTH_UPLOAD_BODY_623 SYNTH_NATIVE_623 SYNTH_TOKEN_623');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const recording = new RecordingService(987654, 'SYNTH_SESSION_623');
  try {
    await recording.uploadChunk(
      'http://127.0.0.1:' + port + '/upload?native=SYNTH_NATIVE_623&ticket=SYNTH_TOKEN_623',
      'SYNTH_TOKEN_623', Buffer.alloc(320), 1, false,
    );
  } catch {}
  await new Promise(resolve => server.close(resolve));
`;
const recordingResult = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', recordingScript], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  encoding: 'utf8',
});
assert.equal(recordingResult.status, 0, recordingResult.stderr);
const recordingOutput = recordingResult.stdout + recordingResult.stderr;
for (const canary of ['SYNTH_UPLOAD_BODY_623', 'SYNTH_NATIVE_623', 'SYNTH_TOKEN_623',
  'SYNTH_SESSION_623', '127.0.0.1', '/upload']) {
  assert.equal(recordingOutput.includes(canary), false, `recording upload leaked ${canary}`);
}
assert.match(recordingOutput, /"http_status":403/);

const jitsiJoin = fileURLToPath(new URL('../../../modules/join/src/jitsi/join.ts', import.meta.url));
const jitsiLeave = fileURLToPath(new URL('../../../modules/join/src/jitsi/leave.ts', import.meta.url));
const joinScript = `
  import { installProcessLogSanitizer } from ${JSON.stringify(fileURLToPath(new URL('./log-sanitizer.ts', import.meta.url)))};
  installProcessLogSanitizer();
  const load = async specifier => { const module = await import(specifier); return { ...(module.default ?? {}), ...module }; };
  const { joinJitsiMeeting } = await load(${JSON.stringify(jitsiJoin)});
  const { leaveJitsiMeeting } = await load(${JSON.stringify(jitsiLeave)});
  let now = 0, evaluations = 0, typed = '', failLeave = false;
  Date.now = () => ++now * 1000;
  const page = {
    on() {}, off() {}, isClosed() { return false; },
    async goto() {}, async waitForTimeout() {
      if (failLeave) throw new Error('SYNTH_PROVIDER_BODY_609 /private/SYNTH_PATH_610');
    },
    async evaluate() {
      evaluations++;
      if (failLeave) throw new Error('SYNTH_PROVIDER_BODY_609 /private/SYNTH_PATH_610');
      return evaluations === 1 ? false : evaluations === 2 ? null : true;
    },
    keyboard: { async type(value) { typed = value; }, async press() {} },
    locator(selector) {
      const name = String(selector).includes('premeeting-name-input');
      const loc = {
        first() { return loc; }, async isVisible() { return name; },
        async waitFor() {}, async inputValue() { return ''; },
        async click() {}, async fill(value) { if (name) typed = value; },
      };
      return loc;
    },
  };
  await joinJitsiMeeting(page, 'https://meet.jit.si/MEETING_CANARY', 'SYNTH_NAME_611', {});
  if (typed !== 'SYNTH_NAME_611') process.exit(31);
  failLeave = true;
  await leaveJitsiMeeting(page, {}, 'SYNTH_LEAVE_REASON_612');
`;
const joinResult = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', joinScript], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  encoding: 'utf8',
});
assert.equal(joinResult.status, 0, joinResult.stderr);
const joinOutput = joinResult.stdout + joinResult.stderr;
for (const canary of ['MEETING_CANARY', 'SYNTH_NAME_611', 'SYNTH_PROVIDER_BODY_609', 'SYNTH_PATH_610', 'SYNTH_LEAVE_REASON_612']) {
  assert.equal(joinOutput.includes(canary), false, `join/leave process output leaked ${canary}`);
}
const providerJoinScript = `
  import { installProcessLogSanitizer } from ${JSON.stringify(fileURLToPath(new URL('./log-sanitizer.ts', import.meta.url)))};
  installProcessLogSanitizer();
  const load = async specifier => { const module = await import(specifier); return { ...(module.default ?? {}), ...module }; };

  const [{ joinGoogleMeeting }, { leaveGoogleMeet }] = await Promise.all([
    load(${JSON.stringify(fileURLToPath(new URL('../../../modules/join/src/googlemeet/join.ts', import.meta.url))) }),
    load(${JSON.stringify(fileURLToPath(new URL('../../../modules/join/src/googlemeet/leave.ts', import.meta.url))) }),
  ]);
  const { joinMicrosoftTeams } = await load(${JSON.stringify(fileURLToPath(new URL('../../../modules/join/src/msteams/join.ts', import.meta.url)))});
  const { leaveMicrosoftTeams } = await load(${JSON.stringify(fileURLToPath(new URL('../../../modules/join/src/msteams/leave.ts', import.meta.url)))});
  const { joinZoomMeeting } = await load(${JSON.stringify(fileURLToPath(new URL('../../../modules/join/src/zoom/join.ts', import.meta.url)))});
  const { leaveZoomMeeting } = await load(${JSON.stringify(fileURLToPath(new URL('../../../modules/join/src/zoom/leave.ts', import.meta.url)))});
  let fail = false;
  const pages = {};
  function makePage(platform) {
    let typed = '';
    const page = {
      isClosed() { return false; }, url() { return platform === 'teams' ? 'https://teams.microsoft.com/l/meetup-join/SYNTH_MEETING_614' : 'https://meet.google.com/SYNTH_MEETING_614'; },
      async title() { return 'SYNTH_PAGE_TITLE_629'; },
      async goto() {}, async bringToFront() {}, async screenshot() {}, async waitForTimeout() {},
      async waitForFunction() {}, async waitForSelector() {},
      async fill(_selector, value) { typed = value; },
      keyboard: { async type(value) { typed = value; }, async press() {} },
      async evaluate(fn) {
        if (fail) throw new Error('SYNTH_PROVIDER_BODY_615 /private/SYNTH_PATH_616');
        if (platform === 'google_meet' && String(fn).includes('documentElement')) return { lang: 'fr', nav: 'fr-FR' };
        if (platform === 'zoom') return false;
        return true;
      },
      locator() {
        const loc = {
          first() { return loc; }, async isVisible() { return true; }, async waitFor() {},
          async click() { if (fail) throw new Error('SYNTH_PROVIDER_BODY_615'); }, async fill(value) { typed = value; }, async inputValue() { return ''; },
          async getAttribute() { return null; }, async elementHandle() { return { async click() {}, async dispose() {} }; },
        };
        return loc;
      },

      get typed() { return typed; },
    };
    pages[platform] = page;
    return page;
  }
  await joinGoogleMeeting(makePage('google_meet'), 'https://meet.google.com/SYNTH_MEETING_614?authuser=SYNTH_TOKEN_617', 'SYNTH_NAME_618', {platform:'google_meet', uiInteractionMode:'synthetic'});
  await joinMicrosoftTeams(makePage('teams'), 'https://teams.microsoft.com/l/meetup-join/SYNTH_MEETING_614?token=SYNTH_TOKEN_617', 'SYNTH_NAME_619', {platform:'teams'});
  await joinZoomMeeting(makePage('zoom'), 'https://zoom.us/j/123456789?pwd=SYNTH_TOKEN_617', 'SYNTH_NAME_620', {platform:'zoom', passcode:'SYNTH_CODE_621'});
  if (pages.google_meet.typed !== 'SYNTH_NAME_618' || pages.teams.typed !== 'SYNTH_NAME_619' || pages.zoom.typed !== 'SYNTH_NAME_620') process.exit(32);
  fail = true;
  await leaveGoogleMeet(pages.google_meet, {}, 'SYNTH_LEAVE_REASON_622');
  await leaveMicrosoftTeams(pages.teams, {}, 'SYNTH_LEAVE_REASON_622');
  await leaveZoomMeeting(pages.zoom, {}, 'SYNTH_LEAVE_REASON_622');
`;
const providerJoinResult = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', providerJoinScript], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  encoding: 'utf8',
});
assert.equal(providerJoinResult.status, 0, providerJoinResult.stderr);
const providerOutput = providerJoinResult.stdout + providerJoinResult.stderr;
for (const canary of ['SYNTH_MEETING_614', 'SYNTH_TOKEN_617', 'SYNTH_NAME_618', 'SYNTH_NAME_619', 'SYNTH_NAME_620',
  'SYNTH_CODE_621', 'SYNTH_PROVIDER_BODY_615', 'SYNTH_PATH_616', 'SYNTH_LEAVE_REASON_622', 'SYNTH_PAGE_TITLE_629']) {
  assert.equal(providerOutput.includes(canary), false, `provider process output leaked ${canary}`);
}
assert.match(providerOutput, /"event":"join\.lobby_locale"/);
assert.match(providerOutput, /"html_lang":"fr"/);
assert.match(providerOutput, /"event":"join\.name_entry"/);
assert.match(providerOutput, /"event":"leave\.failed"/);
const removalAdmissionScript = `
  import { installProcessLogSanitizer } from ${JSON.stringify(fileURLToPath(new URL('./log-sanitizer.ts', import.meta.url)))};
  installProcessLogSanitizer();
  const load = async specifier => { const module = await import(specifier); return { ...(module.default ?? {}), ...module }; };
  const { classifyGoogleRejection } = await load(${JSON.stringify(fileURLToPath(new URL('../../../modules/join/src/googlemeet/admission.ts', import.meta.url)))});
  const { waitForZoomMeetingAdmission } = await load(${JSON.stringify(fileURLToPath(new URL('../../../modules/join/src/zoom/admission.ts', import.meta.url)))});
  const { startZoomRemovalMonitor } = await load(${JSON.stringify(fileURLToPath(new URL('../../../modules/join/src/zoom/removal.ts', import.meta.url)))});
  const pageText = 'You were removed from the meeting SYNTH_PAGE_TEXT_623 NATIVE_MEETING_624';
  const googlePage = { locator() { return { first() { return this; }, async isVisible() { return pageText.includes('SYNTH_PAGE_TEXT_623'); } }; } };
  const verdict = await classifyGoogleRejection(googlePage);
  if (!verdict.rejected) process.exit(33);
  const zoomPageText = "automated bots aren't allowed SYNTH_ZOOM_TEXT_625 NATIVE_MEETING_626";
  const zoomAdmissionPage = {
    locator() { return { first() { return this; }, async isVisible() { return false; } }; },
    async evaluate(_fn, phrases) { return phrases.find(text => zoomPageText.toLowerCase().includes(text.toLowerCase())) || null; },
  };
  try { await waitForZoomMeetingAdmission(zoomAdmissionPage, 10, {}); } catch {}
  const modalText = 'This meeting has been ended by host SYNTH_MODAL_TEXT_627 NATIVE_MEETING_628';
  const removalPage = {
    isClosed() { return false; }, on() {}, off() {}, url() { return 'https://app.zoom.us/wc/NATIVE_MEETING_628/meeting'; },
    title: async () => 'Meeting',
    locator(selector) {
      const modal = String(selector) === '.zm-modal-body-title';
      return { first() { return this; }, async isVisible() { return modal; }, async textContent() { return modalText; }, async click() {} };
    },
    async evaluate() { return null; },
  };
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback) => { queueMicrotask(callback); return 1; };
  await new Promise(resolve => startZoomRemovalMonitor(removalPage, resolve));
  globalThis.setTimeout = originalSetTimeout;
`;
const removalAdmissionResult = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', removalAdmissionScript], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  encoding: 'utf8',
});
assert.equal(removalAdmissionResult.status, 0, removalAdmissionResult.stderr);
const removalAdmissionOutput = removalAdmissionResult.stdout + removalAdmissionResult.stderr;
for (const canary of ['SYNTH_PAGE_TEXT_623', 'NATIVE_MEETING_624', 'SYNTH_ZOOM_TEXT_625', 'NATIVE_MEETING_626',
  'SYNTH_MODAL_TEXT_627', 'NATIVE_MEETING_628']) {
  assert.equal(removalAdmissionOutput.includes(canary), false, `admission/removal output leaked ${canary}`);
}
assert.match(removalAdmissionOutput, /"event":"admission\.rejected"/);
assert.match(removalAdmissionOutput, /"event":"removal\.detected"/);
assert.match(removalAdmissionOutput, /"removed":true/);
console.log('PASS process log sanitizer: real stdout/stderr sinks retain counts/status and redact canaries');
const fatalHandlers = fileURLToPath(new URL('./install-process-fatal-handlers.ts', import.meta.url));
for (const kind of ['uncaught_exception', 'unhandled_rejection'] as const) {
  const trigger = kind === 'uncaught_exception'
    ? "setTimeout(() => { throw new Error('FATAL_CANARY https://meet.google.com/xxx-xxxx-xxx?token=FATAL_TOKEN'); }, 0);"
    : "Promise.reject(new Error('FATAL_CANARY https://meet.google.com/xxx-xxxx-xxx?token=FATAL_TOKEN'));";
  const fatalScript = `import ${JSON.stringify(fatalHandlers)};\n${trigger}`;
  const fatalResult = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', fatalScript], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
  });
  assert.equal(fatalResult.status, 1, `${kind} must terminate with status 1: ${fatalResult.stderr}`);
  const fatalOutput = fatalResult.stdout + fatalResult.stderr;
  for (const canary of ['FATAL_CANARY', 'FATAL_TOKEN', 'xxx-xxxx-xxx', 'Error', 'at ']) {
    assert.equal(fatalOutput.includes(canary), false, `${kind} output leaked ${canary}`);
  }
  const fatalRecords = fatalOutput.split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(fatalRecords.length, 1);
  assert.deepEqual(fatalRecords[0], {
    level: 'fatal', event: 'process.fatal', kind, error_code: 'operation_failed',
  });
}
