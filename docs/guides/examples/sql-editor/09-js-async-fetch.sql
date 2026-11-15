-- @js
const res = await fetch('https://httpbin.org/get');
const json = await res.json();
return [{
  status: res.status,
  url: json.url ?? '',
  origin: json.origin ?? '',
}];
-- @end
