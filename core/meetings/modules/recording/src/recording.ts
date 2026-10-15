import * as fs from 'fs';
import * as path from 'path';
import { log, logJSON } from './log';

import http from 'http';
import https from 'https';

/**
 * RecordingService handles accumulating audio data and producing a WAV file.
 * Works in Node.js context — used directly for Zoom (native audio callback),
 * and receives finalized blobs from browser-based bots (Google Meet, Teams).
 */
export class RecordingService {
  private filePath: string;
  private writeStream: fs.WriteStream | null = null;
  private totalSamples: number = 0;
  private sampleRate: number;
  private channels: number;
  private isFinalized: boolean = false;
  private startTime: number = 0;

  constructor(
    private meetingId: number,
    private sessionUid: string,
    sampleRate: number = 16000,
    channels: number = 1
  ) {
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.filePath = path.join('/tmp', `recording_${meetingId}_${sessionUid}.wav`);
  }

  /**
   * Start recording — open file and write WAV header placeholder.
   */
  start(): void {
    log("[Recording] Recording started");
    this.writeStream = fs.createWriteStream(this.filePath);
    // Write a placeholder WAV header (44 bytes) — will be rewritten on finalize
    this.writeStream.write(this.createWavHeader(0));
    this.totalSamples = 0;
    this.isFinalized = false;
    this.startTime = Date.now();
  }

  /**
   * Append a Float32Array audio chunk (converts to Int16 PCM and writes).
   */
  appendChunk(audioData: Float32Array): void {
    if (!this.writeStream || this.isFinalized) return;

    const pcmBuffer = this.float32ToInt16PCM(audioData);
    this.writeStream.write(pcmBuffer);
    this.totalSamples += audioData.length;
  }

  /**
   * Append raw PCM Int16 buffer directly (e.g., from PulseAudio capture).
   */
  appendPCMBuffer(buffer: Buffer): void {
    if (!this.writeStream || this.isFinalized) return;

    this.writeStream.write(buffer);
    this.totalSamples += buffer.length / 2; // Int16 = 2 bytes per sample
  }

  /**
   * Write a blob (Buffer) directly as the recording file.
   * Used for browser-based recordings (MediaRecorder output).
   */
  async writeBlob(data: Buffer, format: string = 'wav'): Promise<string> {
    const blobPath = path.join('/tmp', `recording_${this.meetingId}_${this.sessionUid}.${format}`);
    await fs.promises.writeFile(blobPath, data);
    // Browser-based recordings may not use the default WAV path.
    // Point uploads/cleanup to the actual written blob file.
    this.filePath = blobPath;
    log(`[Recording] Recording blob written: bytes=${data.length}`);
    this.isFinalized = true;
    return blobPath;
  }

