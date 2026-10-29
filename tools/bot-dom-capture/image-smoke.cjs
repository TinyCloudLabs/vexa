'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { launchBrowser } = require('/app/core/meetings/services/bot/dist/capture-bridge.js');
const host = require('/app/core/meetings/modules/join/dist/_host.js');
const { waitForLobbyCta } = require('/app/core/meetings/modules/join/dist/googlemeet/join.js');
const { googleJoinButtonSelectors } = require('/app/core/meetings/modules/join/dist/googlemeet/selectors.js');
const ROOT = '/var/local/vexa-dom-capture';
const deadline = setTimeout(() => { console.error('LOCAL_CAPTURE_IMAGE_SMOKE_TIMEOUT'); process.exit(1); }, 15_000);
const inv = {platform:'google_meet',meetingUrl:'https://meet.google.com/abc-defg-hij',nativeMeetingId:'abc-defg-hij',botName:'PRIVATE_FIXTURE_NAME_CANARY',authenticated:false,redisUrl:'redis://invalid'};
(async () => {
  const session = await launchBrowser(inv);
  try {
    const fixture = fs.readFileSync('/fixtures/captured-c-guest-lobby.html','utf8');
    await session.page.goto('data:text/html,'+encodeURIComponent(fixture));
    await session.page.fill('input[jsname="YPqjbf"]','PRIVATE_FIXTURE_NAME_CANARY');
    host.logJSON({event:'join.name_entry',success:true});
    await session.page.waitForSelector('button');
    await session.page.screenshot({path:'/tmp/LOCAL_RAW_CAPTURE_MUST_NOT_EXIST.png'});
    assert.equal(fs.existsSync('/tmp/LOCAL_RAW_CAPTURE_MUST_NOT_EXIST.png'),false,'preload must not persist original page pixels');
    await session.page.setContent('<html lang="en"><body><input value="PRIVATE_FIXTURE_NAME_CANARY"><button>Alpha</button><button>Beta</button></body></html>');
    await assert.rejects(waitForLobbyCta(session.page, googleJoinButtonSelectors, 900,'join button'),/code=selector_not_found/);
    await require('/opt/vexa-local-dom-capture/preload.cjs').captureDeadline();
    const files=fs.readdirSync(ROOT);
    const expected = JSON.parse(fs.readFileSync(ROOT+'/LOCAL_DIAGNOSTIC_ONLY.json','utf8')).mode === 'checkpoints' ? 4 : 2;
    assert.equal(files.filter(file=>file.endsWith('.html')).length,expected);
    assert.equal(files.filter(file=>file.endsWith('.rendered.png')).length,expected);
    for(const file of files) {
      assert.equal(fs.statSync(ROOT+'/'+file).mode&0o777,0o600);
      if(file.endsWith('.html')) {
        const text=fs.readFileSync(ROOT+'/'+file,'utf8');
        assert.doesNotMatch(text,/PRIVATE_FIXTURE_NAME_CANARY|abc-defg-hij|https?:|<!--/);
      }
    }
    assert.ok(files.some(file=>file.includes('selector_failure')&&file.endsWith('.rendered.png')));
    assert.ok(files.some(file=>file.includes('operator_deadline')&&file.endsWith('.rendered.png')));
    console.log('LOCAL_TOOL_ACTUAL_IMAGE_PASS: real unchanged bot browser, explicit preload, name/checkpoint/failure DOM+renderedPNG, no raw pixels, mode0600, network=none');
  } finally { await session.close(); clearTimeout(deadline); }
})().catch(error=>{console.error(error);process.exitCode=1;});
