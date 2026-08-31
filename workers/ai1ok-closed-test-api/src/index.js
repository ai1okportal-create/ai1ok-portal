const allowedTypes = new Set([
  'Людина / користувач',
  'Автор / творець',
  'Фахівець',
  'Майстер',
  'Вчитель / тренер',
  'Проєкт / справа',
  'Спілкування',
]);

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  },
});

const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const now = () => new Date().toISOString();

async function ownerKey(email) {
  const bytes = new TextEncoder().encode(email.trim().toLowerCase());
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function identity(request) {
  const url = new URL(request.url);
  if (url.hostname !== 'access.ai1ok.com.ua') return null;
  const email = request.headers.get('Cf-Access-Authenticated-User-Email');
  if (!email || email.length > 254) return null;
  return { email, ownerKey: await ownerKey(email) };
}

function isAdmin(user, env) {
  return Boolean(env.ADMIN_EMAIL) && user.email.trim().toLowerCase() === env.ADMIN_EMAIL.trim().toLowerCase();
}

async function readBody(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 3000) throw new Error('Занадто великий запит.');
  const body = await request.json();
  return body && typeof body === 'object' ? body : {};
}

function cabinetView(row, includeOwner = false) {
  const result = {
    id: row.id,
    number: row.public_number,
    name: row.public_name,
    type: row.cabinet_type,
    directions: row.directions,
    about: row.about,
    availability: row.availability,
    visibility: row.visibility,
    reviewStatus: row.review_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (includeOwner) result.ownerKey = row.owner_key;
  return result;
}

async function nextPublicNumber(db) {
  const row = await db.prepare('SELECT COALESCE(MAX(public_number), 0) + 1 AS next_number FROM cabinets').first();
  return Number(row.next_number);
}

async function ownsCabinet(db, cabinetId, user) {
  return db.prepare('SELECT * FROM cabinets WHERE id = ? AND owner_key = ?').bind(cabinetId, user.ownerKey).first();
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

    const user = await identity(request);
    if (!user) return json({ error: 'Потрібен підтверджений доступ до закритого тесту.' }, 403);

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === 'GET' && path === '/api/health') {
        return json({ ok: true, module: 'AI1OK closed test' });
      }

      if (request.method === 'GET' && path === '/api/cabinets') {
        const { results } = await env.DB.prepare(`
          SELECT * FROM cabinets
          WHERE (review_status = 'approved' AND visibility = 'visible') OR owner_key = ?
          ORDER BY public_number ASC
          LIMIT 100
        `).bind(user.ownerKey).all();
        return json({ cabinets: results.map((row) => cabinetView(row)) });
      }

      if (request.method === 'POST' && path === '/api/cabinets') {
        const body = await readBody(request);
        const name = clean(body.name, 80);
        const type = clean(body.type, 80);
        const directions = clean(body.directions, 350);
        const about = clean(body.about, 600);
        const availability = ['ready', 'busy', 'offline', 'hidden'].includes(body.availability) ? body.availability : 'offline';
        if (!body.testConsent) return json({ error: 'Потрібна згода на збереження тестового кабінету.' }, 400);
        if (name.length < 2 || !allowedTypes.has(type)) return json({ error: 'Перевірте публічне ім’я та тип кабінету.' }, 400);

        const count = await env.DB.prepare('SELECT COUNT(*) AS total FROM cabinets WHERE owner_key = ?').bind(user.ownerKey).first();
        if (Number(count.total) >= 10) return json({ error: 'У закритому тесті можна створити до 10 кабінетів.' }, 400);

        const id = crypto.randomUUID();
        const timestamp = now();
        const publicNumber = await nextPublicNumber(env.DB);
        await env.DB.prepare(`
          INSERT INTO cabinets (id, owner_key, public_number, public_name, cabinet_type, directions, about, availability, visibility, review_status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'hidden', 'pending', ?, ?)
        `).bind(id, user.ownerKey, publicNumber, name, type, directions, about, availability, timestamp, timestamp).run();
        const created = await env.DB.prepare('SELECT * FROM cabinets WHERE id = ?').bind(id).first();
        return json({ cabinet: cabinetView(created), note: 'Кабінет збережено й очікує перевірки адміністратора.' }, 201);
      }

      const ownCabinetMatch = path.match(/^\/api\/cabinets\/([\w-]+)$/);
      if (ownCabinetMatch && request.method === 'PUT') {
        const cabinet = await ownsCabinet(env.DB, ownCabinetMatch[1], user);
        if (!cabinet) return json({ error: 'Кабінет не знайдено.' }, 404);
        const body = await readBody(request);
        const name = clean(body.name, 80);
        const type = clean(body.type, 80);
        if (name.length < 2 || !allowedTypes.has(type)) return json({ error: 'Перевірте публічне ім’я та тип кабінету.' }, 400);
        const directions = clean(body.directions, 350);
        const about = clean(body.about, 600);
        const availability = ['ready', 'busy', 'offline', 'hidden'].includes(body.availability) ? body.availability : 'offline';
        const timestamp = now();
        await env.DB.prepare(`
          UPDATE cabinets SET public_name = ?, cabinet_type = ?, directions = ?, about = ?, availability = ?, visibility = 'hidden', review_status = 'pending', updated_at = ?
          WHERE id = ?
        `).bind(name, type, directions, about, availability, timestamp, cabinet.id).run();
        const updated = await env.DB.prepare('SELECT * FROM cabinets WHERE id = ?').bind(cabinet.id).first();
        return json({ cabinet: cabinetView(updated), note: 'Зміни збережено й передано на повторну перевірку.' });
      }

      if (request.method === 'GET' && path === '/api/requests') {
        const { results } = await env.DB.prepare(`
          SELECT r.*, f.public_name AS from_name, f.public_number AS from_number, t.public_name AS to_name, t.public_number AS to_number
          FROM contact_requests r
          JOIN cabinets f ON f.id = r.from_cabinet_id
          JOIN cabinets t ON t.id = r.to_cabinet_id
          WHERE f.owner_key = ? OR t.owner_key = ?
          ORDER BY r.created_at DESC LIMIT 100
        `).bind(user.ownerKey, user.ownerKey).all();
        return json({ requests: results.map((row) => ({
          id: row.id, from: { id: row.from_cabinet_id, name: row.from_name, number: row.from_number },
          to: { id: row.to_cabinet_id, name: row.to_name, number: row.to_number },
          message: row.message, state: row.state, createdAt: row.created_at, respondedAt: row.responded_at,
        })) });
      }

      if (request.method === 'POST' && path === '/api/contact-requests') {
        const body = await readBody(request);
        const from = await ownsCabinet(env.DB, clean(body.fromCabinetId, 80), user);
        const to = await env.DB.prepare("SELECT * FROM cabinets WHERE id = ? AND review_status = 'approved' AND visibility = 'visible'").bind(clean(body.toCabinetId, 80)).first();
        const message = clean(body.message, 500);
        if (!from || !to || from.id === to.id || !message) return json({ error: 'Перевірте кабінети та текст запиту.' }, 400);
        if (from.review_status !== 'approved' || from.visibility !== 'visible') return json({ error: 'Спершу дочекайтеся схвалення свого кабінету.' }, 400);
        const id = crypto.randomUUID();
        const timestamp = now();
        await env.DB.prepare(`
          INSERT INTO contact_requests (id, from_cabinet_id, to_cabinet_id, message, state, created_at)
          VALUES (?, ?, ?, ?, 'pending', ?)
        `).bind(id, from.id, to.id, message, timestamp).run();
        return json({ id, state: 'pending', note: 'Запит передано. Контакт не відкривається без відповіді власника кабінету.' }, 201);
      }

      const responseMatch = path.match(/^\/api\/contact-requests\/([\w-]+)\/respond$/);
      if (responseMatch && request.method === 'POST') {
        const body = await readBody(request);
        const state = body.state === 'accepted' ? 'accepted' : body.state === 'declined' ? 'declined' : '';
        if (!state) return json({ error: 'Оберіть: прийняти або відхилити.' }, 400);
        const requestRow = await env.DB.prepare(`
          SELECT r.* FROM contact_requests r JOIN cabinets t ON t.id = r.to_cabinet_id
          WHERE r.id = ? AND t.owner_key = ? AND r.state = 'pending'
        `).bind(responseMatch[1], user.ownerKey).first();
        if (!requestRow) return json({ error: 'Запит не знайдено або він уже оброблений.' }, 404);
        await env.DB.prepare('UPDATE contact_requests SET state = ?, responded_at = ? WHERE id = ?').bind(state, now(), requestRow.id).run();
        return json({ state, note: state === 'accepted' ? 'Запит прийнято. Наступний модуль додасть безпечну переписку.' : 'Запит відхилено.' });
      }

      if (request.method === 'GET' && path === '/api/admin/cabinets') {
        if (!isAdmin(user, env)) return json({ error: 'Доступ адміністратора потрібен.' }, 403);
        const { results } = await env.DB.prepare('SELECT * FROM cabinets ORDER BY updated_at DESC LIMIT 200').all();
        return json({ cabinets: results.map((row) => cabinetView(row, true)) });
      }

      const moderationMatch = path.match(/^\/api\/admin\/cabinets\/([\w-]+)$/);
      if (moderationMatch && request.method === 'PATCH') {
        if (!isAdmin(user, env)) return json({ error: 'Доступ адміністратора потрібен.' }, 403);
        const body = await readBody(request);
        const reviewStatus = ['approved', 'hidden'].includes(body.reviewStatus) ? body.reviewStatus : '';
        if (!reviewStatus) return json({ error: 'Неправильний стан перевірки.' }, 400);
        const visibility = reviewStatus === 'approved' && body.visibility === 'visible' ? 'visible' : 'hidden';
        const result = await env.DB.prepare('UPDATE cabinets SET review_status = ?, visibility = ?, updated_at = ? WHERE id = ?').bind(reviewStatus, visibility, now(), moderationMatch[1]).run();
        if (!result.meta.changes) return json({ error: 'Кабінет не знайдено.' }, 404);
        return json({ ok: true });
      }

      return json({ error: 'Маршрут не знайдено.' }, 404);
    } catch (error) {
      console.log(JSON.stringify({ event: 'api_error', path, error: error instanceof Error ? error.message : 'unknown' }));
      return json({ error: 'Не вдалося виконати дію. Спробуйте ще раз.' }, 500);
    }
  },
};
