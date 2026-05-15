/**
 * 現場管理アプリ用 Cloud Functions
 * 4 つの自動通知：
 *   1) 17:00 リマインド「作業員人数 ○件未入力」
 *   2) タスク遅延の朝の一覧通知（広告）
 *   3) 他メンバーの更新通知（audit_logs 監視）
 *   4) 工事前日通知「明日着工：○○」
 */
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onValueCreated } = require('firebase-functions/v2/database');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');

admin.initializeApp();
// RTDB が asia-southeast1 にあるので、関数も同じリージョンに置く
setGlobalOptions({ region: 'asia-southeast1' });

const TZ = 'Asia/Tokyo';
const APP_URL = 'https://mbkmatsui-ui.github.io/genba-kanri/';

// ---------- ヘルパー ----------

function todayStrJST() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(new Date());
}

function addDaysStr(s, n) {
  const d = new Date(s + 'T00:00:00+09:00');
  d.setUTCDate(d.getUTCDate() + n);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(d);
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (!v || typeof v !== 'object') return [];
  return Object.keys(v)
    .filter(k => /^\d+$/.test(k))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
    .map(k => v[k])
    .filter(x => x != null);
}

async function getAllTokens() {
  const snap = await admin.database().ref('fcmTokens').get();
  const v = snap.val() || {};
  const out = [];
  Object.keys(v).forEach(uid => {
    const tokens = v[uid] || {};
    Object.keys(tokens).forEach(token => {
      const meta = tokens[token] || {};
      out.push({ uid, token, email: (meta.email || '').toLowerCase() });
    });
  });
  return out;
}

async function getData() {
  const snap = await admin.database().ref('data').get();
  return snap.val() || {};
}

/**
 * トークン配列に通知送信。失効トークンは RTDB から削除。
 */
async function sendToTokens(tokens, title, body, dataExtra) {
  if (!tokens || tokens.length === 0) {
    return { sent: 0, failed: 0, removed: 0 };
  }
  const data = Object.assign({ title, body, url: APP_URL }, dataExtra || {});
  // 値はすべて string に
  Object.keys(data).forEach(k => { data[k] = String(data[k] == null ? '' : data[k]); });

  const message = {
    tokens,
    data,
    webpush: {
      notification: {
        title,
        body,
        icon: 'icons/icon-192.png',
        badge: 'icons/icon-192.png'
      },
      fcmOptions: { link: APP_URL }
    }
  };

  const resp = await admin.messaging().sendEachForMulticast(message);
  let removed = 0;
  const dead = [];
  resp.responses.forEach((r, i) => {
    if (!r.success) {
      const code = r.error && r.error.code;
      if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token' ||
        code === 'messaging/invalid-argument'
      ) {
        dead.push(tokens[i]);
      }
    }
  });
  if (dead.length) {
    const allSnap = await admin.database().ref('fcmTokens').get();
    const all = allSnap.val() || {};
    const updates = {};
    Object.keys(all).forEach(uid => {
      Object.keys(all[uid] || {}).forEach(tk => {
        if (dead.indexOf(tk) !== -1) {
          updates[`fcmTokens/${uid}/${tk}`] = null;
          removed++;
        }
      });
    });
    if (Object.keys(updates).length) {
      await admin.database().ref().update(updates);
    }
  }
  return { sent: resp.successCount, failed: resp.failureCount, removed };
}

// ---------- #4 工事前日通知（毎朝 8:00 JST） ----------
exports.notifyTomorrowStart = onSchedule(
  { schedule: '0 8 * * *', timeZone: TZ },
  async () => {
    const today = todayStrJST();
    const tomorrow = addDaysStr(today, 1);
    const data = await getData();
    const projects = asArray(data.projects);
    const targets = projects.filter(p => p && p.startDate === tomorrow);
    if (!targets.length) {
      console.log('notifyTomorrowStart: no projects for', tomorrow);
      return;
    }
    const allTokens = await getAllTokens();
    const tokens = allTokens.map(t => t.token);
    const lines = targets.map(p => {
      const name = p.name || '無題';
      const cl = p.clientName ? `（${p.clientName}）` : '';
      return `${name}${cl}`;
    });
    const title = targets.length === 1 ? `明日着工：${lines[0]}` : `明日着工：${targets.length} 件`;
    const body = lines.join('\n');
    const res = await sendToTokens(tokens, title, body, { kind: 'tomorrow_start', date: tomorrow });
    console.log('notifyTomorrowStart', { tomorrow, count: targets.length, ...res });
  }
);

