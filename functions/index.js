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
const { onRequest } = require('firebase-functions/v2/https');
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

  // dataExtra.url が指定されればそれを優先（タップ時の遷移先）
  const tapLink = (dataExtra && dataExtra.url) || APP_URL;

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
      fcmOptions: { link: tapLink }
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

// ---------- 日本の祝日（2026〜2027 主な祝日）+ 振替休日 ----------
// 必要に応じて RTDB の publicHolidays/YYYY-MM-DD = true で上書き可能
const JP_HOLIDAYS_HARDCODED = {
  // 2026
  '2026-01-01': '元日',
  '2026-01-12': '成人の日',
  '2026-02-11': '建国記念の日',
  '2026-02-23': '天皇誕生日',
  '2026-03-20': '春分の日',
  '2026-04-29': '昭和の日',
  '2026-05-03': '憲法記念日',
  '2026-05-04': 'みどりの日',
  '2026-05-05': 'こどもの日',
  '2026-05-06': '振替休日',
  '2026-07-20': '海の日',
  '2026-08-11': '山の日',
  '2026-09-21': '敬老の日',
  '2026-09-22': '国民の休日',
  '2026-09-23': '秋分の日',
  '2026-10-12': 'スポーツの日',
  '2026-11-03': '文化の日',
  '2026-11-23': '勤労感謝の日',
  // 2027
  '2027-01-01': '元日',
  '2027-01-11': '成人の日',
  '2027-02-11': '建国記念の日',
  '2027-02-23': '天皇誕生日',
  '2027-03-21': '春分の日',
  '2027-03-22': '振替休日',
  '2027-04-29': '昭和の日',
  '2027-05-03': '憲法記念日',
  '2027-05-04': 'みどりの日',
  '2027-05-05': 'こどもの日',
  '2027-07-19': '海の日',
  '2027-08-11': '山の日',
  '2027-09-20': '敬老の日',
  '2027-09-23': '秋分の日',
  '2027-10-11': 'スポーツの日',
  '2027-11-03': '文化の日',
  '2027-11-23': '勤労感謝の日'
};
async function isHolidayOrSundayJST(dateStr) {
  // dateStr = YYYY-MM-DD（JST 基準）
  const d = new Date(dateStr + 'T00:00:00+09:00');
  const dow = d.getUTCDay(); // 日曜=0
  // ※ getUTCDay は UTC ベースだが、+09:00 で固定したので曜日として正しい
  if (dow === 0) return { holiday: true, reason: '日曜日' };
  // ハードコード祝日
  if (JP_HOLIDAYS_HARDCODED[dateStr]) {
    return { holiday: true, reason: JP_HOLIDAYS_HARDCODED[dateStr] };
  }
  // RTDB 上書きチェック
  try {
    const snap = await admin.database().ref('publicHolidays/' + dateStr).get();
    if (snap.exists() && snap.val()) {
      return { holiday: true, reason: String(snap.val()) };
    }
  } catch (e) {}
  return { holiday: false };
}

// ---------- 担当者名 → メール マッピング（RTDB 優先、コード fallback） ----------
const ASSIGNEE_EMAIL_FALLBACK = {
  '社長': 'mbk.matsui@gmail.com'
  // '汐海': 'shiokai@example.com'  // ← Realtime Database の assigneeEmails/汐海 に登録
};
async function getAssigneeEmail(name) {
  try {
    const snap = await admin.database().ref('assigneeEmails/' + name).get();
    const v = snap.val();
    if (v && typeof v === 'string') return v.toLowerCase();
  } catch (e) {}
  const fb = ASSIGNEE_EMAIL_FALLBACK[name];
  return fb ? fb.toLowerCase() : null;
}

