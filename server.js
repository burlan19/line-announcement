// 潔沛科技 LINE 群組公告系統
// 零外部套件，只用 Node.js 內建模組（http/https/fs/crypto/url）
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 5050;
const DB_DIR = path.join(__dirname, 'db');
const DB_FILE = path.join(DB_DIR, 'data.json');
const BACKUP_DIR = path.join(DB_DIR, '歷史檔案');
const UPLOAD_DIR = path.join(DB_DIR, 'uploads');

for (const dir of [DB_DIR, BACKUP_DIR, UPLOAD_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---------- 資料庫（單一 JSON 檔） ----------

function defaultDB() {
  return {
    config: {
      channelAccessToken: '',
      channelSecret: '',
      groupId: '',
      knownGroups: {},   // groupId -> { note, lastSeen }
      adminUserIds: [],  // 空陣列 = 群組內任何人都可以下指令
    },
    users: {},           // userId -> { displayName, updatedAt }
    days: {},            // 'YYYY-MM-DD' -> { assignments:[], confirmed:{}, reports:[], announcementSentAt }
  };
}

let db = loadDB();

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const fresh = defaultDB();
    fs.writeFileSync(DB_FILE, JSON.stringify(fresh, null, 2), 'utf8');
    return fresh;
  }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Object.assign(defaultDB(), parsed);
  } catch (err) {
    console.error('讀取 data.json 失敗，改用空白資料庫：', err.message);
    return defaultDB();
  }
}

function persist() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  const today = todayStr();
  fs.writeFileSync(path.join(BACKUP_DIR, `data_${today}.json`), JSON.stringify(db, null, 2), 'utf8');
}

function ensureDay(date) {
  if (!db.days[date]) {
    db.days[date] = { assignments: [], confirmed: {}, reports: [], announcementSentAt: null };
  }
  return db.days[date];
}

function todayStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function getToken() {
  return process.env.LINE_CHANNEL_ACCESS_TOKEN || db.config.channelAccessToken || '';
}
function getSecret() {
  return process.env.LINE_CHANNEL_SECRET || db.config.channelSecret || '';
}

// ---------- LINE Messaging API 呼叫 ----------

function lineApi(hostname, apiPath, method, bodyObj) {
  return new Promise((resolve, reject) => {
    const token = getToken();
    const bodyStr = bodyObj ? JSON.stringify(bodyObj) : '';
    const req = https.request({
      hostname, path: apiPath, method,
      headers: Object.assign(
        { Authorization: `Bearer ${token}` },
        bodyObj ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {}
      ),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(text ? safeJSON(text) : {});
        } else {
          reject(new Error(`LINE API ${apiPath} 失敗 (${res.statusCode}): ${text}`));
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function safeJSON(text) {
  try { return JSON.parse(text); } catch (e) { return { raw: text }; }
}

function lineReply(replyToken, messages) {
  return lineApi('api.line.me', '/v2/bot/message/reply', 'POST', { replyToken, messages });
}
function linePush(to, messages) {
  return lineApi('api.line.me', '/v2/bot/message/push', 'POST', { to, messages });
}
function lineGetGroupMemberProfile(groupId, userId) {
  return lineApi('api.line.me', `/v2/bot/group/${groupId}/member/${userId}`, 'GET', null);
}
function lineGetProfile(userId) {
  return lineApi('api.line.me', `/v2/bot/profile/${userId}`, 'GET', null);
}

function lineGetContent(messageId) {
  return new Promise((resolve, reject) => {
    const token = getToken();
    https.get({
      hostname: 'api-data.line.me',
      path: `/v2/bot/message/${messageId}/content`,
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`下載附件失敗 (${res.statusCode})`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] || 'application/octet-stream' }));
    }).on('error', reject);
  });
}

async function resolveDisplayName(source) {
  const userId = source.userId;
  if (!userId) return '未知使用者';
  const cached = db.users[userId];
  try {
    const profile = source.type === 'group'
      ? await lineGetGroupMemberProfile(source.groupId, userId)
      : await lineGetProfile(userId);
    const name = profile.displayName || (cached && cached.displayName) || '未知使用者';
    db.users[userId] = { displayName: name, updatedAt: new Date().toISOString() };
    return name;
  } catch (err) {
    return (cached && cached.displayName) || '未知使用者';
  }
}

// ---------- 公告訊息（Flex Message） ----------

function buildAnnouncementFlex(date, assignments) {
  const rows = assignments.map((a) => ({
    type: 'box', layout: 'horizontal', spacing: 'sm',
    contents: [
      { type: 'text', text: a.name, size: 'sm', color: '#111111', flex: 3, wrap: true },
      { type: 'text', text: a.area || '-', size: 'sm', color: '#555555', flex: 3, wrap: true },
      { type: 'text', text: a.time || '-', size: 'sm', color: '#555555', flex: 2, align: 'end' },
    ],
  }));
  return {
    type: 'flex',
    altText: `📢 ${date} 今日工作分配`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical',
        contents: [{ type: 'text', text: '📢 今日工作分配', weight: 'bold', size: 'lg', color: '#ffffff' }],
        backgroundColor: '#2E7D32', paddingAll: 'md',
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'text', text: date, size: 'sm', color: '#888888' },
          { type: 'separator' },
          ...(rows.length ? rows : [{ type: 'text', text: '（今天尚未指派任何工作）', size: 'sm', color: '#888888' }]),
          { type: 'separator' },
          { type: 'text', text: '完成後請直接在群組留言文字或上傳照片回報進度。', size: 'xs', color: '#888888', wrap: true },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical',
        contents: [{
          type: 'button', style: 'primary', color: '#2E7D32',
          action: { type: 'postback', label: '✅ 確認收到', data: `action=confirm&date=${date}`, displayText: '確認收到今日公告' },
        }],
      },
    },
  };
}

