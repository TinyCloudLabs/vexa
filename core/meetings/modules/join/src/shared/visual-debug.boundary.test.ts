/** Manual, networkless image test: real X11, VNC authentication and Lite supervisor. */
import assert from 'assert/strict';
import { spawn, spawnSync, execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { connect } from 'net';
import { once } from 'events';
import { promisify } from 'util';
import { setHooks } from '../_host';
import { resetEscalation, startDebugView, triggerEscalation } from './escalation';

// X11/supervisor are external processes: fake clocks cannot advance their socket readiness.
const delay = promisify(setTimeout);
async function ready(path: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (existsSync(path)) return;
    await delay(50);
  }
  throw new Error('fixture socket did not become ready');
}
function listeners(port: number): string[] {
  return ['/proc/net/tcp', '/proc/net/tcp6'].flatMap(path => readFileSync(path, 'utf8').trim().split('\n').slice(1)
    .map(line => line.trim().split(/\s+/)).filter(fields => fields[3] === '0A' && fields[1].endsWith(':' + port.toString(16).toUpperCase().padStart(4, '0')))
    .map(fields => fields[1].split(':')[0]));
}
function noExport(): void {
  for (const port of [5900, 6080]) assert.deepEqual(listeners(port), [], `visual export port ${port} must stay closed`);
}
async function passwordAndLoopbackOnly(): Promise<void> {
  for (let i = 0; i < 100 && !listeners(6080).length; i++) await delay(50);
  for (const port of [5900, 6080]) {
    const bound = listeners(port);
    assert.ok(bound.includes('0100007F'), `visual export port ${port} must listen on IPv4 loopback`);
    assert.ok(bound.every(address => ['0100007F', '00000000000000000000000001000000'].includes(address)), `visual export port ${port} must never bind a non-loopback address: ${bound}`);
  }
  const socket = connect(5900, '127.0.0.1');
  socket.setTimeout(3000, () => socket.destroy(new Error('RFB handshake timeout')));
  const chunks = socket[Symbol.asyncIterator]();
  let data = Buffer.alloc(0);
  const read = async (count: number): Promise<Buffer> => {
    while (data.length < count) {
      const chunk = await chunks.next();
      assert.equal(chunk.done, false, 'RFB closed before authentication negotiation');
      data = Buffer.concat([data, chunk.value]);
    }
    const result = data.subarray(0, count);
    data = data.subarray(count);
    return result;
  };
  try {
    assert.equal((await read(12)).toString(), 'RFB 003.008\n');
    socket.write('RFB 003.008\n');
    const count = (await read(1))[0];
    assert.deepEqual([...(await read(count))], [2], 'RFB must offer password authentication, never None');
  } finally {
    socket.destroy();
  }
  const response = await fetch('http://127.0.0.1:6080/vnc.html');
  assert.equal(response.status, 200, 'the explicitly enabled local noVNC page is available');
  await response.arrayBuffer();
}
async function lite(scope: string, flag: string | undefined): Promise<void> {
  const config = join(scope, 'supervisord.conf');
  const socket = join(scope, 'supervisor.sock');
  execFileSync('python3', ['-c', `import configparser,sys
c=configparser.RawConfigParser(); c.read('/probe/supervisord.conf')
o=configparser.RawConfigParser()
o['supervisord']={'nodaemon':'true','logfile':sys.argv[1]+'/supervisor.log','pidfile':sys.argv[1]+'/supervisor.pid'}
o['unix_http_server']={'file':sys.argv[2],'chmod':'0600'}
o['supervisorctl']={'serverurl':'unix://'+sys.argv[2]}
o['rpcinterface:supervisor']={'supervisor.rpcinterface_factory':'supervisor.rpcinterface:make_main_rpcinterface'}
for name in ['x11vnc','websockify']:
 s='program:'+name; o[s]=dict(c[s]); o[s]['stdout_logfile']=sys.argv[1]+'/'+name+'.out'; o[s]['stderr_logfile']=sys.argv[1]+'/'+name+'.err'
with open(sys.argv[3],'w') as f:o.write(f)
`, scope, socket, config]);
  const supervisor = spawn('python3', ['-m', 'supervisor.supervisord', '-n', '-c', config], { stdio: 'ignore' });
  try {
    await ready(socket);
    const status = spawnSync('python3', ['-m', 'supervisor.supervisorctl', '-c', config, 'status'], { encoding: 'utf8' });
    for (const name of ['x11vnc', 'websockify']) assert.match(status.stdout, new RegExp('^' + name + '\\s+STOPPED', 'm'), 'Lite must not automatically start visual export, even with opt-in');
    noExport();
    if (flag === '1') {
      execFileSync('python3', ['-m', 'supervisor.supervisorctl', '-c', config, 'start', 'x11vnc', 'websockify']);
      await passwordAndLoopbackOnly();
    }
  } finally {
    if (supervisor.exitCode === null && supervisor.signalCode === null) {
      const exited = once(supervisor, 'exit');
      supervisor.kill('SIGTERM');
      await exited;
    }
  }
}
async function main(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'production');
  const mode = process.argv[2] ?? 'escalation';
  const scope = mkdtempSync(join(tmpdir(), 'vexa-visual-debug-'));
  const display = spawn('Xvfb', [':97', '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  process.env.DISPLAY = ':97';
  delete process.env.VEXA_VISUAL_DEBUG;
  const password = join(scope, 'password');
  writeFileSync(password, 'Fixture8\n', { mode: 0o600 });
  process.env.VEXA_VISUAL_DEBUG_PASSWORD_FILE = password;
  try {
    await ready('/tmp/.X11-unix/X97');
    noExport();
    if (mode === 'escalation' || mode === 'escalation-opt-in') {
      if (mode === 'escalation-opt-in') process.env.VEXA_VISUAL_DEBUG = '1';
      let notifications = 0;
      setHooks({ onState: async state => { assert.equal(state, 'needs_human_help'); notifications++; return true; } });
      resetEscalation();
      await triggerEscalation({}, 'unknown_blocking_state');
      assert.equal(notifications, 1, 'escalation still notifies the meeting owner');
      noExport();
    } else if (mode === 'opt-in') {
      for (const flag of [undefined, '', '0', 'false', 'true', '01', ' 1', '1 ']) {
        if (flag === undefined) delete process.env.VEXA_VISUAL_DEBUG;
        else process.env.VEXA_VISUAL_DEBUG = flag;
        const view = await startDebugView();
        assert.equal(view.vncUrl, undefined);
        assert.equal(view.novncUrl, undefined);
        noExport();
      }
      process.env.VEXA_VISUAL_DEBUG = '1';
      delete process.env.VEXA_VISUAL_DEBUG_PASSWORD_FILE;
      await assert.rejects(startDebugView(), /password/i);
      noExport();
      process.env.VEXA_VISUAL_DEBUG_PASSWORD_FILE = password;
      for (const invalid of ['', '__EMPTY__\n', '#comment\n', 'Fixture8\nExtraPass\n']) {
        writeFileSync(password, invalid, { mode: 0o600 });
        await assert.rejects(startDebugView(), /password/i);
        noExport();
      }
      writeFileSync(password, 'Fixture8\n', { mode: 0o600 });
      chmodSync(password, 0o644);
      await assert.rejects(startDebugView(), /password/i);
      noExport();
      chmodSync(password, 0o600);
      const view = await startDebugView();
      assert.equal(view.vncUrl, 'vnc://127.0.0.1:5900');
      assert.equal(view.novncUrl, 'http://127.0.0.1:6080/vnc.html');
      await passwordAndLoopbackOnly();
    } else if (mode === 'lite') {
      await lite(scope, undefined);
      process.env.VEXA_VISUAL_DEBUG = '1';
      await lite(scope, '1');
    } else throw new Error('unknown boundary test mode');
    console.log(`PASS visual privacy ${mode}`);
  } finally {
    if (display.exitCode === null && display.signalCode === null) {
      const exited = once(display, 'exit');
      display.kill('SIGTERM');
      await exited;
    }
    rmSync(scope, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