// ---------- #5 作業報告書プロンプト（毎日 17:30 JST、日曜・祝日除外） ----------
// 担当者（社長・汐海）にそれぞれ「本日の作業報告書を記入してください」
exports.notifyDailyReportPrompt = onSchedule(
  { schedule: '30 17 * * *', timeZone: TZ },
  async () => {
    const today = todayStrJST();
    const hol = await isHolidayOrSundayJST(today);
    if (hol.holiday) {
      console.log('notifyDailyReportPrompt: skipped -', hol.reason, today);
      return;
    }
    const data = await getData();
    const projects = asArray(data.projects);
    const tasks = asArray(data.tasks);
    const ASSIGNEES = ['社長', '汐海'];
    const allTokens = await getAllTokens();
    for (const name of ASSIGNEES) {
      // 担当案件の今日のタスク数
      const projIds = {};
      projects.forEach(p => { if (p && p.assignee === name) projIds[p.id] = true; });
      const myTasks = tasks.filter(t =>
        t && projIds[t.projectId] && t.startDate && t.endDate &&
        t.startDate <= today && today <= t.endDate
      );
      if (!myTasks.length) {
        console.log('notifyDailyReportPrompt: no tasks for', name);
        continue;
      }
      // 既に報告書が記入済みかチェック（全部記入済みならスキップ）
      const education = asArray(data.education);
      const unreported = myTasks.filter(t =>
        !education.some(e => e && e.taskId === t.id && e.date === today)
      );
      if (!unreported.length) {
        console.log('notifyDailyReportPrompt: all reported for', name);
        continue;
      }
      const email = await getAssigneeEmail(name);
      if (!email) {
        console.log('notifyDailyReportPrompt: no email mapping for', name, '— set RTDB assigneeEmails/'+name);
        continue;
      }
      const tokens = allTokens.filter(t => t.email === email).map(t => t.token);
      if (!tokens.length) {
        console.log('notifyDailyReportPrompt: no tokens for', name, '(' + email + ')');
        continue;
      }
      const link = APP_URL + '?report=' + encodeURIComponent(name);
      const result = await sendToTokens(
        tokens,
        '📝 本日の作業報告書（' + name + '）',
        '本日 ' + unreported.length + ' 件のタスクが未記入です。タップして報告書を開く',
        { kind: 'daily_report', assignee: name, count: unreported.length, url: link }
      );
      console.log('notifyDailyReportPrompt sent to', name, result);
    }
  }
);

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

// ---------- #1 旧「17:00 作業員人数未入力リマインド」は notifyDailyReportPrompt に統合済みのため廃止 ----------
// 関数本体は削除。デプロイ済みのものは Cloud Shell で
//   firebase functions:delete notifyMissingWorkerCount --region asia-southeast1 --project genba-kanri-963a8
// を実行して削除してください。

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

// ---------- デバッグ：FCM 配信の動作確認 ----------
// URL を開くだけで、全 FCM トークンへテスト通知を送ります。
// 例: https://<region>-genba-kanri-963a8.cloudfunctions.net/testNotify?key=genba2026
const TEST_KEY = 'genba2026';

exports.testNotify = onRequest(async (req, res) => {
  if (req.query.key !== TEST_KEY) {
    res.status(403).send('forbidden');
    return;
  }
  try {
    const allTokens = await getAllTokens();
    const tokens = allTokens.map(t => t.token);
    const tokenSummary = allTokens.map(t => ({ uid: t.uid.slice(0, 8), email: t.email }));
    if (!tokens.length) {
      res.send(JSON.stringify({
        ok: false,
        reason: 'No FCM tokens registered.',
        hint: 'Open the app via the home screen icon and tap 🔔.'
      }, null, 2));
      return;
    }
    const r = await sendToTokens(
      tokens,
      'テスト通知（Functions）',
      'Cloud Functions から送信しています。' + new Date().toLocaleString('ja-JP', { timeZone: TZ }),
      { kind: 'test' }
    );
    res.send(JSON.stringify({ ok: true, tokenSummary, result: r }, null, 2));
  } catch (e) {
    res.status(500).send(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
  }
});

// ---------- デバッグ：データ構造の確認 ----------
// 現在の RTDB の `data` ノード概要を返します。
exports.debugData = onRequest(async (req, res) => {
  if (req.query.key !== TEST_KEY) {
    res.status(403).send('forbidden');
    return;
  }
  try {
    const today = todayStrJST();
    const tomorrow = addDaysStr(today, 1);
    const data = await getData();
    const projects = asArray(data.projects);
    const tasks = asArray(data.tasks);
    const education = asArray(data.education);
    const tomorrowStart = projects.filter(p => p && p.startDate === tomorrow);
    const overdue = tasks.filter(t => t && t.endDate && t.endDate < today && !t.workCompleted && t.status !== 'done');
    const activeToday = tasks.filter(t => t && t.startDate && t.endDate && t.startDate <= today && today <= t.endDate && !t.workCompleted && t.status !== 'done');
    const missing = activeToday.filter(t => !education.some(e => e && e.taskId === t.id && e.date === today));
    res.send(JSON.stringify({
      today, tomorrow,
      counts: {
        projects: projects.length,
        tasks: tasks.length,
        education: education.length
      },
      tomorrowStart: tomorrowStart.map(p => ({ name: p.name, startDate: p.startDate })),
      overdueTasks: overdue.map(t => ({ name: t.name, endDate: t.endDate, assignee: t.assignee })),
      activeTodayCount: activeToday.length,
      missingWorkerCount: missing.map(t => ({ name: t.name, id: t.id }))
    }, null, 2));
  } catch (e) {
    res.status(500).send(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
  }
});
