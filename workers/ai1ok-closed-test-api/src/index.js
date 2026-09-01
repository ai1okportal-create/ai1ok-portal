const allowedTypes = new Set([
  'Людина', 'ФОП / підприємець', 'Компанія / підприємство',
  'Організація / ініціатива', 'Проєкт / команда',
]);

const blockCategories = new Set(['business', 'services', 'learning', 'creativity', 'market', 'communication', 'dating', 'announcements']);
const blockActions = new Set(['offer', 'seek', 'buy', 'sell', 'rent', 'partner', 'invite']);
const blockAvailability = new Set(['online', 'scheduled', 'offline', 'hidden']);
const connectionModes = new Set(['request', 'messages', 'meet']);
const homeShowcases = new Set(['portal', 'specialists', 'masters', 'authors', 'learning', 'customers', 'business', 'market', 'communication', 'dating', 'announcements']);
const regulatedAreas = new Set(['', 'medicine', 'psychology', 'legal', 'financial']);

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
    homeShowcase: row.home_showcase || 'portal',
    availability: row.availability,
    visibility: row.visibility,
    reviewStatus: row.review_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (includeOwner) result.ownerKey = row.owner_key;
  return result;
}

function blockView(row, includeCabinet = false) {
  const result = {
    id: row.id,
    cabinetId: row.cabinet_id,
    category: row.category,
    action: row.action,
    title: row.title,
    description: row.description,
    photoUrl: row.photo_url,
    externalUrl: row.external_url,
    city: row.city,
    availability: row.availability,
    scheduleText: row.schedule_text,
    connectionMode: row.connection_mode,
    regulatedArea: row.regulated_area || '',
    agreementStatus: row.agreement_status || 'not_required',
    visibility: row.visibility,
    reviewStatus: row.review_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (includeCabinet) result.cabinet = { number: row.public_number, name: row.public_name, type: row.cabinet_type };
  return result;
}

function cleanBlock(body) {
  const category = clean(body.category, 40);
  const action = clean(body.action, 20);
  const title = clean(body.title, 120);
  const description = clean(body.description, 1200);
  const photoUrl = clean(body.photoUrl, 500);
  const externalUrl = clean(body.externalUrl, 500);
  const city = clean(body.city, 80);
  const availability = blockAvailability.has(body.availability) ? body.availability : 'offline';
  const scheduleText = clean(body.scheduleText, 120);
  const connectionMode = connectionModes.has(body.connectionMode) ? body.connectionMode : 'request';
  const regulatedArea = regulatedAreas.has(body.regulatedArea) ? body.regulatedArea : '';
  const isPublicUrl = (value) => {
    if (!value) return true;
    try { return new URL(value).protocol === 'https:'; } catch { return false; }
  };
  if (!blockCategories.has(category) || !blockActions.has(action) || title.length < 3 || !isPublicUrl(photoUrl) || !isPublicUrl(externalUrl)) return null;
  return { category, action, title, description, photoUrl, externalUrl, city, availability, scheduleText, connectionMode, regulatedArea };
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

      if (request.method === 'GET' && path === '/api/my/cabinets') {
        const { results } = await env.DB.prepare('SELECT * FROM cabinets WHERE owner_key = ? ORDER BY public_number ASC LIMIT 20').bind(user.ownerKey).all();
        return json({ cabinets: results.map((row) => cabinetView(row)) });
      }

      if (request.method === 'POST' && path === '/api/cabinets') {
        const body = await readBody(request);
        const name = clean(body.name, 80);
        const type = clean(body.type, 80);
        const directions = clean(body.directions, 350);
        const about = clean(body.about, 600);
        const homeShowcase = homeShowcases.has(body.homeShowcase) ? body.homeShowcase : 'portal';
        const availability = ['ready', 'busy', 'offline', 'hidden'].includes(body.availability) ? body.availability : 'offline';
        if (!body.testConsent) return json({ error: 'Потрібна згода на збереження тестового кабінету.' }, 400);
        if (name.length < 2 || !allowedTypes.has(type)) return json({ error: 'Перевірте публічне ім’я та тип кабінету.' }, 400);

        const count = await env.DB.prepare('SELECT COUNT(*) AS total FROM cabinets WHERE owner_key = ?').bind(user.ownerKey).first();
        if (Number(count.total) >= 10) return json({ error: 'У закритому тесті можна створити до 10 кабінетів.' }, 400);

        const id = crypto.randomUUID();
        const timestamp = now();
        const publicNumber = await nextPublicNumber(env.DB);
        await env.DB.prepare(`
          INSERT INTO cabinets (id, owner_key, public_number, public_name, cabinet_type, directions, about, home_showcase, availability, visibility, review_status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'hidden', 'pending', ?, ?)
        `).bind(id, user.ownerKey, publicNumber, name, type, directions, about, homeShowcase, availability, timestamp, timestamp).run();
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
        const homeShowcase = homeShowcases.has(body.homeShowcase) ? body.homeShowcase : (cabinet.home_showcase || 'portal');
        const availability = ['ready', 'busy', 'offline', 'hidden'].includes(body.availability) ? body.availability : 'offline';
        const timestamp = now();
        await env.DB.prepare(`
          UPDATE cabinets SET public_name = ?, cabinet_type = ?, directions = ?, about = ?, home_showcase = ?, availability = ?, visibility = 'hidden', review_status = 'pending', updated_at = ?
          WHERE id = ?
        `).bind(name, type, directions, about, homeShowcase, availability, timestamp, cabinet.id).run();
        const updated = await env.DB.prepare('SELECT * FROM cabinets WHERE id = ?').bind(cabinet.id).first();
        return json({ cabinet: cabinetView(updated), note: 'Зміни збережено й передано на повторну перевірку.' });
      }

      if (request.method === 'GET' && path === '/api/blocks') {
        const category = clean(url.searchParams.get('category') || '', 40);
        const action = clean(url.searchParams.get('action') || '', 20);
        const params = [];
        let where = "b.review_status = 'approved' AND b.visibility = 'visible' AND c.review_status = 'approved' AND c.visibility = 'visible'";
        if (blockCategories.has(category)) { where += ' AND b.category = ?'; params.push(category); }
        if (blockActions.has(action)) { where += ' AND b.action = ?'; params.push(action); }
        const statement = env.DB.prepare(`SELECT b.*, c.public_number, c.public_name, c.cabinet_type FROM cabinet_blocks b JOIN cabinets c ON c.id = b.cabinet_id WHERE ${where} ORDER BY CASE b.availability WHEN 'online' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END, b.updated_at DESC LIMIT 100`);
        const { results } = params.length ? await statement.bind(...params).all() : await statement.all();
        return json({ blocks: results.map((row) => blockView(row, true)) });
      }

      const cabinetBlocksMatch = path.match(/^\/api\/cabinets\/([\w-]+)\/blocks$/);
      if (cabinetBlocksMatch && request.method === 'GET') {
        const cabinet = await ownsCabinet(env.DB, cabinetBlocksMatch[1], user);
        if (!cabinet) return json({ error: 'Кабінет не знайдено.' }, 404);
        const { results } = await env.DB.prepare('SELECT * FROM cabinet_blocks WHERE cabinet_id = ? AND visibility <> \'archived\' ORDER BY updated_at DESC LIMIT 50').bind(cabinet.id).all();
        return json({ blocks: results.map((row) => blockView(row)) });
      }

      if (cabinetBlocksMatch && request.method === 'POST') {
        const cabinet = await ownsCabinet(env.DB, cabinetBlocksMatch[1], user);
        const body = await readBody(request);
        const block = cleanBlock(body);
        if (!cabinet || !block) return json({ error: 'Перевірте кабінет і дані блоку.' }, 400);
        const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM cabinet_blocks WHERE cabinet_id = ? AND visibility <> 'archived'").bind(cabinet.id).first();
        if (Number(count.total) >= 30) return json({ error: 'У тесті можна створити до 30 блоків у кабінеті.' }, 400);
        const timestamp = now();
        const id = crypto.randomUUID();
        const agreementStatus = block.regulatedArea ? 'pending_documents' : 'not_required';
        await env.DB.prepare(`INSERT INTO cabinet_blocks (id, cabinet_id, category, action, title, description, photo_url, external_url, city, availability, schedule_text, connection_mode, regulated_area, agreement_status, visibility, review_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hidden', 'pending', ?, ?)`)
          .bind(id, cabinet.id, block.category, block.action, block.title, block.description, block.photoUrl, block.externalUrl, block.city, block.availability, block.scheduleText, block.connectionMode, block.regulatedArea, agreementStatus, timestamp, timestamp).run();
        const created = await env.DB.prepare('SELECT * FROM cabinet_blocks WHERE id = ?').bind(id).first();
        return json({ block: blockView(created), note: 'Блок додано як чернетку. Після перевірки він зможе потрапити у вітрину.' }, 201);
      }

      const ownBlockMatch = path.match(/^\/api\/blocks\/([\w-]+)$/);
      if (ownBlockMatch && request.method === 'PUT') {
        const current = await env.DB.prepare('SELECT b.* FROM cabinet_blocks b JOIN cabinets c ON c.id = b.cabinet_id WHERE b.id = ? AND c.owner_key = ?').bind(ownBlockMatch[1], user.ownerKey).first();
        const body = await readBody(request);
        const block = cleanBlock(body);
        if (!current || !block) return json({ error: 'Блок не знайдено або дані неповні.' }, 400);
        const agreementStatus = block.regulatedArea ? 'pending_documents' : 'not_required';
        await env.DB.prepare(`UPDATE cabinet_blocks SET category = ?, action = ?, title = ?, description = ?, photo_url = ?, external_url = ?, city = ?, availability = ?, schedule_text = ?, connection_mode = ?, regulated_area = ?, agreement_status = ?, visibility = 'hidden', review_status = 'pending', updated_at = ? WHERE id = ?`)
          .bind(block.category, block.action, block.title, block.description, block.photoUrl, block.externalUrl, block.city, block.availability, block.scheduleText, block.connectionMode, block.regulatedArea, agreementStatus, now(), current.id).run();
        const updated = await env.DB.prepare('SELECT * FROM cabinet_blocks WHERE id = ?').bind(current.id).first();
        return json({ block: blockView(updated), note: 'Зміни збережено і передано на повторну перевірку.' });
      }

      if (ownBlockMatch && request.method === 'DELETE') {
        const current = await env.DB.prepare('SELECT b.* FROM cabinet_blocks b JOIN cabinets c ON c.id = b.cabinet_id WHERE b.id = ? AND c.owner_key = ?').bind(ownBlockMatch[1], user.ownerKey).first();
        if (!current) return json({ error: 'Блок не знайдено.' }, 404);
        await env.DB.prepare("UPDATE cabinet_blocks SET visibility = 'archived', review_status = 'hidden', updated_at = ? WHERE id = ?").bind(now(), current.id).run();
        return json({ ok: true, note: 'Блок перенесено в архів. Він більше не відображається у вітрині.' });
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

      if (request.method === 'GET' && path === '/api/admin/blocks') {
        if (!isAdmin(user, env)) return json({ error: 'Доступ адміністратора потрібен.' }, 403);
        const { results } = await env.DB.prepare('SELECT b.*, c.public_number, c.public_name, c.cabinet_type FROM cabinet_blocks b JOIN cabinets c ON c.id = b.cabinet_id ORDER BY b.updated_at DESC LIMIT 300').all();
        return json({ blocks: results.map((row) => blockView(row, true)) });
      }

      const moderationBlockMatch = path.match(/^\/api\/admin\/blocks\/([\w-]+)$/);
      if (moderationBlockMatch && request.method === 'PATCH') {
        if (!isAdmin(user, env)) return json({ error: 'Доступ адміністратора потрібен.' }, 403);
        const body = await readBody(request);
        const reviewStatus = ['approved', 'hidden'].includes(body.reviewStatus) ? body.reviewStatus : '';
        if (!reviewStatus) return json({ error: 'Неправильний стан перевірки.' }, 400);
        const visibility = reviewStatus === 'approved' && body.visibility === 'visible' ? 'visible' : 'hidden';
        const current = await env.DB.prepare('SELECT * FROM cabinet_blocks WHERE id = ?').bind(moderationBlockMatch[1]).first();
        if (!current) return json({ error: 'Блок не знайдено.' }, 404);
        if (reviewStatus === 'approved' && current.regulated_area && current.agreement_status !== 'signed') return json({ error: 'Для регульованого напряму спершу потрібні перевірка документів і позначка про підписаний договір.' }, 400);
        const result = await env.DB.prepare('UPDATE cabinet_blocks SET review_status = ?, visibility = ?, updated_at = ? WHERE id = ?').bind(reviewStatus, visibility, now(), moderationBlockMatch[1]).run();
        return json({ ok: true });
      }

      const agreementMatch = path.match(/^\/api\/admin\/blocks\/([\w-]+)\/agreement$/);
      if (agreementMatch && request.method === 'PATCH') {
        if (!isAdmin(user, env)) return json({ error: 'Доступ адміністратора потрібен.' }, 403);
        const body = await readBody(request);
        const agreementStatus = ['pending_documents', 'pending_contract', 'signed', 'rejected'].includes(body.agreementStatus) ? body.agreementStatus : '';
        if (!agreementStatus) return json({ error: 'Оберіть правильний стан документів і договору.' }, 400);
        const result = await env.DB.prepare('UPDATE cabinet_blocks SET agreement_status = ?, updated_at = ? WHERE id = ? AND regulated_area <> \'\'').bind(agreementStatus, now(), agreementMatch[1]).run();
        if (!result.meta.changes) return json({ error: 'Регульований блок не знайдено.' }, 404);
        return json({ ok: true });
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
