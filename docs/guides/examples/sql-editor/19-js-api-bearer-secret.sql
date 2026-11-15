-- Add Variables → apiToken (check Secret) and set a session value, or create
-- an App Secret named apiToken (Secrets sidebar). Then Run.

-- @js
const token = vars.apiToken?.value;
if (token === undefined || token === null || String(token).length === 0) {
  return [{
    ok: false,
    hint: 'Set secret variable or App Secret named apiToken, then re-run',
  }];
}

const url = new URL('https://httpbin.org/post');
url.searchParams.set('via', 'secret-var');

const res = await fetch(url.toString(), {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + String(token),
  },
  body: JSON.stringify({ hello: 'foxschema' }),
});
const json = await res.json();
return [{
  status: res.status,
  authEcho: json.headers?.Authorization ?? json.headers?.authorization ?? '',
  bodyHello: json.json?.hello ?? '',
}];
-- @end
