-- @js
const urls = [
  'https://httpbin.org/uuid',
  'https://httpbin.org/uuid',
];
const results = await Promise.all(
  urls.map(async (url) => {
    const res = await fetch(url);
    const json = await res.json();
    return { status: res.status, uuid: json.uuid ?? '' };
  })
);
return results;
-- @end