function buildStatusText(date) {
  const day = ensureDay(date);
  if (!day.assignments.length) return `${date} 目前尚無分配的工作項目。`;
  const lines = day.assignments.map((a) => {
    const anyConfirmed = Object.keys(day.confirmed).length > 0;
    return `${a.name} → ${a.area || '-'} (${a.time || '-'})`;
  });
  const confirmedNames = Object.values(day.confirmed).map((c) => c.displayName);
  const reportCount = day.reports.length;
  return [
    `📋 ${date} 工作分配狀況`,
    ...lines,
    '',
    `✅ 已確認收到（${confirmedNames.length}人）：${confirmedNames.join('、') || '尚無'}`,
    `📸 今日回報筆數：${reportCount}`,
  ].join('\n');
}

// ---------- Webhook 指令處理 ----------

async function handleTextCommand(text, event, date) {
  const trimmed = text.trim();
  if (trimmed === '/說明' || trimmed.toLowerCase() === '/help') {
    return ['📖 使用說明',
      '/指派 姓名 區域 時間 → 新增一筆工作分配（可多行，一行一筆）',
      '/公告 → 立即發送今天的工作分配公告',
      '/進度 或 /查詢 → 查看今天的確認與回報狀況',
      '完成工作後，直接在群組留言文字或上傳照片，就會自動記錄成進度回報。',
    ].join('\n');
  }
  if (trimmed.startsWith('/指派')) {
    const body = trimmed.replace(/^\/指派/, '').trim();
    const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
    const day = ensureDay(date);
    const added = [];
    const skipped = [];
    for (const line of lines) {
      const tokens = line.split(/\s+/).filter(Boolean);
      if (tokens.length < 2) { skipped.push(line); continue; }
      const [name, area, time] = tokens;
      const item = { id: newId(), name, area: area || '', time: time || '', createdAt: new Date().toISOString() };
      day.assignments.push(item);
      added.push(`${item.name} ${item.area} ${item.time}`.trim());
    }
    persist();
    let reply = added.length ? `✅ 已新增 ${added.length} 筆分配：\n${added.join('\n')}` : '⚠️ 沒有新增任何項目，格式請用「姓名 區域 時間」';
    if (skipped.length) reply += `\n\n⚠️ 以下格式無法辨識，已略過：\n${skipped.join('\n')}`;
    return reply;
  }
  if (trimmed === '/公告' || trimmed === '/發送公告') {
    await sendAnnouncement(date);
    return null; // sendAnnouncement 已經用 push 發送公告本身，這裡不用再回覆
  }
  if (trimmed === '/進度' || trimmed === '/查詢') {
    return buildStatusText(date);
  }
  return undefined; // 不是指令
}