// ---------- #2 タスク遅延の朝の一覧通知（毎朝 8:30 JST） ----------
// MVP は全員へブロードキャスト。後で担当者個別配信に拡張予定。
exports.notifyOverdueTasks = onSchedule(
  { schedule: '30 8 * * *', timeZone: TZ },
  async () => {
    const today = todayStrJST();
    const data = await getData();
    const tasks = asArray(data.tasks);
    const overdue = tasks.filter(t =>
      t && t.endDate && t.endDate < today &&
      !t.workCompleted && t.status !== 'done'
    );
    if (!overdue.length) {
      console.log('notifyOverdueTasks: no overdue tasks');
      return;
    }
    const sample = overdue.slice(0, 3).map(t => {
      const a = t.assignee || t.supervisor || '担当未設定';
      return `${t.name || '無題'}（${a}）`;
    }).join('\n');
    const more = overdue.length > 3 ? `\nほか ${overdue.length - 3} 件` : '';
    const tokens = (await getAllTokens()).map(t => t.token);
    const res = await sendToTokens(
      tokens,
      `⚠️ 遅延タスク ${overdue.length} 件`,
      sample + more,
      { kind: 'overdue_tasks', date: today, count: overdue.length }
    );
    console.log('notifyOverdueTasks', { count: overdue.length, ...res });
  }
);

// ---------- #1 17:00 作業員人数未入力リマインド ----------
exports.notifyMissingWorkerCount = onSchedule(
  { schedule: '0 17 * * *', timeZone: TZ },
  async () => {
    const today = todayStrJST();
    const data = await getData();
    const tasks = asArray(data.tasks);
    const education = asArray(data.education);
    const activeToday = tasks.filter(t =>
      t && t.startDate && t.endDate &&
      t.startDate <= today && today <= t.endDate &&
      !t.workCompleted && t.status !== 'done'
    );
    const missing = activeToday.filter(t =>
      !education.some(e => e && e.taskId === t.id && e.date === today)
    );
    if (!missing.length) {
      console.log('notifyMissingWorkerCount: all entered');
      return;
    }
    const sample = missing.slice(0, 3).map(t => t.name || '無題').join('、');
    const more = missing.length > 3 ? ` ほか ${missing.length - 3} 件` : '';
    const tokens = (await getAllTokens()).map(t => t.token);
    const res = await sendToTokens(
      tokens,
      `作業員人数 ${missing.length} 件未入力`,
      `${sample}${more}（17時リマインド）`,
      { kind: 'missing_worker_count', date: today, count: missing.length }
    );
    console.log('notifyMissingWorkerCount', { count: missing.length, ...res });
  }
);

// ---------- #3 他メンバーの更新通知（audit_logs 監視） ----------
const CATEGORY_LABEL = {
  project:   '工事案件',
  task:      'タスク',
  education: '作業員人数',
  client:    '発注者',
  settings:  '設定'
};
const ACTION_LABEL = { add: '追加', update: '変更', delete: '削除' };
// 通知対象カテゴリのみ
const NOTIFY_CATEGORIES = ['project', 'task', 'education'];

exports.notifyAuditUpdate = onValueCreated(
  { ref: '/audit_logs/{logId}' },
  async (event) => {
    const entry = event.data && event.data.val ? event.data.val() : null;
    if (!entry) return;
    if (NOTIFY_CATEGORIES.indexOf(entry.category) === -1) return;

    const updaterEmail = (entry.user || '').toLowerCase();
    const updaterName  = entry.name || updaterEmail || '誰か';

    const allTokens = await getAllTokens();
    // 更新者本人は除外（複数端末でも全部除外）
    const tokens = allTokens
      .filter(t => t.email && t.email !== updaterEmail)
      .map(t => t.token);
    if (!tokens.length) {
      console.log('notifyAuditUpdate: no recipients (sole user)');
      return;
    }

    const catLabel = CATEGORY_LABEL[entry.category] || entry.category;
    const actLabel = ACTION_LABEL[entry.action] || entry.action || '';
    const title = `${updaterName}さんが${catLabel}を${actLabel}`;
    const target = entry.target ? `「${entry.target}」` : '';
    const detail = entry.details ? (target ? ' / ' + entry.details : entry.details) : '';
    const body = (target + detail).trim() || '更新がありました';

    const res = await sendToTokens(
      tokens, title, body,
      { kind: 'audit_update', category: entry.category, action: entry.action }
    );
    console.log('notifyAuditUpdate', { cat: entry.category, act: entry.action, ...res });
  }
);
