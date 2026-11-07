// onFrame with the phone as the glasses: there is no video stream, so each
// frame is a photo from the phone camera. A fake phone answers the requests.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { FakeDevice, sleep, tempDir, until } from './helpers.ts';
import { config } from '../src/starter/config.ts';
import { Runtime, type DashEvent } from '../src/starter/runtime.ts';
import { startServer } from '../src/starter/server.ts';
import { defineApp, type Photo } from '../src/starter/index.ts';
import { openProfileStore } from '../src/toolkit/profile.ts';

config.framesPerSecond = 3;

const TOKEN = 'TESTCODE';
const frames: Photo[] = [];
let appPhoto: Photo | null = null;

const app = defineApp({
  name: 'Phone frames test',
  async onFrame(frame) {
    frames.push(frame);
  },
  async onSpeech(_text, g) {
    appPhoto = await g.takePhoto();
  },
});

let runtime: Runtime;
let server: ReturnType<typeof startServer>;
let port: number;
let dev: FakeDevice | null = null;
const events: DashEvent[] = [];

const photoEvents = () => events.filter((e) => e.type === 'photo');
const photoRequests = () => dev!.inbox.filter((m) => m.t === 'photo');

async function answerPhoto(req: { id: number; requestId: string; uploadPath: string }): Promise<void> {
  const form = new FormData();
  form.append('requestId', req.requestId);
  form.append('photo', new Blob([new Uint8Array(1234).fill(7)], { type: 'image/jpeg' }), 'photo.jpg');
  const res = await fetch(`http://localhost:${port}${req.uploadPath}`, { method: 'POST', body: form, headers: { Authorization: `Bearer ${TOKEN}` } });
  expect(res.status).toBe(200);
  dev!.send({ t: 'reply', id: req.id, ok: true });
}

async function connectPhone(): Promise<void> {
  dev = await FakeDevice.connect(port, { token: TOKEN, device: 'simulator', name: 'Phone simulator', camera: 'phone' });
  await dev.next('welcome');
}

beforeAll(async () => {
  const store = await openProfileStore(tempDir());
  runtime = new Runtime(app, store, 'test');
  server = startServer({ runtime, store, port: 0, token: TOKEN });
  port = server.port!;
  runtime.subscribe((e) => events.push(e));
});

afterEach(async () => {
  runtime.stop();
  dev?.close();
  dev = null;
  frames.length = 0;
  appPhoto = null;
  events.length = 0;
  await sleep(50);
});

afterAll(() => {
  runtime.shutdown();
  server.stop(true);
});

describe('onFrame with the phone as the glasses', () => {
  test('frames are phone photos, kept off the dashboard conversation', async () => {
    await connectPhone();
    dev!.send({ t: 'active', on: true });
    await answerPhoto(await dev!.next('photo'));
    await answerPhoto(await dev!.next('photo'));
    await until(() => frames.length >= 2, 'two frames for onFrame');
    expect(frames[0]!.from).toBe('phone');
    expect(frames[0]!.jpeg.length).toBe(1234);
    expect(photoEvents()).toHaveLength(0);
  });

  test('asks for one picture at a time', async () => {
    await connectPhone();
    dev!.send({ t: 'active', on: true });
    await dev!.next('photo');
    await sleep(1000); // about three ticks, with the first picture unanswered
    expect(photoRequests()).toHaveLength(1);
  });

  test("the app's own photo waits for the frame, and is shown on the dashboard", async () => {
    await connectPhone();
    dev!.send({ t: 'active', on: true });
    const frameRequest = await dev!.next('photo');
    runtime.type('look at this');
    await sleep(100);
    expect(photoRequests()).toHaveLength(1);

    await answerPhoto(frameRequest);
    const own = await dev!.next('photo');
    await answerPhoto(own);
    await until(() => appPhoto != null, "the app's photo");
    await until(() => photoEvents().length === 1, 'one photo on the dashboard');
  });

  test('Stop ends the pictures', async () => {
    await connectPhone();
    dev!.send({ t: 'active', on: true });
    await answerPhoto(await dev!.next('photo'));
    await until(() => frames.length >= 1, 'a frame');
    runtime.stop();
    await sleep(100);
    const before = photoRequests().length;
    await sleep(800);
    expect(photoRequests()).toHaveLength(before);
  });

  test('glasses without a stream get no photo requests', async () => {
    const video = config.video;
    config.video = 'off';
    try {
      dev = await FakeDevice.connect(port, { token: TOKEN, glasses: { connected: true, wifi: true, battery: 80 } });
      await dev.next('welcome');
      dev.send({ t: 'active', on: true });
      await sleep(800);
      expect(photoRequests()).toHaveLength(0);
      expect(frames).toHaveLength(0);
    } finally {
      config.video = video;
    }
  });
});
