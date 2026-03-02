// Supabase Edge Function: send-push
// Отправляет push-уведомления сотрудникам у кого смена завтра или сегодня утром
// Запускается через pg_cron: вечером в 20:00 и утром в 08:00 (МСК = UTC+3)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const VAPID_PUBLIC  = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = 'mailto:admin@blackfox.ru';

const MOTIVATIONAL = [
  'Удачной смены! 💪',
  'Ты справишься, всё будет отлично! 🔥',
  'Команда ждёт тебя! 🦊',
  'Заряжайся энергией, смена будет классной! ⚡',
  'Black Fox — сила в команде! 🖤',
];

// ── VAPID JWT helper ─────────────────────────────────────────
async function makeVapidJWT(audience: string): Promise<string> {
  const header  = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: VAPID_SUBJECT,
  };

  const b64url = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const b64urlBuf = (buf: ArrayBuffer) =>
    btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');

  const unsigned = `${b64url(header)}.${b64url(payload)}`;

  // Import private key
  const privBytes = Uint8Array.from(atob(VAPID_PRIVATE.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
  const privKey = await crypto.subtle.importKey(
    'raw', privBytes,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  );

  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privKey,
    new TextEncoder().encode(unsigned)
  );

  return `${unsigned}.${b64urlBuf(sig)}`;
}

// ── Send one push ────────────────────────────────────────────
async function sendPush(subscription: {endpoint: string; keys: {p256dh: string; auth: string}}, payload: string) {
  const url      = new URL(subscription.endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const jwt      = await makeVapidJWT(audience);

  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/octet-stream',
      'TTL':           '86400',
      'Authorization': `vapid t=${jwt},k=${VAPID_PUBLIC}`,
      'Content-Encoding': 'aes128gcm',
    },
    body: new TextEncoder().encode(payload),
  });

  return res.status;
}

// ── Main handler ─────────────────────────────────────────────
Deno.serve(async (req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  const body   = await req.json().catch(() => ({}));
  const mode   = body.mode || 'evening'; // 'evening' | 'morning'
  const moscowOffset = 3 * 60 * 60 * 1000; // UTC+3
  const now    = new Date(Date.now() + moscowOffset);

  // Determine target date
  const targetDate = new Date(now);
  if (mode === 'evening') targetDate.setDate(targetDate.getDate() + 1); // завтра
  const yyyy = targetDate.getFullYear();
  const mm   = String(targetDate.getMonth() + 1).padStart(2, '0');
  const mk   = `${yyyy}-${mm}`; // e.g. "2026-03"
  const day  = targetDate.getDate();

  // Load schedule from DB
  const { data: scheduleRows } = await supabase
    .from('blackfox_data')
    .select('data')
    .eq('key', 'schedule')
    .single();

  const schedule = scheduleRows?.data || {};
  const monthData = schedule[mk] || {};

  // Load push subscriptions
  const { data: subRows } = await supabase
    .from('push_subscriptions')
    .select('*');

  // Load users to match names → subscriptions
  const { data: usersRow } = await supabase
    .from('blackfox_data')
    .select('data')
    .eq('key', 'users')
    .single();

  const users: Array<{name: string; login: string}> = usersRow?.data || [];

  let sent = 0, errors = 0;

  for (const sub of (subRows || [])) {
    const user = users.find(u => u.login === sub.login);
    if (!user) continue;

    const empDays = monthData[user.name] || {};
    const shift   = empDays[day];
    if (!shift?.start) continue; // нет смены в этот день

    const dateStr  = mode === 'evening'
      ? `завтра ${day} ${['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'][targetDate.getMonth()]}`
      : 'сегодня';
    const timeStr  = `${shift.start}–${shift.end || '?'}`;
    const motiv    = MOTIVATIONAL[Math.floor(Math.random() * MOTIVATIONAL.length)];
    const dept     = shift.dept ? ` · ${({hall:'Зал',bar:'Бар',kitchen:'Кухня'} as Record<string,string>)[shift.dept] || ''}` : '';

    const payload = JSON.stringify({
      title: mode === 'evening' ? '🗓 Напоминание о смене' : '☀️ Доброе утро!',
      body:  `${user.name}${dept}, ${dateStr} смена ${timeStr}. ${motiv}`,
      icon:  '/blackfox/icon-192.png',
      badge: '/blackfox/icon-72.png',
      url:   '/blackfox/',
      tag:   `shift-${mk}-${day}`,
    });

    try {
      const status = await sendPush(sub.subscription, payload);
      if (status >= 200 && status < 300) sent++;
      else if (status === 410 || status === 404) {
        // Subscription expired — remove it
        await supabase.from('push_subscriptions').delete().eq('id', sub.id);
      } else errors++;
    } catch { errors++; }
  }

  return new Response(JSON.stringify({ sent, errors, mode, date: `${yyyy}-${mm}-${day}` }), {
    headers: { 'Content-Type': 'application/json' }
  });
});
