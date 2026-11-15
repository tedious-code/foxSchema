-- @node
const url = new URL('https://httpbin.org/post');
url.searchParams.set('source', 'foxschema-node');

const res = await fetch(url.toString(), {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-FoxSchema-Runtime': 'node',
    Authorization: 'Bearer demo-token',
  },
  body: JSON.stringify({ action: 'ping', runtime: 'node' }),
});
const json = await res.json();
return [{
  status: res.status,
  querySource: json.args?.source ?? '',
  authHeader: json.headers?.Authorization ?? json.headers?.authorization ?? '',
  bodyAction: json.json?.action ?? '',
  runtime: 'node',
}];
-- @end
