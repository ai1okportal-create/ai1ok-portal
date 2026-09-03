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
    publicIdentityName: row.public_identity_name || '',
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
  const publicIdentityName = clean(body.publicIdentityName, 120);
  const privateContactEmail = clean(body.privateContactEmail, 254).toLowerCase();
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
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(privateContactEmail);
  if (!blockCategories.has(category) || !blockActions.has(action) || title.length < 3 || publicIdentityName.length < 2 || !validEmail || !isPublicUrl(photoUrl) || !isPublicUrl(externalUrl)) return null;
  return { category, action, title, publicIdentityName, privateContactEmail, description, photoUrl, externalUrl, city, availability, scheduleText, connectionMode, regulatedArea };
}

async function nextPublicNumber(db) {
  const row = await db.prepare('SELECT COALESCE(MAX(public_number), 0) + 1 AS next_number FROM cabinets').first();
  return Number(row.next_number);
}

async function ownsCabinet(db, cabinetId, user) {
  return db.prepare('SELECT * FROM cabinets WHERE id = ? AND owner_key = ?').bind(cabinetId, user.ownerKey).first();
}

async function ownsThread(db, threadId, user) {
  return db.prepare(`
    SELECT t.*, a.public_name AS cabinet_a_name, a.public_number AS cabinet_a_number,
           b.public_name AS cabinet_b_name, b.public_number AS cabinet_b_number
    FROM communicator_threads t
    JOIN cabinets a ON a.id = t.cabinet_a_id
    JOIN cabinets b ON b.id = t.cabinet_b_id
    WHERE t.id = ? AND (t.owner_a_key = ? OR t.owner_b_key = ?)
  `).bind(threadId, user.ownerKey, user.ownerKey).first();
}

function isMeetUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'meet.google.com';
  } catch { return false; }
}

function assistantTask(level, title, text, action, href = 'api-cabinets.html') {
  return { level, title, text, action, href };
}

