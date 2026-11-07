// The HTTP + WebSocket server (Bun's built-in server, no framework).
//
// For devices (the phone app), from anywhere, with the token:
//   /device          WebSocket, see protocol.ts
//   /upload/photo    where the glasses (or the phone) send a photo
//   /audio/<id>      a spoken line for the device to play
//   /sounds/<name>   small sounds the phone plays on its own ("working on it")
//
// For you, from this laptop (the dashboard shows camera photos):
//   /                the dashboard
//   /api/...         what the dashboard reads and does

import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { Server, ServerWebSocket } from 'bun';
import { config } from './config.ts';
import { pairingLink, phoneAddress, qrSvg } from './network.ts';
import type { DeviceLink, Runtime } from './runtime.ts';
import { CLOSE_BAD_TOKEN, DEVICE_WS_PATH, PHOTO_UPLOAD_PATH, type DownMessage, type UpMessage } from './protocol.ts';
import type { ProfileStore } from '../toolkit/profile.ts';
import { audioSettings, describeSettings } from '../toolkit/settings.ts';
import { checkNeedValue, EXAMPLE_PROFILES, NEEDS, SUPPORT_AREAS } from '../toolkit/needs.ts';
import { activePerson, addPerson, hasPeopleFile, loadPeople, savePerson, selectPerson, syncActiveNeeds, type Person } from '../toolkit/people.ts';

const WEB_DIR = join(import.meta.dir, 'web');

interface WsData {
  link: DeviceLink | null;
}

