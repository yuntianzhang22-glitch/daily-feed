// A stable, branded browser origin. The existing relay remains the source of
// assets, account validation and billing, so subsequent app releases stay current.
import appConfig from '../desktop/app-config.json' with { type: 'json' };

const ASSETS = new Set(['/mobile/', '/mobile/index.html', '/mobile/app.js', '/mobile/style.css',
  '/mobile/sw.js', '/mobile/manifest.webmanifest', '/mobile/icons/icon-192.png', '/mobile/icons/icon-512.png']);
const API_METHODS = { '/v1/feedback': ['POST'], '/v1/feedback/read': ['POST'], '/v1/translate': ['POST'], '/v1/status': ['GET'], '/v1/roster': ['GET'], '/v1/search': ['POST'],
  '/v1/mobile/schedule': ['GET', 'POST'], '/v1/mobile/feed': ['GET'] };
const error = (status, code, message) => new Response(JSON.stringify({ code, message }), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

export async function serveEntry(request, fetchImpl = (upstream) => fetch(upstream)) {
  const url = new URL(request.url);
  const read = ['GET', 'HEAD'].includes(request.method);
  if (read && ['/', '/mobile'].includes(url.pathname)) return Response.redirect(`${url.origin}/mobile/`, 302);
  if (!(read && ASSETS.has(url.pathname)) && !API_METHODS[url.pathname]?.includes(request.method)) {
    return error(404, 'not_found', 'not found');
  }
  const upstreamUrl = new URL(url.pathname + url.search, appConfig.relayUrl);
  // Forward only the headers the app needs. No cookies, admin routes or client
  // selected upstream can cross this boundary.
  const headers = new Headers();
  for (const key of ['Authorization', 'Content-Type', 'Accept', 'If-None-Match']) {
    if (request.headers.has(key)) headers.set(key, request.headers.get(key));
  }
  const forwarded = new Request(upstreamUrl, request);
  for (const key of [...forwarded.headers.keys()]) forwarded.headers.delete(key);
  for (const [key, value] of headers) forwarded.headers.set(key, value);
  try {
    const upstream = await fetchImpl(new Request(forwarded, { redirect: 'manual' }));
    const response = new Response(upstream.body, upstream);
    const location = response.headers.get('Location');
    if (location) {
      const target = new URL(location, upstreamUrl);
      if (target.origin !== upstreamUrl.origin || !ASSETS.has(target.pathname)) {
        return error(502, 'unavailable', '服务暂时不可用，请稍后重试');
      }
      response.headers.set('Location', `${url.origin}${target.pathname}${target.search}`);
    }
    return response;
  } catch {
    return error(503, 'unavailable', '服务暂时不可用，请稍后重试');
  }
}

export default { fetch: (request) => serveEntry(request) };
