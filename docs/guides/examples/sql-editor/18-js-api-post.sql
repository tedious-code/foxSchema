-- @js
// Query string, custom headers, and JSON body (httpbin echoes them back).
const url = new URL('https://httpbin.org/post');
url.searchParams.set('source', 'foxschema');
url.searchParams.set('demo', '1');

const res = await fetch(url.toString(), {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-FoxSchema-Client': 'sql-editor',
    Authorization: 'Bearer demo-token',
  },
  body: JSON.stringify({
    action: 'ping',
    items: [1, 2, 3],
  }),
});
const json = await res.json();
return [{
  status: res.status,
  querySource: json.args?.source ?? '',
  queryDemo: json.args?.demo ?? '',
  authHeader: json.headers?.Authorization ?? json.headers?.authorization ?? '',
  bodyAction: json.json?.action ?? '',
  bodyItemCount: Array.isArray(json.json?.items) ? json.json.items.length : 0,
}];
-- @end
