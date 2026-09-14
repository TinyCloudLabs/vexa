import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtempSync,
  rmSync,
  appendFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { launchPersistentBrowser } from "@vexa/remote-browser";
import { getJoinBrowserArgs, joinMeeting, leaveGoogleMeet } from "@vexa/join";
import { startCaptureBridge, startRecording } from "../src/capture-bridge.js";
import { createResourceMonitor } from "../src/resources.js";
// Defaults to a synthetic fixture. An explicitly supplied room tests real Meet
// capture/recording, with local sinks; it is not a deployed end-to-end bot test.
const liveMeetUrl = process.env.VEXA_TEST_MEET_URL;
if (liveMeetUrl)
  assert(
    /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(
      liveMeetUrl,
    ),
    "dedicated Google Meet URL required",
  );
const mode = process.argv[2] ?? process.env.VEXA_TEST_MEMORY_MODE ?? "combined";
assert(
  ["combined", "capture", "recording", "idle"].includes(mode),
  "unknown mode",
);
const seconds = Number(
  process.argv[3] ?? process.env.VEXA_TEST_MEMORY_SECONDS ?? 600,
);
assert(
  Number.isSafeInteger(seconds) && seconds >= 15 && seconds <= 7200,
  "duration must be 15–7200 seconds",
);
const videoCount = Number(
  process.argv[4] ?? process.env.VEXA_TEST_MEMORY_VIDEOS ?? 0,
);
assert(
  Number.isSafeInteger(videoCount) && videoCount >= 0 && videoCount <= 6,
  "video count must be 0–6",
);
const rtc = process.env.VEXA_TEST_MEMORY_RTC === "1";
const output = process.argv[5] ?? process.env.VEXA_TEST_MEMORY_OUTPUT;
assert(output, "output directory required");
mkdirSync(output, { recursive: false, mode: 0o700 });
const log = (r: any) => {
  const line = JSON.stringify(r);
  console.log(line);
  appendFileSync(join(output, "measurements.jsonl"), line + "\n");
};
const server = createServer((_q, r) =>
  r.end(
    '<!doctype html><html><head><title>Vexa local synthetic memory test</title></head><body style="background:#202020;color:#ddd"><p>Local synthetic test — no live meeting</p></body></html>',
  ),
);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const profile = mkdtempSync(join(tmpdir(), "vexa-memory-probe-"));
let context: any;
let stopCapture: any;
let stopRecording: any;
let frames = 0;
const framesByChannel = new Map<number, number>();
let recordedBytes = 0;
let seqs: number[] = [];
let finalSeen = false;
let partsAfterFinal = 0;
const start = Date.now();
const resources = createResourceMonitor();
try {
  const launched = await launchPersistentBrowser({
    dataDir: profile,
    headless:
      process.env.VEXA_TEST_MEMORY_HEADED !== "1" &&
      process.env.VEXA_TEST_MEMORY_FULL_HEADLESS !== "1",
    args: [
      ...getJoinBrowserArgs(),
      "--mute-audio",
      ...(process.env.VEXA_TEST_MEMORY_FULL_HEADLESS === "1"
        ? ["--headless=new"]
        : []),
    ],
  });
  context = launched.context;
  const page = launched.page;
  if (liveMeetUrl) {
    const screenshots = join(output, "screenshots");
    mkdirSync(screenshots, { mode: 0o700 });
    const screenshot = page.screenshot.bind(page);
    page.screenshot = (options: any = {}) =>
      screenshot(
        typeof options.path === "string" &&
          options.path.startsWith("/app/storage/screenshots/")
          ? { ...options, path: join(screenshots, basename(options.path)) }
          : options,
      );
    const navigate = page.goto.bind(page);
    page.goto = async (...args: any[]) => {
      const response = await navigate(...args);
      assert(
        new URL(page.url()).hostname === "meet.google.com",
        "Meet redirected outside its meeting application before admission",
      );
      return response;
    };
    const admission = await joinMeeting(page, {
      meetingUrl: liveMeetUrl,
      platform: "google_meet",
      botName: "TinyCloud RAM test",
      waitingRoomTimeoutMs: 180_000,
      hooks: { onState: (state) => log({ type: "join_state", state }) },
    });
    assert(admission.admitted, `Meet admission failed: ${admission.state}`);
  } else {
    await page.goto(`http://127.0.0.1:${(server.address() as any).port}`);
  }
  await page.evaluate("globalThis.__name = (fn) => fn;");
  await page.addScriptTag({
    path:
      process.env.VEXA_TEST_MEMORY_BROWSER_BUNDLE ??
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../dist/browser-utils.global.js",
      ),
  });
  await page.exposeFunction("logBot", (m: string) =>
    appendFileSync(join(output, "capture.log"), m + "\n"),
  );
  if (!liveMeetUrl)
    await page.evaluate(
      async ({ videos, rtc }: { videos: number; rtc: boolean }) => {
        const w = window as any;
        const ctx = new AudioContext();
        w.fixture = { ctx, oscillators: [], canvases: [], videoTimer: null };
        for (let i = 0; i < 3; i++) {
          const osc = ctx.createOscillator();
          osc.frequency.value = 440 + i * 220;
          const gain = ctx.createGain();
          gain.gain.value = 0.1;
          const dest = ctx.createMediaStreamDestination();
          osc.connect(gain);
          gain.connect(dest);
          osc.start();
          w.fixture.oscillators.push(osc);
          const el = document.createElement("audio");
          el.srcObject = dest.stream;
          document.body.appendChild(el);
          await el.play();
        }
        for (let i = 0; i < videos; i++) {
          const c = document.createElement("canvas");
          c.width = 1280;
          c.height = 720;
          w.fixture.canvases.push(c);
          const v = document.createElement("video");
          v.muted = true;
          v.srcObject = c.captureStream(15);
          v.style.width = "240px";
          document.body.appendChild(v);
          const playing = v.play();
          c.getContext("2d")!.fillRect(0, 0, c.width, c.height);
          await playing;
        }
        if (videos)
          w.fixture.videoTimer = setInterval(() => {
            for (const c of w.fixture.canvases) {
              const ctx = c.getContext("2d");
              ctx.fillStyle = "#202020";
              ctx.fillRect(0, 0, c.width, c.height);
              ctx.fillStyle = "#808080";
              ctx.fillRect(Math.floor(Date.now() / 100) % c.width, 20, 12, 12);
            }
          }, 67);
        await ctx.resume();
        if (rtc) {
          const sources = Array.from(
            document.querySelectorAll("audio,video"),
          ) as HTMLMediaElement[];
          const a = new RTCPeerConnection(),
            b = new RTCPeerConnection();
          w.fixture.peers = [a, b];
          a.onicecandidate = (event) => {
            if (event.candidate) void b.addIceCandidate(event.candidate);
          };
          b.onicecandidate = (event) => {
            if (event.candidate) void a.addIceCandidate(event.candidate);
          };
          b.ontrack = (event) => {
            const el = document.createElement(
              event.track.kind === "audio" ? "audio" : "video",
            );
            el.srcObject = new MediaStream([event.track]);
            if (event.track.kind === "video") el.muted = true;
            document.body.appendChild(el);
            void el.play();
          };
          for (const el of sources) {
            const stream = el.srcObject as MediaStream;
            for (const track of stream.getTracks()) a.addTrack(track, stream);
            el.remove();
          }
          await a.setLocalDescription(await a.createOffer());
          await b.setRemoteDescription(a.localDescription!);
          await b.setLocalDescription(await b.createAnswer());
          await a.setRemoteDescription(b.localDescription!);
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("loopback WebRTC failed to connect")),
              10000,
            );
            b.onconnectionstatechange = () => {
              if (b.connectionState === "connected") {
                clearTimeout(timer);
                resolve();
              }
            };
            if (b.connectionState === "connected") {
              clearTimeout(timer);
              resolve();
            }
          });
        }
      },
      { videos: videoCount, rtc },
    );
  const inv = {
    platform: "google_meet",
    meetingUrl: liveMeetUrl ?? "https://meet.google.com/fixture",
    nativeMeetingId: "fixture",
    botName: liveMeetUrl ? "TinyCloud RAM test" : "Vexa",
    redisUrl: "redis://localhost:6379",
    transcribeEnabled: false,
  };
  // Count captureStream fallbacks without retaining their tracks. In particular,
  // a video-only tile must not acquire new live capture tracks on every rescan.
  await page.evaluate(() => {
    const w = window as any;
    w.probeCaptureStreams = { calls: 0, tracksCreated: 0, tracksStopped: 0 };
    const proto = HTMLMediaElement.prototype as any;
    const original = proto.captureStream;
    if (original)
      proto.captureStream = function (...args: any[]) {
        w.probeCaptureStreams.calls++;
        const stream = original.apply(this, args);
        for (const track of stream.getTracks()) {
          w.probeCaptureStreams.tracksCreated++;
          const stop = track.stop.bind(track);
          track.stop = () => {
            if (track.readyState !== "ended")
              w.probeCaptureStreams.tracksStopped++;
            stop();
          };
        }
        return stream;
      };
  });
  if (mode !== "recording" && mode !== "idle")
    stopCapture = await startCaptureBridge(
      page,
      inv as any,
      {
        async start() {},
        async stop() {},
        feedAudio(channel: number) {
          frames++;
          framesByChannel.set(channel, (framesByChannel.get(channel) ?? 0) + 1);
        },
        feedMixedAudio() {},
        recordHint() {},
      } as any,
    );
  if (mode !== "capture" && mode !== "idle")
    stopRecording = await startRecording(page, inv as any, {
      chunk(
        _k: string,
        seq: number,
        final: boolean,
        _f: string,
        bytes: Uint8Array,
      ) {
        appendFileSync(
          join(output, "parts.jsonl"),
          JSON.stringify({ seq, final, bytes: bytes.length }) + "\n",
        );
        seqs.push(seq);
        if (finalSeen) partsAfterFinal++;
        finalSeen ||= final;
        recordedBytes += bytes.length;
        appendFileSync(join(output, "master.webm"), bytes);
      },
      close() {},
    });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const nativeSampling = process.env.VEXA_TEST_MEMORY_NATIVE === "1";
  if (nativeSampling)
    await cdp.send("Memory.startSampling", { samplingInterval: 65536 });
  const memoryDump = async (elapsed: number) => {
    const file = join(output, `memory-dump-${elapsed}.jsonl`);
    const collect = ({ value }: { value: unknown[] }) => {
      for (const event of value)
        appendFileSync(file, JSON.stringify(event) + "\n");
    };
    cdp.on("Tracing.dataCollected", collect);
    await cdp.send("Tracing.start", {
      traceConfig: {
        includedCategories: ["disabled-by-default-memory-infra"],
        excludedCategories: ["*"],
        traceBufferSizeInKb: 8192,
      },
    });
    try {
      const result = await cdp.send("Tracing.requestMemoryDump", {
        deterministic: false,
        levelOfDetail: "detailed",
      });
      assert(result.success, "native memory dump succeeded");
    } finally {
      let timer: ReturnType<typeof setTimeout>;
      const complete = new Promise<void>((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("native trace did not finish")),
          10000,
        );
        cdp.once("Tracing.tracingComplete", (event: any) => {
          clearTimeout(timer);
          if (event.dataLossOccurred)
            reject(new Error("native trace buffer lost data"));
          else resolve();
        });
      });
      await cdp.send("Tracing.end");
      try {
        await complete;
      } finally {
        cdp.off("Tracing.dataCollected", collect);
      }
    }
  };
  const processes = () => {
    const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,comm="], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .map((l) => {
        const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)!;
        return { pid: +m[1], ppid: +m[2], rss: +m[3] * 1024, command: m[4] };
      });
    const ids = new Set([process.pid]);
    for (let i = 0; i < 8; i++)
      for (const r of rows) if (ids.has(r.ppid)) ids.add(r.pid);
    return rows
      .filter(
        (r) => ids.has(r.pid) && /Chrom|chrom|headless_shell/.test(r.command),
      )
      .map(({ pid, ppid, rss }) => ({ pid, ppid, rss }));
  };
  log({
    type: "start",
    liveMeet: !!liveMeetUrl,
    mode,
    seconds,
    videoCount,
    rtc,
    headed: process.env.VEXA_TEST_MEMORY_HEADED === "1",
    fullHeadless: process.env.VEXA_TEST_MEMORY_FULL_HEADLESS === "1",
    browser: context.browser()?.version(),
    pid: process.pid,
  });
  for (let elapsed = 0; elapsed <= seconds; elapsed += 15) {
    if (elapsed) await new Promise((r) => setTimeout(r, 15000));
    const metrics = (await cdp.send("Performance.getMetrics")).metrics;
    const heap = Object.fromEntries(
      metrics
        .filter((m: any) => /JSHeap|Nodes|Documents|Frames/.test(m.name))
        .map((m: any) => [m.name, m.value]),
    );
    const ps = processes();
    const rss = ps.reduce((a, r) => a + r.rss, 0);
    const footprintBinary = process.env.VEXA_TEST_MEMORY_FOOTPRINT_BINARY;
    const footprints = footprintBinary
      ? execFileSync(
          footprintBinary,
          ps.map((p) => String(p.pid)),
          { encoding: "utf8" },
        )
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : undefined;
    const captureStreams = await page.evaluate(
      () => (window as any).probeCaptureStreams,
    );
    const heapUsage = await cdp.send("Runtime.getHeapUsage");
    if (nativeSampling && elapsed % 60 === 0) {
      writeFileSync(
        join(output, `native-memory-${elapsed}.json`),
        JSON.stringify(await cdp.send("Memory.getSamplingProfile")),
      );
      await memoryDump(elapsed);
    }
    log({
      type: "sample",
      elapsedMs: Date.now() - start,
      frames,
      framesByChannel: Object.fromEntries(framesByChannel),
      recordedBytes,
      parts: seqs.length,
      nodeRss: process.memoryUsage().rss,
      browserRss: rss,
      processes: ps,
      ...(footprints
        ? {
            footprints,
            browserPhysicalFootprint: footprints.reduce(
              (sum, p) => sum + p.physical_footprint,
              0,
            ),
            footprintProcessCount: footprints.length,
          }
        : {}),
      resources: resources.snapshot(),
      captureStreams,
      heapUsage,
      ...heap,
    });
    assert(rss < 2 * 1024 ** 3, "local probe exceeds 2 GiB guard");
  }
  await stopRecording?.();
  stopRecording = null;
  await stopCapture?.();
  stopCapture = null;
  if (mode !== "recording" && mode !== "idle") {
    if (liveMeetUrl) {
      assert(frames > 0, "live Meet delivered captured audio frames");
    } else {
      const minimumFrames = Math.floor(((seconds * 16000) / 4096) * 0.99);
      assert.equal(
        framesByChannel.size,
        3,
        "all three audio channels captured",
      );
      for (const [channel, count] of framesByChannel) {
        assert(
          count >= minimumFrames,
          `channel ${channel}: ${count} frames, expected at least ${minimumFrames} (99% of nominal PCM duration)`,
        );
      }
    }
  }
  if (mode !== "capture" && mode !== "idle") {
    assert(finalSeen, "final recording marker");
    assert.equal(
      partsAfterFinal,
      0,
      "final marker follows every data part and occurs once",
    );
    assert(
      seqs.every((s, i) => s === i),
      "recording sequences contiguous",
    );
  }
  log({
    type: "complete",
    elapsedMs: Date.now() - start,
    frames,
    framesByChannel: Object.fromEntries(framesByChannel),
    recordedBytes,
    parts: seqs.length,
    finalSeen,
  });
  if (liveMeetUrl)
    await leaveGoogleMeet(page, undefined, "controlled_test_complete");
} finally {
  resources.stop();
  await stopRecording?.().catch(() => {});
  await stopCapture?.().catch(() => {});
  await context?.close().catch(() => {});
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(profile, { recursive: true, force: true });
}