async function assistantOverview(db, user) {
  const [cabinetResult, blockResult, requestResult, threadResult] = await db.batch([
    db.prepare('SELECT * FROM cabinets WHERE owner_key = ? ORDER BY updated_at DESC LIMIT 20').bind(user.ownerKey),
    db.prepare(`SELECT b.* FROM cabinet_blocks b JOIN cabinets c ON c.id = b.cabinet_id WHERE c.owner_key = ? AND b.visibility <> 'archived' ORDER BY b.updated_at DESC LIMIT 80`).bind(user.ownerKey),
    db.prepare(`SELECT r.*, t.owner_key AS target_owner FROM contact_requests r JOIN cabinets f ON f.id = r.from_cabinet_id JOIN cabinets t ON t.id = r.to_cabinet_id WHERE f.owner_key = ? OR t.owner_key = ? ORDER BY r.created_at DESC LIMIT 100`).bind(user.ownerKey, user.ownerKey),
    db.prepare("SELECT * FROM communicator_threads WHERE (owner_a_key = ? OR owner_b_key = ?) AND state = 'active' ORDER BY updated_at DESC LIMIT 100").bind(user.ownerKey, user.ownerKey),
  ]);
  const cabinets = cabinetResult.results || [], blocks = blockResult.results || [];
  const requests = requestResult.results || [], threads = threadResult.results || [];
  const tasks = [];
  if (!cabinets.length) tasks.push(assistantTask('important', 'Створіть перший кабінет', 'Це ваша основа в АІ 1 ОК. Укажіть публічне ім’я, тип і короткий опис.', 'Відкрити форму'));
  const pendingCabinets = cabinets.filter((c) => c.review_status === 'pending').length;
  if (pendingCabinets) tasks.push(assistantTask('waiting', 'Кабінет очікує перевірки', `На перевірці: ${pendingCabinets}. Дані не потраплять у вітрину до схвалення адміністратора.`, 'Переглянути кабінети'));
  if (cabinets.length && !blocks.length) tasks.push(assistantTask('important', 'Додайте перший робочий блок', 'Саме блок із напрямом, описом і статусом може потрапити у відповідну вітрину порталу.', 'Додати блок'));
  const pendingBlocks = blocks.filter((b) => b.review_status === 'pending').length;
  if (pendingBlocks) tasks.push(assistantTask('waiting', 'Блоки очікують перевірки', `На перевірці: ${pendingBlocks}. Поки що вони не публічні.`, 'Переглянути блоки'));
  const withoutSchedule = blocks.filter((b) => b.availability === 'scheduled' && !b.schedule_text).length;
  if (withoutSchedule) tasks.push(assistantTask('important', 'Укажіть час для зв’язку', `У ${withoutSchedule} блок(ах) обрано «За розкладом», але не вказано години.`, 'Виправити розклад'));
  const withoutDescription = blocks.filter((b) => !b.description).length;
  if (withoutDescription) tasks.push(assistantTask('normal', 'Додайте короткий опис', `У ${withoutDescription} блок(ах) бракує опису: що пропонуєте або шукаєте і в якому форматі.`, 'Редагувати блоки'));
  const regulated = blocks.filter((b) => b.regulated_area && b.agreement_status !== 'signed').length;
  if (regulated) tasks.push(assistantTask('important', 'Регульований напрям потребує перевірки', `Блоків із документами або договором на перевірці: ${regulated}. Вони не публікуються автоматично.`, 'Переглянути блоки'));
  const incoming = requests.filter((r) => r.state === 'pending' && r.target_owner === user.ownerKey).length;
  if (incoming) tasks.push(assistantTask('important', 'Є нові запити на зв’язок', `Очікують вашого рішення: ${incoming}. Приймайте лише ті запити, на які готові відповісти.`, 'Відкрити запити'));
  if (threads.length) tasks.push(assistantTask('normal', 'Активні канали комунікатора', `Відкрито каналів після взаємної згоди: ${threads.length}. Особисті контакти не розкриваються автоматично.`, 'Відкрити комунікатор', 'communicator.html'));
  if (!tasks.length) tasks.push(assistantTask('ready', 'Все готово до наступного кроку', 'Перевірте свою вітрину, за потреби активуйте блок або додайте новий напрям.', 'Відкрити вітрину', 'index.html'));
  return { generatedAt: now(), summary: { cabinets: cabinets.length, blocks: blocks.length, pendingCabinets, pendingBlocks, incomingRequests: incoming, activeThreads: threads.length }, tasks, limits: ['Помічник не публікує блоки, не надсилає повідомлення і не відкриває контактів без вашої дії.', 'Телефон та e-mail не входять до відповіді помічника і не показуються у вітрині.', 'Посилання на Google Meet додає лише учасник каналу після взаємної згоди.'] };
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

      if (request.method === 'GET' && path === '/api/assistant/overview') {
        return json(await assistantOverview(env.DB, user));
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
        await env.DB.prepare(`INSERT INTO cabinet_blocks (id, cabinet_id, category, action, title, public_identity_name, private_contact_email, description, photo_url, external_url, city, availability, schedule_text, connection_mode, regulated_area, agreement_status, visibility, review_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hidden', 'pending', ?, ?)`)
          .bind(id, cabinet.id, block.category, block.action, block.title, block.publicIdentityName, block.privateContactEmail, block.description, block.photoUrl, block.externalUrl, block.city, block.availability, block.scheduleText, block.connectionMode, block.regulatedArea, agreementStatus, timestamp, timestamp).run();
        await env.DB.prepare(`INSERT INTO communicator_routes (id, cabinet_id, block_id, owner_key, private_contact_email, connection_mode, availability, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
          .bind(crypto.randomUUID(), cabinet.id, id, user.ownerKey, block.privateContactEmail, block.connectionMode, block.availability, timestamp, timestamp).run();
        const created = await env.DB.prepare('SELECT * FROM cabinet_blocks WHERE id = ?').bind(id).first();
        return json({ block: blockView(created), note: 'Блок додано як чернетку. Після перевірки він зможе потрапити у вітрину.' }, 201);
      }

      const ownBlockMatch = path.match(/^\/api\/blocks\/([\w-]+)$/);

      const presenceMatch = path.match(/^\/api\/blocks\/([\w-]+)\/presence$/);
      if (presenceMatch && request.method === 'PATCH') {
        const current = await env.DB.prepare('SELECT b.* FROM cabinet_blocks b JOIN cabinets c ON c.id = b.cabinet_id WHERE b.id = ? AND c.owner_key = ?').bind(presenceMatch[1], user.ownerKey).first();
        const body = await readBody(request);
        const availability = blockAvailability.has(body.availability) ? body.availability : '';
        if (!current || !availability) return json({ error: 'Блок не знайдено або статус неправильний.' }, 404);
        await env.DB.prepare('UPDATE cabinet_blocks SET availability = ?, updated_at = ? WHERE id = ?').bind(availability, now(), current.id).run();
        await env.DB.prepare('UPDATE communicator_routes SET availability = ?, active = ?, updated_at = ? WHERE block_id = ?').bind(availability, availability === 'hidden' ? 0 : 1, now(), current.id).run();
        const updated = await env.DB.prepare('SELECT * FROM cabinet_blocks WHERE id = ?').bind(current.id).first();
        return json({ block: blockView(updated), note: 'Статус присутності оновлено.' });
      }

      if (ownBlockMatch && request.method === 'PUT') {
        const current = await env.DB.prepare('SELECT b.* FROM cabinet_blocks b JOIN cabinets c ON c.id = b.cabinet_id WHERE b.id = ? AND c.owner_key = ?').bind(ownBlockMatch[1], user.ownerKey).first();
        const body = await readBody(request);
        const block = cleanBlock(body);
        if (!current || !block) return json({ error: 'Блок не знайдено або дані неповні.' }, 400);
        const agreementStatus = block.regulatedArea ? 'pending_documents' : 'not_required';
        await env.DB.prepare(`UPDATE cabinet_blocks SET category = ?, action = ?, title = ?, public_identity_name = ?, private_contact_email = ?, description = ?, photo_url = ?, external_url = ?, city = ?, availability = ?, schedule_text = ?, connection_mode = ?, regulated_area = ?, agreement_status = ?, visibility = 'hidden', review_status = 'pending', updated_at = ? WHERE id = ?`)
          .bind(block.category, block.action, block.title, block.publicIdentityName, block.privateContactEmail, block.description, block.photoUrl, block.externalUrl, block.city, block.availability, block.scheduleText, block.connectionMode, block.regulatedArea, agreementStatus, now(), current.id).run();
        await env.DB.prepare(`UPDATE communicator_routes SET private_contact_email = ?, connection_mode = ?, availability = ?, active = 1, updated_at = ? WHERE block_id = ?`)
          .bind(block.privateContactEmail, block.connectionMode, block.availability, now(), current.id).run();
        const updated = await env.DB.prepare('SELECT * FROM cabinet_blocks WHERE id = ?').bind(current.id).first();
        return json({ block: blockView(updated), note: 'Зміни збережено і передано на повторну перевірку.' });
      }

      if (ownBlockMatch && request.method === 'DELETE') {
        const current = await env.DB.prepare('SELECT b.* FROM cabinet_blocks b JOIN cabinets c ON c.id = b.cabinet_id WHERE b.id = ? AND c.owner_key = ?').bind(ownBlockMatch[1], user.ownerKey).first();
        if (!current) return json({ error: 'Блок не знайдено.' }, 404);
        await env.DB.prepare("UPDATE cabinet_blocks SET visibility = 'archived', review_status = 'hidden', updated_at = ? WHERE id = ?").bind(now(), current.id).run();
        await env.DB.prepare('UPDATE communicator_routes SET active = 0, availability = ?, updated_at = ? WHERE block_id = ?').bind('hidden', now(), current.id).run();
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
        const timestamp = now();
        if (state === 'accepted') {
          const source = await env.DB.prepare('SELECT * FROM cabinets WHERE id = ?').bind(requestRow.from_cabinet_id).first();
          const target = await env.DB.prepare('SELECT * FROM cabinets WHERE id = ?').bind(requestRow.to_cabinet_id).first();
          if (!source || !target) return json({ error: 'Не вдалося підготувати канал зв’язку.' }, 500);
          const threadId = crypto.randomUUID();
          await env.DB.batch([
            env.DB.prepare('UPDATE contact_requests SET state = ?, responded_at = ? WHERE id = ?').bind(state, timestamp, requestRow.id),
            env.DB.prepare(`INSERT INTO communicator_threads (id, request_id, cabinet_a_id, cabinet_b_id, owner_a_key, owner_b_key, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
              .bind(threadId, requestRow.id, source.id, target.id, source.owner_key, target.owner_key, timestamp, timestamp),
            env.DB.prepare(`INSERT INTO communicator_messages (id, thread_id, sender_cabinet_id, kind, body, created_at) VALUES (?, ?, ?, 'system', ?, ?)`)
              .bind(crypto.randomUUID(), threadId, target.id, 'Запит на зв’язок прийнято. Тепер ви можете листуватися тут або за взаємною згодою додати посилання на Google Meet.', timestamp),
          ]);
          return json({ state, threadId, note: 'Запит прийнято. Відкрито закритий канал комунікатора.' });
        }
        await env.DB.prepare('UPDATE contact_requests SET state = ?, responded_at = ? WHERE id = ?').bind(state, timestamp, requestRow.id).run();
        return json({ state, note: 'Запит відхилено.' });
      }

      if (request.method === 'GET' && path === '/api/communicator/threads') {
        const { results } = await env.DB.prepare(`
          SELECT t.*, a.public_name AS cabinet_a_name, a.public_number AS cabinet_a_number,
                 b.public_name AS cabinet_b_name, b.public_number AS cabinet_b_number,
                 (SELECT body FROM communicator_messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
                 (SELECT created_at FROM communicator_messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_at
          FROM communicator_threads t
          JOIN cabinets a ON a.id = t.cabinet_a_id
          JOIN cabinets b ON b.id = t.cabinet_b_id
          WHERE t.owner_a_key = ? OR t.owner_b_key = ?
          ORDER BY COALESCE(last_message_at, t.updated_at) DESC LIMIT 100
        `).bind(user.ownerKey, user.ownerKey).all();
        return json({ threads: results.map((row) => {
          const mineIsA = row.owner_a_key === user.ownerKey;
          return {
            id: row.id, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at,
            myCabinetId: mineIsA ? row.cabinet_a_id : row.cabinet_b_id,
            other: { id: mineIsA ? row.cabinet_b_id : row.cabinet_a_id, name: mineIsA ? row.cabinet_b_name : row.cabinet_a_name, number: mineIsA ? row.cabinet_b_number : row.cabinet_a_number },
            lastMessage: row.last_body || '', lastMessageAt: row.last_message_at || '',
          };
        }) });
      }

      const threadMessagesMatch = path.match(/^\/api\/communicator\/threads\/([\w-]+)\/messages$/);
      if (threadMessagesMatch && request.method === 'GET') {
        const thread = await ownsThread(env.DB, threadMessagesMatch[1], user);
        if (!thread) return json({ error: 'Канал комунікатора не знайдено.' }, 404);
        const { results } = await env.DB.prepare(`
          SELECT m.*, c.public_name AS sender_name, c.public_number AS sender_number
          FROM communicator_messages m JOIN cabinets c ON c.id = m.sender_cabinet_id
          WHERE m.thread_id = ? ORDER BY m.created_at ASC LIMIT 200
        `).bind(thread.id).all();
        return json({ thread: { id: thread.id, state: thread.state, other: thread.owner_a_key === user.ownerKey ? { name: thread.cabinet_b_name, number: thread.cabinet_b_number } : { name: thread.cabinet_a_name, number: thread.cabinet_a_number } }, messages: results.map((row) => ({ id: row.id, kind: row.kind, body: row.body, createdAt: row.created_at, mine: row.sender_cabinet_id === (thread.owner_a_key === user.ownerKey ? thread.cabinet_a_id : thread.cabinet_b_id), sender: { name: row.sender_name, number: row.sender_number } })) });
      }

      if (threadMessagesMatch && request.method === 'POST') {
        const thread = await ownsThread(env.DB, threadMessagesMatch[1], user);
        const body = await readBody(request);
        const senderCabinetId = clean(body.fromCabinetId, 80);
        const kind = ['text', 'meet_request', 'meet_link'].includes(body.kind) ? body.kind : 'text';
        const message = clean(body.body, 1200);
        const myCabinetId = thread && (thread.owner_a_key === user.ownerKey ? thread.cabinet_a_id : thread.cabinet_b_id);
        if (!thread || thread.state !== 'active' || senderCabinetId !== myCabinetId || !message) return json({ error: 'Не вдалося надіслати повідомлення.' }, 400);
        if (kind === 'meet_link' && !isMeetUrl(message)) return json({ error: 'Для зустрічі додайте коректне посилання Google Meet.' }, 400);
        const timestamp = now();
        await env.DB.batch([
          env.DB.prepare('INSERT INTO communicator_messages (id, thread_id, sender_cabinet_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), thread.id, senderCabinetId, kind, message, timestamp),
          env.DB.prepare('UPDATE communicator_threads SET updated_at = ? WHERE id = ?').bind(timestamp, thread.id),
        ]);
        return json({ ok: true, note: kind === 'meet_link' ? 'Посилання на Google Meet надіслано учаснику.' : 'Повідомлення надіслано.' }, 201);
      }

      const closeThreadMatch = path.match(/^\/api\/communicator\/threads\/([\w-]+)\/close$/);
      if (closeThreadMatch && request.method === 'POST') {
        const thread = await ownsThread(env.DB, closeThreadMatch[1], user);
        if (!thread) return json({ error: 'Канал комунікатора не знайдено.' }, 404);
        await env.DB.prepare("UPDATE communicator_threads SET state = 'closed', updated_at = ? WHERE id = ?").bind(now(), thread.id).run();
        return json({ ok: true, note: 'Канал закрито. Нові повідомлення не надходитимуть.' });
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