async function sendAnnouncement(date) {
  const groupId = db.config.groupId;
  if (!groupId) throw new Error('尚未設定公告群組，請先到後台網頁設定。');
  const day = ensureDay(date);
  const flex = buildAnnouncementFlex(date, day.assignments);
  await linePush(groupId, [flex]);
  day.announcementSentAt = new Date().toISOString();
  persist();
}

function matchAssignmentByName(day, displayName) {
  return day.assignments.find((a) => displayName && (a.name === displayName || displayName.includes(a.name) || a.name.includes(displayName)));
}

async function handleEvent(event) {
  const date = todayStr();
  const source = event.source || {};

  if (source.type === 'group' && source.groupId) {
    db.config.knownGroups[source.groupId] = db.config.knownGroups[source.groupId] || { note: '', lastSeen: '' };
    db.config.knownGroups[source.groupId].lastSeen = new Date().toISOString();
    if (!db.config.groupId) db.config.groupId = source.groupId; // 第一次自動選為預設公告群組
  }

  if (event.type === 'join') {
    persist();
    if (event.replyToken) {
      await lineReply(event.replyToken, [{ type: 'text', text: '哈囉！我是工作公告小幫手 🙋\n用 /說明 看看我能做什麼。' }]);
    }
    return;
  }

  if (event.type === 'postback') {
    const params = new URLSearchParams(event.postback.data || '');
    if (params.get('action') === 'confirm') {
      const d = params.get('date') || date;
      const day = ensureDay(d);
      const displayName = await resolveDisplayName(source);
      day.confirmed[source.userId] = { displayName, confirmedAt: new Date().toISOString() };
      persist();
      if (event.replyToken) {
        await lineReply(event.replyToken, [{ type: 'text', text: `✅ ${displayName} 已確認收到今日公告` }]);
      }
    }
    return;
  }

  if (event.type !== 'message') return;
  const message = event.message;
  const day = ensureDay(date);

  if (message.type === 'text') {
    const cmdResult = await handleTextCommand(message.text, event, date);
    if (cmdResult !== undefined) {
      persist();
      if (cmdResult && event.replyToken) {
        await lineReply(event.replyToken, [{ type: 'text', text: cmdResult }]);
      }
      return;
    }
    // 非指令的一般留言 → 視為進度回報
    const displayName = await resolveDisplayName(source);
    day.reports.push({
      id: newId(), userId: source.userId, displayName,
      type: 'text', content: message.text,
      matchedName: (matchAssignmentByName(day, displayName) || {}).name || null,
      createdAt: new Date().toISOString(),
    });
    persist();
    return;
  }

  if (message.type === 'image') {
    const displayName = await resolveDisplayName(source);
    const { buffer, contentType } = await lineGetContent(message.id);
    const ext = contentType.includes('png') ? 'png' : 'jpg';
    const dayDir = path.join(UPLOAD_DIR, date);
    if (!fs.existsSync(dayDir)) fs.mkdirSync(dayDir, { recursive: true });
    const filename = `${message.id}.${ext}`;
    fs.writeFileSync(path.join(dayDir, filename), buffer);
    day.reports.push({
      id: newId(), userId: source.userId, displayName,
      type: 'image', filename: `${date}/${filename}`,
      matchedName: (matchAssignmentByName(day, displayName) || {}).name || null,
      createdAt: new Date().toISOString(),
    });
    persist();
    return;
  }
}