function sameToken(given: unknown, expected: string): boolean {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// iOS's player asks for the first two bytes of a file before it plays it,
// and refuses a reply that ignores the range. So audio is served with ranges.
function bytesResponse(req: Request, bytes: Uint8Array, mime: string, cache = 'no-store'): Response {
  const total = bytes.byteLength;
  const headers: Record<string, string> = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': cache };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '');
  if (!m || (m[1] === '' && m[2] === '')) return new Response(bytes, { headers: { ...headers, 'Content-Length': String(total) } });
  const start = m[1] === '' ? Math.max(0, total - Number(m[2])) : Number(m[1]);
  const end = m[1] === '' || m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
  if (start > end || start >= total) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
  return new Response(bytes.subarray(start, end + 1), {
    status: 206,
    headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': String(end - start + 1) },
  });
}

const json = (data: unknown, status = 200) => Response.json(data, { status });

export function startServer(opts: { runtime: Runtime; store: ProfileStore; port: number; token: string }): Server<WsData> {
  const { runtime, store, port, token } = opts;

  // The active person's needs are the profile. A change to the profile stays
  // with them, except while a person or a trial example is being loaded.
  let loading = false;
  store.onChange((p) => {
    if (!loading && hasPeopleFile()) syncActiveNeeds(p);
  });
  const loadInto = async (profile: { supportAreas: string[]; needs: Person['needs'] }, source: string): Promise<void> => {
    loading = true;
    try {
      await store.replace(profile, source);
    } finally {
      loading = false;
    }
  };
  if (hasPeopleFile()) void loadInto(activePerson(), 'person');

  const isLocal = (req: Request, server: Server<WsData>): boolean => {
    if (config.dashboardFromAnywhere) return true;
    // A tunnel delivers requests from this laptop too, and marks them with these.
    if (req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip')) return false;
    // A web page on another site that points its own domain at 127.0.0.1
    // (DNS rebinding) arrives with that domain as its Host.
    const host = (req.headers.get('host') ?? '').replace(/:\d+$/, '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return false;
    const ip = server.requestIP(req)?.address ?? '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  };

  const profileView = async () => {
    const stored = await store.read();
    return {
      adapt: runtime.adapting,
      supportAreas: stored.supportAreas,
      areas: SUPPORT_AREAS,
      needs: NEEDS.map((spec) => {
        const n = stored.needs.filter((x) => x.dimension === spec.key).at(-1);
        return { ...spec, set: !!n, value: n ? n.value : spec.default, source: n?.source ?? null };
      }),
      // Needs in the store that this editor has no control for. Shown, removable.
      other: stored.needs.filter((n) => !NEEDS.some((s) => s.key === n.dimension)),
      examples: EXAMPLE_PROFILES.map(({ key, label }) => ({ key, label })),
      effect: describeSettings(audioSettings(stored)),
    };
  };

  const api = async (req: Request, url: URL): Promise<Response> => {
    const path = url.pathname;
    if (path === '/api/connect') {
      const addr = phoneAddress(port);
      const link = addr.url ? pairingLink(addr.url, token) : null;
      const app = async (url: string) => (url ? { url, qr: await qrSvg(url) } : null);
      const apps = { android: await app(config.androidAppUrl), ios: await app(config.iosAppUrl) };
      return json({ ...addr, token, link, qr: link ? await qrSvg(link) : null, port, apps });
    }
    if (path.startsWith('/api/photo/')) {
      const photo = runtime.photo(path.slice('/api/photo/'.length).replace(/\.jpg$/, ''));
      return photo ? new Response(photo.jpeg, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' } }) : new Response('Not found', { status: 404 });
    }
    // The live camera's newest frame, for the dashboard's small live view.
    if (path === '/api/frame.jpg') {
      const jpeg = runtime.latestFrame();
      return jpeg ? new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' } }) : new Response('No frame', { status: 404 });
    }
    if (path === '/api/profile' && req.method === 'GET') return json(await profileView());
    if (path === '/api/people' && req.method === 'GET') return json(loadPeople());
    if (req.method !== 'POST') return new Response('Not found', { status: 404 });
    // The dashboard's own script sends JSON here. Another web page open in
    // this browser would need a CORS permission, and this server does not give it.
    if (!(req.headers.get('content-type') ?? '').includes('application/json')) return json({ ok: false, error: 'expected JSON' }, 415);
    const body = (await req.json().catch(() => ({}))) as Record<string, any>;
    switch (path) {
      case '/api/control':
        if (body.action === 'start') runtime.start();
        else if (body.action === 'stop') runtime.stop();
        else if (body.action === 'type') runtime.type(String(body.text ?? ''));
        else if (body.action === 'button') runtime.button(body.press === 'long' ? 'long' : 'short');
        else if (body.action === 'adapt') runtime.setAdapt(!!body.on);
        else return json({ ok: false, error: 'unknown action' }, 400);
        return json({ ok: true });
      case '/api/profile/need': {
        if (body.value == null) await store.setNeed(String(body.key), null);
        else {
          const check = checkNeedValue(String(body.key), body.value);
          if (!check.ok) return json({ ok: false, error: check.reason }, 400);
          await store.setNeed(String(body.key), check.value);
        }
        return json(await profileView());
      }
      case '/api/profile/areas':
        await store.setSupportAreas(Array.isArray(body.areas) ? body.areas.filter((a: unknown) => SUPPORT_AREAS.some((s) => s.key === a)) : []);
        return json(await profileView());
      case '/api/profile/example': {
        const ex = EXAMPLE_PROFILES.find((e) => e.key === body.key);
        if (!ex) return json({ ok: false, error: 'unknown example' }, 400);
        await loadInto({ supportAreas: ex.supportAreas, needs: ex.needs }, 'example-profile');
        return json(await profileView());
      }
      case '/api/people/select': {
        const person = selectPerson(String(body.id));
        if (!person) return json({ ok: false, error: 'unknown person' }, 400);
        await loadInto(person, 'person');
        return json(loadPeople());
      }
      case '/api/people/save':
        if (!savePerson(String(body.id), body)) return json({ ok: false, error: 'unknown person' }, 400);
        return json({ ok: true });
      case '/api/people/add': {
        const person = addPerson(String(body.name ?? ''));
        if (!person) return json({ ok: false, error: 'a name is needed' }, 400);
        await loadInto(person, 'person');
        return json(loadPeople());
      }
    }
    return new Response('Not found', { status: 404 });
  };

  const events = (req: Request, server: Server<WsData>): Response => {
    server.timeout(req, 0); // an event stream stays open
    const enc = new TextEncoder();
    let unsubscribe = () => {};
    let ping: ReturnType<typeof setInterval> | null = null;
    const stream = new ReadableStream({
      start(controller) {
        unsubscribe = runtime.subscribe((e) => controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)));
        ping = setInterval(() => controller.enqueue(enc.encode(': ping\n\n')), 10_000);
      },
      cancel() {
        unsubscribe();
        if (ping) clearInterval(ping);
      },
    });
    req.signal.addEventListener('abort', () => {
      unsubscribe();
      if (ping) clearInterval(ping);
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
  };

  const uploadPhoto = async (req: Request): Promise<Response> => {
    // The token is optional here: the requestId was made for this one photo
    // and works once. A wrong token is still refused.
    const auth = req.headers.get('authorization');
    if (auth && !sameToken(auth.replace(/^Bearer\s+/i, ''), token)) return json({ ok: false, error: 'bad token' }, 401);
    const form = await req.formData().catch(() => null);
    if (!form) return json({ ok: false, error: 'expected multipart form data' }, 400);
    const requestId = String(form.get('requestId') ?? '');
    const file = form.get('photo');
    if (!requestId || !file || typeof file === 'string') return json({ ok: false, error: 'needs a photo file and a requestId' }, 400);
    const jpeg = Buffer.from(await (file as Blob).arrayBuffer());
    if (!runtime.photoArrived(requestId, jpeg)) return json({ ok: false, error: 'no photo was asked for with that requestId' }, 404);
    return json({ ok: true, requestId, fileSizeBytes: jpeg.length });
  };

  const server = Bun.serve<WsData>({
    port,
    // Generous, for photos sent over a slow link.
    idleTimeout: 120,
    maxRequestBodySize: 25 * 1024 * 1024,

    async fetch(req, server) {
      // A request without a Host header arrives as a bare path. isLocal()
      // reads the headers, so the placeholder base here opens nothing.
      const url = new URL(req.url, 'http://unknown.invalid');
      const path = url.pathname;
      try {
        if (path === DEVICE_WS_PATH) {
          return server.upgrade(req, { data: { link: null } }) ? undefined : new Response('Expected a WebSocket', { status: 400 });
        }
        if (path === '/health') return json({ ok: true, app: runtime.app.name });
        if (path === PHOTO_UPLOAD_PATH && req.method === 'POST') return await uploadPhoto(req);
        if (path.startsWith('/audio/')) {
          const clip = runtime.clip(path.slice('/audio/'.length).replace(/\.(aac|wav)$/, ''));
          return clip ? bytesResponse(req, clip.audio, clip.mime) : new Response('Gone', { status: 404 });
        }
        if (path.startsWith('/sounds/')) {
          const name = path.slice('/sounds/'.length);
          if (!/^[a-z-]{1,32}\.wav$/.test(name)) return new Response('Not found', { status: 404 });
          const file = Bun.file(join(WEB_DIR, 'sounds', name));
          if (!(await file.exists())) return new Response('Not found', { status: 404 });
          return bytesResponse(req, new Uint8Array(await file.arrayBuffer()), 'audio/wav', 'public, max-age=300');
        }

        // The routes below are the dashboard, for this laptop.
        if (!isLocal(req, server)) {
          return new Response('The dashboard opens on the laptop running the server. Set DASHBOARD_FROM_ANYWHERE=true in .env to open it from other devices.', { status: 403 });
        }
        if (path === '/' || path === '/index.html') return new Response(Bun.file(join(WEB_DIR, 'dashboard.html')), { headers: { 'Cache-Control': 'no-store' } });
        if (path === '/api/events') return events(req, server);
        if (path.startsWith('/api/')) return await api(req, url);
        if (path.startsWith('/web/')) {
          const name = path.slice('/web/'.length);
          if (!/^[\w.-]+$/.test(name)) return new Response('Not found', { status: 404 });
          const file = Bun.file(join(WEB_DIR, name));
          return (await file.exists()) ? new Response(file, { headers: { 'Cache-Control': 'no-store' } }) : new Response('Not found', { status: 404 });
        }
        return new Response('Not found', { status: 404 });
      } catch (e) {
        console.error(`[server] ${req.method} ${path} failed:`, e);
        return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
      }
    },

    websocket: {
      maxPayloadLength: 1 << 20,
      idleTimeout: 60, // the devices ping at 20 s intervals
      open(ws: ServerWebSocket<WsData>) {
        // A device has 10 s to say hello with the right token.
        setTimeout(() => {
          if (!ws.data.link && ws.readyState === 1) ws.close(CLOSE_BAD_TOKEN, 'no hello');
        }, 10_000);
      },
      message(ws: ServerWebSocket<WsData>, raw) {
        const link = ws.data.link;
        if (typeof raw !== 'string') {
          if (link) runtime.onAudio(link, Buffer.from(raw));
          return;
        }
        let m: UpMessage;
        try {
          m = JSON.parse(raw) as UpMessage;
        } catch {
          return;
        }
        if (!m || typeof m !== 'object') return;
        if (link) {
          try {
            runtime.onMessage(link, m);
          } catch (e) {
            console.warn('[device] a message could not be handled:', e instanceof Error ? e.message : e);
          }
          return;
        }
        if (m.t !== 'hello') return;
        if (!sameToken(m.token, token)) {
          ws.send(JSON.stringify({ t: 'refused', reason: 'wrong pairing code' } satisfies DownMessage));
          console.warn('[device] refused a connection: wrong pairing code');
          return ws.close(CLOSE_BAD_TOKEN, 'wrong pairing code');
        }
        const created: DeviceLink = {
          kind: m.device === 'glasses' ? 'glasses' : 'simulator',
          name: String(m.name || 'device').slice(0, 60),
          camera: m.device === 'glasses' ? 'glasses' : m.camera === 'phone' ? 'phone' : 'webcam',
          glasses:
            m.device !== 'glasses' ? null
            : m.glasses ? { connected: !!m.glasses.connected, wifi: m.glasses.wifi ?? null, battery: m.glasses.battery ?? null }
            : { connected: false, wifi: null, battery: null },
          send: (msg) => {
            if (ws.readyState === 1) ws.send(JSON.stringify(msg));
          },
          close: (code, reason) => ws.close(code, reason),
        };
        ws.data.link = created;
        runtime.attach(created, !!m.resume);
      },
      close(ws: ServerWebSocket<WsData>) {
        if (ws.data.link) runtime.detach(ws.data.link);
      },
    },
  });
  return server;
}
