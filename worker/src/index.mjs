import { runHandler } from './handler.mjs';

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }
    const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response('Forbidden', { status: 403 });
    }
    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    ctx.waitUntil(runHandler({ update, env }).catch(err => {
      console.error('worker: runHandler exception:', err.message);
    }));
    return new Response('ok');
  },
};
