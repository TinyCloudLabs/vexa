import { spawn } from 'child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'fs';

/** Explicit local debugging only. VNC's password protocol uses exactly eight bytes. */
export function visualDebugCommands(): { command: string; args: string[] }[] {
  if (process.env.VEXA_VISUAL_DEBUG !== '1' || process.platform !== 'linux' || !process.env.DISPLAY) return [];
  const file = process.env.VEXA_VISUAL_DEBUG_PASSWORD_FILE;
  if (!file) throw new Error('visual_debug_password_required');
  let passwordFile: string;
  try {
    passwordFile = realpathSync(file);
    const stat = statSync(passwordFile);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('invalid password file');
    const password = readFileSync(passwordFile, 'utf8').replace(/\r?\n$/, '');
    // A single literal password, not x11vnc's comment/empty-password/multiple-password syntax.
    if (!/^[!-~]{8}$/.test(password) || password.startsWith('#') || password.includes('__')) {
      throw new Error('invalid password file');
    }
  } catch {
    throw new Error('visual_debug_password_invalid');
  }
  const websocket = ['127.0.0.1:6080', '127.0.0.1:5900'];
  // Configure both x11vnc's listener and LibVNCServer's separate IPv6 listener.
  return [
    { command: 'x11vnc', args: ['-display', process.env.DISPLAY, '-forever', '-shared', '-no6', '-listen', '127.0.0.1', '-listenv6', '::1', '-rfbport', '5900', '-passwdfile', passwordFile] },
    { command: 'websockify', args: existsSync('/usr/share/novnc') ? ['--web', '/usr/share/novnc', ...websocket] : websocket },
  ];
}

// Lite's supervised manual debug services use exactly the same opt-in, password and bind policy.
if (require.main === module) {
  try {
    const service = visualDebugCommands().find(item => item.command === process.argv[2]);
    if (!service) throw new Error('visual_debug_not_enabled');
    const child = spawn(service.command, service.args, { stdio: 'ignore' });
    child.once('error', () => { console.error('visual_debug_start_failed'); process.exitCode = 1; });
    child.once('exit', code => { process.exitCode = code ?? 1; });
    process.on('SIGTERM', () => { child.kill('SIGTERM'); });
    process.on('SIGINT', () => { child.kill('SIGINT'); });
  } catch {
    console.error('visual_debug_configuration_invalid');
    process.exitCode = 1;
  }
}