  /**
   * Finalize the WAV file — close stream and rewrite header with correct size.
   * Returns the file path.
   */
  async finalize(): Promise<string> {
    if (this.isFinalized) return this.filePath;
    this.isFinalized = true;

    return new Promise((resolve, reject) => {
      if (!this.writeStream) {
        reject(new Error('No write stream — recording was not started'));
        return;
      }

      this.writeStream.end(() => {
        try {
          // Rewrite the WAV header with correct data size
          const dataSize = this.totalSamples * 2; // Int16 = 2 bytes per sample
          const headerBuffer = this.createWavHeader(dataSize);
          const fd = fs.openSync(this.filePath, 'r+');
          fs.writeSync(fd, headerBuffer, 0, 44, 0);
          fs.closeSync(fd);

          const stats = fs.statSync(this.filePath);
          const durationSeconds = this.totalSamples / this.sampleRate;
          log(`[Recording] Finalized: bytes=${stats.size}, duration_seconds=${durationSeconds.toFixed(1)}, samples=${this.totalSamples}`);
          resolve(this.filePath);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  /**
   * Upload the finalized recording to the meeting-api internal upload endpoint.
   * Retries up to 3 times with exponential backoff on transient failures.
   */
  async upload(callbackUrl: string, token: string): Promise<void> {
    const maxRetries = 3;
    const baseDelayMs = 1000;
    const uploadTimeoutMs = 30_000;

    const filePath = this.isFinalized ? this.filePath : await this.finalize();
    const fileData = await fs.promises.readFile(filePath);
    const fileStats = await fs.promises.stat(filePath);
    const format = path.extname(filePath).slice(1) || 'wav';
    const durationSeconds = format === 'wav'
      ? this.totalSamples / this.sampleRate
      : (this.startTime > 0 ? (Date.now() - this.startTime) / 1000 : undefined);

    log(`[Recording] Uploading ${fileStats.size} bytes`);

    const boundary = `----VexaRecording${Date.now()}`;
    const metadata = JSON.stringify({
      meeting_id: this.meetingId,
      session_uid: this.sessionUid,
      format: format,
      sample_rate: this.sampleRate,
      channels: this.channels,
      duration_seconds: durationSeconds,
      file_size_bytes: fileStats.size,
    });

    // Build multipart body
    const parts: Buffer[] = [];
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n`));
    parts.push(Buffer.from(metadata));
    parts.push(Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="recording.${format}"\r\nContent-Type: audio/${format}\r\n\r\n`));
    parts.push(fileData);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this._sendUpload(callbackUrl, token, boundary, body, uploadTimeoutMs);
        return; // Success
      } catch {
        const isLastAttempt = attempt === maxRetries;
        if (isLastAttempt) {
          // Preserve only bounded counts and size metrics on upload failure.
          logJSON({
            level: "error",
            msg: "[Recording] Upload failed permanently",
            attempts: maxRetries + 1,
            error_code: "upload_failed",
            file_size_bytes: fileStats.size,
            duration_seconds: durationSeconds,
            meeting_id: this.meetingId,
          });
          throw new Error('recording_upload_failed');
        }
        const delay = baseDelayMs * Math.pow(2, attempt);
        logJSON({
          level: "warn",
          msg: "[Recording] Upload attempt failed; will retry",
          attempt: attempt + 1,
          attempts_max: maxRetries + 1,
          retry_delay_ms: delay,
          error_code: "upload_failed",
          meeting_id: this.meetingId,
        });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Upload a single recording chunk to the meeting-api internal endpoint.
   *
   * DEPLOYMENT NOTE — recording.v1 has TWO transports by deployment (deliberate):
   *   - PRODUCTION / bot (this): HTTP multipart POST → meeting-api
   *     /internal/recordings/upload.
   *   - DESKTOP: the same recording.v1 chunk encoded by @vexa/capture-codec
   *     (encodeRecordingChunk) and sent over the ingest WS — the all-Node desktop
   *     has no meeting-api HTTP endpoint, so chunks ride the existing capture WS.
   *   Same {seq, is_final, format, bytes} contract, two wires.
   *
   * Pack B (issue #218): the bot's MediaRecorder emits a chunk every N ms;
   * each chunk lands in MinIO immediately so an ungraceful exit (SIGKILL)
   * leaves the already-uploaded chunks durable. Set `isFinal=true` on the
   * last chunk (the one sent from the graceful-shutdown path) so meeting-api
   * flips Recording.status from IN_PROGRESS to COMPLETED and fires the
   * recording.completed webhook.
   *
   * chunk_seq is monotonically increasing from 0. Storage path ends up at
   * `recordings/<user>/<storage_id>/<session>/<chunk_seq:06d>.<format>`.
   *
   * Uses the same multipart body shape as upload() — meeting-api receives
   * identical field names, just with chunk_seq + is_final=false for
   * intermediate chunks.
   */
  async uploadChunk(
    callbackUrl: string,
    token: string,
    chunkData: Buffer,
    chunkSeq: number,
    isFinal: boolean,
    format: string = 'webm',
  ): Promise<void> {
    const uploadTimeoutMs = 30_000;
    const durationSeconds = this.startTime > 0 ? (Date.now() - this.startTime) / 1000 : undefined;

    const boundary = `----VexaRecordingChunk${Date.now()}${chunkSeq}`;
    const metadata = JSON.stringify({
      meeting_id: this.meetingId,
      session_uid: this.sessionUid,
      format: format,
      sample_rate: this.sampleRate,
      channels: this.channels,
      duration_seconds: durationSeconds,
      file_size_bytes: chunkData.length,
      chunk_seq: chunkSeq,
      is_final: isFinal,
    });

    const parts: Buffer[] = [];
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n`));
    parts.push(Buffer.from(metadata));
    parts.push(Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chunk_seq"\r\n\r\n${chunkSeq}\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="is_final"\r\n\r\n${isFinal ? 'true' : 'false'}\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="recording.${chunkSeq}.${format}"\r\nContent-Type: audio/${format}\r\n\r\n`));
    parts.push(chunkData);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this._sendUpload(callbackUrl, token, boundary, body, uploadTimeoutMs);
        logJSON({
          level: "info",
          msg: "[Recording] Chunk uploaded",
          chunk_seq: chunkSeq,
          is_final: isFinal,
          chunk_size_bytes: chunkData.length,
          meeting_id: this.meetingId,
        });
        return;
      } catch {
        if (attempt === maxRetries) {
          // Preserve the chunk index, final marker, and byte count without provider text or ids.
          logJSON({
            level: "error",
            msg: "[Recording] Chunk upload failed permanently",
            chunk_seq: chunkSeq,
            is_final: isFinal,
            chunk_size_bytes: chunkData.length,
            attempts: maxRetries + 1,
            error_code: "upload_failed",
            meeting_id: this.meetingId,
          });
          throw new Error('recording_upload_failed');
        }
        const delay = 500 * Math.pow(2, attempt);
        logJSON({
          level: "warn",
          msg: "[Recording] Chunk upload attempt failed; will retry",
          chunk_seq: chunkSeq,
          is_final: isFinal,
          attempt: attempt + 1,
          attempts_max: maxRetries + 1,
          retry_delay_ms: delay,
          error_code: "upload_failed",
          meeting_id: this.meetingId,
        });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  private _sendUpload(callbackUrl: string, token: string, boundary: string, body: Buffer, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL(callbackUrl);
      const transport = url.protocol === 'https:' ? https : http;
      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          timeout: timeoutMs,
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
            'Authorization': `Bearer ${token}`,
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              logJSON({
                level: "info",
                msg: "[Recording] Upload successful",
                http_status: res.statusCode,
                meeting_id: this.meetingId,
              });
              resolve();
            } else {
              // v0.10.5 Pack G.1 — capture status code distinct from
              // message body so operators can route 4xx (caller bug)
              // vs 5xx (transient platform) automatically.
              logJSON({
                level: "warn",
                msg: "[Recording] Upload returned non-2xx",
                http_status: res.statusCode,
              });
              reject(new Error(`upload_failed_http_${res.statusCode ?? 0}`));
            }
          });
        }
      );
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`recording_upload_timeout_${timeoutMs}ms`));
      });
      req.on('error', () => {
        log(`[Recording] Upload error`);
        reject(new Error('recording_upload_failed'));
      });
      req.write(body);
      req.end();
    });
  }

  /**
   * Clean up temporary files.
   */
  async cleanup(): Promise<void> {
    try {
      if (fs.existsSync(this.filePath)) {
        await fs.promises.unlink(this.filePath);
        log("[Recording] Temporary file cleaned");
      }
    } catch {
      log("[Recording] Temporary file cleanup failed");
    }
  }

  getFilePath(): string {
    return this.filePath;
  }

  getStartTime(): number {
    return this.startTime;
  }

  getDurationSeconds(): number {
    return this.totalSamples / this.sampleRate;
  }

  getFileSizeBytes(): number {
    try {
      return fs.statSync(this.filePath).size;
    } catch {
      return 0;
    }
  }

  // --- WAV helpers ---

  private createWavHeader(dataSize: number): Buffer {
    const header = Buffer.alloc(44);
    const byteRate = this.sampleRate * this.channels * 2; // 16-bit = 2 bytes
    const blockAlign = this.channels * 2;

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);       // Subchunk1Size (PCM)
    header.writeUInt16LE(1, 20);        // AudioFormat (PCM)
    header.writeUInt16LE(this.channels, 22);
    header.writeUInt32LE(this.sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(16, 34);       // BitsPerSample
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return header;
  }

  private float32ToInt16PCM(float32Data: Float32Array): Buffer {
    const buffer = Buffer.alloc(float32Data.length * 2);
    for (let i = 0; i < float32Data.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Data[i]));
      const val = s < 0 ? s * 0x8000 : s * 0x7FFF;
      buffer.writeInt16LE(Math.round(val), i * 2);
    }
    return buffer;
  }
}
