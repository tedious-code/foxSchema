-- @ts
type HttpBinGet = { url?: string; origin?: string };

const res = await fetch('https://httpbin.org/get');
const json = (await res.json()) as HttpBinGet;
return [{
  status: res.status,
  url: json.url ?? '',
  origin: json.origin ?? '',
  runtime: 'browser-ts',
}];
-- @end
