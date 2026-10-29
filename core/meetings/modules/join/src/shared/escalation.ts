import { spawn } from 'child_process';
import { visualDebugCommands } from './visual-debug';
import { log, callNeedsHumanHelpCallback } from '../_host';

let escalationTriggered = false;
let vncStarted = false;
let escalationInFlight = false;
// Earliest virtual time (ms) of the next delivery attempt after a refused or failed one.
let retryNotBefore = 0;

/** Gap between delivery attempts while meeting-api keeps refusing the escalation. */
export const ESCALATION_RETRY_COOLDOWN_MS = 30_000;

export interface EscalationResult {
  reason: string;
  urgency: 'high' | 'critical';
}

/**
 * Check if escalation should be triggered based on admission state.
 * Called from each platform's admission poll loop.
 * Returns non-null if escalation is needed.
 */
export function checkEscalation(
  elapsedMs: number,
  timeoutMs: number,
  unknownStateDurationMs: number,
  joinFailed?: boolean,
  pageAlive?: boolean
): EscalationResult | null {
  if (escalationTriggered) return null;

  if (elapsedMs > timeoutMs * 0.8) {
    return { reason: 'waiting_room_timeout_approaching', urgency: 'high' };
  }
  if (unknownStateDurationMs > 10_000) {
    return { reason: 'unknown_blocking_state', urgency: 'critical' };
  }
  if (joinFailed && pageAlive) {
    return { reason: 'join_error_page_alive', urgency: 'critical' };
  }
  return null;
}

/**
 * Trigger escalation: notify meeting-api without enabling visual export.
 * Idempotent — only fires once per admission attempt. A refused or failed attempt is retried
 * no sooner than ESCALATION_RETRY_COOLDOWN_MS later. `now` is injectable so tests run on virtual time.
 */
export async function triggerEscalation(botConfig: any, reason: string, now: number = Date.now()): Promise<void> {
  if (escalationTriggered || escalationInFlight || now < retryNotBefore) return;
  escalationInFlight = true;
  try {
    log(`[Escalation] Triggered: ${reason}`);
    const accepted = await callNeedsHumanHelpCallback(botConfig, reason);
    // Only an accepted escalation is one-shot. A refused one is retried after the cooldown.
    if (accepted) escalationTriggered = true;
    else log(`[Escalation] Not delivered; retry after cooldown: ${reason}`);
  } finally {
    if (!escalationTriggered) retryNotBefore = now + ESCALATION_RETRY_COOLDOWN_MS;
    escalationInFlight = false;
  }
}

/**
 * Explicit debug-only visual export. Escalation never starts these services.
 */
export async function startVncStack(): Promise<boolean> {
  const commands = visualDebugCommands();
  if (!commands.length) return false;
  if (vncStarted) return true;

  log('[Debug] Starting password-protected loopback-only visual debug');

  // spawn() failures surface as an async 'error' event; without a listener Node
  // throws and kills the bot. Attach a tolerant handler on each child.
  const safeSpawn = (cmd: string, args: string[]) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.once('error', (e: any) => log(`[Debug] ${cmd} unavailable (${e?.code || e?.message}) — continuing`));
      child.unref();
    } catch (e: any) {
      log(`[Debug] ${cmd} spawn failed (${e?.message}) — continuing`);
    }
  };

  for (const { command, args } of commands) safeSpawn(command, args);

  // Wait for VNC port to be ready (up to 3s)
  await waitForPort(5900, 3000);
  vncStarted = true;
  log('[Debug] Visual debug started on loopback ports 5900/6080');
  return true;
}

/**
 * Explicit opt-in debug entry. VNC/noVNC require a private password file;
 * neither meeting configuration nor escalation enables them.
 */
export async function startDebugView(): Promise<{ vncUrl?: string; novncUrl?: string; cdpUrl: string }> {
  const enabled = await startVncStack();
  return {
    vncUrl: enabled ? 'vnc://127.0.0.1:5900' : undefined,
    novncUrl: enabled ? 'http://127.0.0.1:6080/vnc.html' : undefined,
    cdpUrl: 'http://localhost:9222', // Playwright connectOverCDP target
  };
}

/**
 * Extra time (ms) granted when escalation is active, so the user has time to intervene.
 */
export function getEscalationExtensionMs(): number {
  return escalationTriggered ? 5 * 60 * 1000 : 0;
}

export function wasEscalationTriggered(): boolean {
  return escalationTriggered;
}

export function resetEscalation(): void {
  escalationTriggered = false;
  retryNotBefore = 0;
}

// ---- internal helpers ----

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const net = require('net');
      const socket = new net.Socket();
      socket.setTimeout(200);
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - start < timeoutMs) {
          setTimeout(check, 200);
        } else {
          log('[Escalation] VNC port wait timed out — continuing anyway');
          resolve();
        }
      });
      socket.once('timeout', () => {
        socket.destroy();
        if (Date.now() - start < timeoutMs) {
          setTimeout(check, 200);
        } else {
          resolve();
        }
      });
      socket.connect(port, '127.0.0.1');
    };
    check();
  });
}
