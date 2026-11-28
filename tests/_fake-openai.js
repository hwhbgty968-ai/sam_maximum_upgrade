// Fake OpenAI SDK client for tests: no network. Behaviour per provider comes from global.FAKE[baseURL]:
//   models: [...]            model list            listError / listStatus   make models.list() fail
//   reply: body => text      the answer            delay                    ms between streamed chunks
//   fail / status            every call fails      failModels: {model: {status, message}}  only those models fail
//   failMidStream            fails after 2 chunks     hangModels: {model: true}  never answers (until aborted)
class FakeOpenAI {
  constructor(opts) {
    this.opts = opts;
    const cfg = () => (global.FAKE?.[opts.baseURL || "openai"] || {});
    const err = (message, status) => Object.assign(new Error(message), { status });
    this.models = { list: async () => { const c = cfg(); if (c.listError) throw err(c.listError, c.listStatus); return (async function* () { for (const id of c.models || []) yield { id }; })(); } };
    this.chat = { completions: { create: async (body, reqOpts = {}) => {
      const c = cfg(); (global.CALLS ||= []).push({ base: opts.baseURL || "openai", body });
      if (c.hangModels?.[body.model]) await new Promise((_, rej) => { const sig = reqOpts.signal; const stop = () => { const e = new Error("Request was aborted."); e.name = "APIUserAbortError"; rej(e); }; if (sig?.aborted) stop(); sig?.addEventListener("abort", stop, { once: true }); });
      const fm = c.failModels?.[body.model];
      if (fm) throw err(fm.message || "failed", fm.status);
      if (c.fail) throw err(c.fail, c.status || 500);
      const text = c.reply ? c.reply(body) : "hello from " + body.model;
      if (!body.stream) return { choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
      return (async function* () {
        const parts = text.match(/.{1,4}/g) || [];
        for (let i = 0; i < parts.length; i++) {
          if (reqOpts.signal?.aborted) { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
          if (c.failMidStream && i === 2) throw new Error("mid-stream failure");
          await new Promise(r => setTimeout(r, c.delay || 0));
          yield { choices: [{ delta: { content: parts[i] } }] };
        }
      })();
    } } };
  }
}
module.exports = FakeOpenAI; module.exports.default = FakeOpenAI;
