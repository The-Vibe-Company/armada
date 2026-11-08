// Preloaded into the e2e app server only (NODE_OPTIONS=--require): the server-side calls to
// GitHub's token and user endpoints go to the mock instead, so the callback runs end to end.
const mock = `http://127.0.0.1:${process.env.MOCK_PORT}`;
const routes = {
  "https://github.com/login/oauth/access_token": `${mock}/github/login/oauth/access_token`,
  "https://api.github.com/user": `${mock}/github/user`,
};
const original = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const target = routes[url];
  return original(target ?? input, init);
};