// ---------- HTTP 伺服器 ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { sendJSON(res, 404, { error: 'not found' }); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // ---- LINE Webhook ----
    if (url.pathname === '/webhook' && req.method === 'POST') {
      const raw = await readRawBody(req);
      const signature = req.headers['x-line-signature'] || '';
      const secret = getSecret();
      const expected = crypto.createHmac('sha256', secret).update(raw).digest('base64');
      if (!secret || expected !== signature) {
        res.writeHead(401); res.end(); return;
      }
      res.writeHead(200); res.end(); // 先回 200 給 LINE，避免逾時重送
      let payload;
      try { payload = JSON.parse(raw.toString('utf8')); } catch (e) { return; }
      for (const event of payload.events || []) {
        try { await handleEvent(event); } catch (err) { console.error('處理事件失敗：', err.message); }
      }
      return;
    }

    // ---- 後台 API ----
    if (url.pathname === '/api/state' && req.method === 'GET') {
      const date = url.searchParams.get('date') || todayStr();
      sendJSON(res, 200, {
        date, today: todayStr(),
        day: ensureDay(date),
        config: {
          groupId: db.config.groupId,
          knownGroups: db.config.knownGroups,
          hasToken: !!getToken(),
          hasSecret: !!getSecret(),
          tokenFromEnv: !!process.env.LINE_CHANNEL_ACCESS_TOKEN,
          secretFromEnv: !!process.env.LINE_CHANNEL_SECRET,
        },
      });
      return;
    }

    if (url.pathname === '/api/config' && req.method === 'POST') {
      const raw = await readRawBody(req);
      const body = safeJSON(raw.toString('utf8') || '{}');
      if (typeof body.channelAccessToken === 'string') db.config.channelAccessToken = body.channelAccessToken.trim();
      if (typeof body.channelSecret === 'string') db.config.channelSecret = body.channelSecret.trim();
      if (typeof body.groupId === 'string') db.config.groupId = body.groupId.trim();
      persist();
      sendJSON(res, 200, { ok: true });
      return;
    }

    if (url.pathname === '/api/assignments' && req.method === 'POST') {
      const raw = await readRawBody(req);
      const body = safeJSON(raw.toString('utf8') || '{}');
      const date = body.date || todayStr();
      const day = ensureDay(date);
      const item = { id: newId(), name: (body.name || '').trim(), area: (body.area || '').trim(), time: (body.time || '').trim(), createdAt: new Date().toISOString() };
      if (!item.name) { sendJSON(res, 400, { error: '姓名不可空白' }); return; }
      day.assignments.push(item);
      persist();
      sendJSON(res, 200, { ok: true, item });
      return;
    }

    const assignmentMatch = url.pathname.match(/^\/api\/assignments\/([a-f0-9]+)$/);
    if (assignmentMatch && req.method === 'DELETE') {
      const date = url.searchParams.get('date') || todayStr();
      const day = ensureDay(date);
      day.assignments = day.assignments.filter((a) => a.id !== assignmentMatch[1]);
      persist();
      sendJSON(res, 200, { ok: true });
      return;
    }

    if (url.pathname === '/api/send-announcement' && req.method === 'POST') {
      const raw = await readRawBody(req);
      const body = safeJSON(raw.toString('utf8') || '{}');
      const date = body.date || todayStr();
      try {
        await sendAnnouncement(date);
        sendJSON(res, 200, { ok: true });
      } catch (err) {
        sendJSON(res, 400, { error: err.message });
      }
      return;
    }

    if (url.pathname === '/api/select-group' && req.method === 'POST') {
      const raw = await readRawBody(req);
      const body = safeJSON(raw.toString('utf8') || '{}');
      db.config.groupId = (body.groupId || '').trim();
      persist();
      sendJSON(res, 200, { ok: true });
      return;
    }

    // ---- 上傳照片靜態檔案 ----
    if (url.pathname.startsWith('/uploads/')) {
      const filePath = path.join(UPLOAD_DIR, url.pathname.replace('/uploads/', ''));
      if (!filePath.startsWith(UPLOAD_DIR)) { sendJSON(res, 400, { error: 'bad path' }); return; }
      serveStatic(res, filePath);
      return;
    }

    // ---- 前端頁面 ----
    if (url.pathname === '/' || url.pathname === '/index.html') {
      serveStatic(res, path.join(__dirname, 'public', 'index.html'));
      return;
    }

    sendJSON(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`LINE 群組公告系統已啟動：http://localhost:${PORT}`);
});
