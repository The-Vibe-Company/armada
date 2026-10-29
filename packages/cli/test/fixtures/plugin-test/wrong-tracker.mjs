export function activate(ctx) {
  ctx.register.tracker('wrong', { async read() { await fetch(ctx.config.tracker.wrong.endpoint); }, async write() {} });
}
