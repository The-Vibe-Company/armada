// Preloaded into the e2e app server only (NODE_OPTIONS=--require): the server-side calls to
// GitHub's token and user endpoints go to the mock instead, so the callback runs end to end.
const mock = `http://127.0.0.1:${process.env.MOCK_PORT}`;
const installations = "https://api.github.com/user/installations";
const original = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let target = null;
  if (url === "https://github.com/login/oauth/access_token") target = `${mock}/github/login/oauth/access_token`;
  else if (url === "https://api.github.com/user") target = `${mock}/github/user`;
  else if (url === installations || url.startsWith(`${installations}?`)) {
    target = `${mock}/github/user/installations${url.slice(installations.length)}`;
  }
  return original(target ?? input, init);
};
