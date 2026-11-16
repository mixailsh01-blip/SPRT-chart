import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';

async function jsonRequest(url, { body, headers, ...options } = {}) {
  const response = await fetch(url, {
    ...options,
    body,
    headers: { Accept: 'application/json', ...headers },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 204) return {};
  const data = await response.json().catch(() => null);
  if (!response.ok || data === null) {
    throw Object.assign(new Error('Ошибка внешнего API (HTTP ' + response.status + ')'), {
      status: response.status >= 400 ? response.status : 502,
      response: { data },
    });
  }
  return data;
}

export function createPyrus(env) {
  let token;
  let expires = 0;
  let inFlight;
  async function authenticate() {
    if (token && Date.now() < expires) return token;
    if (!inFlight) {
      inFlight = jsonRequest('https://accounts.pyrus.com/api/v4/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: env.PYRUS_LOGIN, security_key: env.PYRUS_SECURITY_KEY }),
      }).then(data => {
        if (!data.access_token) throw new Error('Pyrus не выдал токен');
        token = data.access_token;
        expires = Date.now() + 25 * 60_000;
        return token;
      }).finally(() => { inFlight = undefined; });
    }
    return inFlight;
  }

  return async function pyrus(method, path, body) {
    const request = () => jsonRequest('https://api.pyrus.com' + path, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    await authenticate();
    try {
      return await request();
    } catch (error) {
      if (error.status !== 401) throw error;
      expires = 0;
      await authenticate();
      return request();
    }
  };
}

export function createMango(env) {
  return async function mango(path, payload) {
    const json = JSON.stringify(payload);
    const signature = createHash('sha256')
      .update(env.MANGO_API_KEY + json + env.MANGO_API_SALT)
      .digest('hex');
    const body = new FormData();
    body.set('vpbx_api_key', env.MANGO_API_KEY);
    body.set('sign', signature);
    body.set('json', json);
    const data = await jsonRequest('https://app.mango-office.ru/vpbx/' + path, { method: 'POST', body });
    if (data.result != null && Number(data.result) !== 1000) {
      throw new Error('Mango отклонил запрос (код ' + Number(data.result) + ')');
    }
    return data;
  };
}

export function createMailer(env) {
  const secure = env.SMTP_SECURE === 'true';
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || (secure ? 465 : 587)),
    secure,
    requireTLS: !secure,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return message => transport.sendMail({ from: env.SMTP_FROM, ...message });
}
