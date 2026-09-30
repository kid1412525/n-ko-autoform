/**
 * storage.js — localStorage へのデータ保存・読み込み
 *
 *   nko.profile  … あなたの情報（名前）
 *   nko.classes  … 登録した授業（フォームのURL・名前を入れる質問のID・時間割のコマ）
 *   nko.settings … テーマ・表示する曜日・時限の時間
 *   nko.history  … 提出履歴（「入力済みで開く」を押した記録）
 */
(function (root) {
  'use strict';

  const KEYS = {
    profile: 'nko.profile',
    classes: 'nko.classes',
    settings: 'nko.settings',
    history: 'nko.history',
  };

  const DEFAULT_PERIODS = [
    { start: '09:45', end: '10:35' },
    { start: '10:45', end: '11:35' },
    { start: '11:45', end: '12:35' },
    { start: '13:15', end: '14:05' },
    { start: '14:15', end: '15:05' },
    { start: '15:15', end: '16:05' },
  ];

  // 以前の初期値（1限 9:00 始まり）。この時刻のまま保存されている設定は、読み込むときに今の初期値へ置き換える
  const OLD_DEFAULT_PERIODS = [
    { start: '09:00', end: '09:50' },
    { start: '10:00', end: '10:50' },
    { start: '11:00', end: '11:50' },
    { start: '13:00', end: '13:50' },
    { start: '14:00', end: '14:50' },
    { start: '15:00', end: '15:50' },
  ];

  // 設定の形式のバージョン（2 = 時限の初期値を 1限 9:45 始まりに変えたあとに保存した設定）
  const SETTINGS_VERSION = 2;

  const DEFAULT_DAYS = [1, 2, 3, 4, 5]; // 月〜金（0 = 日曜）
  const MAX_PERIODS = 10;
  const HISTORY_LIMIT = 300;

  const clone = (obj) => JSON.parse(JSON.stringify(obj));
  const toMinutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const toTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  /** base のあとに「前の時限の終了から10分後に始まる50分」の時限を足して n 個にする（画面で時限を増やすときと同じ規則） */
  function extendPeriods(base, n) {
    const list = clone(base).slice(0, n);
    while (list.length < n) {
      const start = toMinutes(list[list.length - 1].end) + 10;
      list.push({ start: toTime(start), end: toTime(start + 50) });
    }
    return list;
  }

  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) {
      console.warn('[storage] 読み込みに失敗しました:', key, e);
      return fallback;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.error('[storage] 保存に失敗しました:', key, e);
      return false;
    }
  }

  function newId() {
    return `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  function dateKey(d) {
    const date = d instanceof Date ? d : new Date(d);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  const validTime = (t) => (/^\d{2}:\d{2}$/.test(t || '') ? t : '');

  // ---- あなたの情報 ----

  function getProfile() {
    const p = read(KEYS.profile, {}) || {};
    return { name: typeof p.name === 'string' ? p.name : '' };
  }

  function saveName(name) {
    return write(KEYS.profile, { name: String(name || '').trim() });
  }

  // ---- 設定 ----

  function getSettings() {
    const s = read(KEYS.settings, {}) || {};
    const days = Array.isArray(s.days)
      ? [...new Set(s.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
      : [];
    let periods = Array.isArray(s.periods)
      ? s.periods.slice(0, MAX_PERIODS).map((p) => ({ start: validTime(p && p.start), end: validTime(p && p.end) }))
      : [];
    // 以前の版で、時刻を変えずに保存された設定（古い初期値のまま）は、今の初期値に置き換える
    if (s.version !== SETTINGS_VERSION && periods.length &&
        JSON.stringify(periods) === JSON.stringify(extendPeriods(OLD_DEFAULT_PERIODS, periods.length))) {
      periods = extendPeriods(DEFAULT_PERIODS, periods.length);
    }
    return {
      version: SETTINGS_VERSION,
      theme: s.theme === 'light' || s.theme === 'dark' ? s.theme : '', // '' = 端末の設定に合わせる
      days: days.length ? days : DEFAULT_DAYS.slice(),
      periods: periods.length ? periods : clone(DEFAULT_PERIODS),
    };
  }

  function saveSettings(settings) {
    return write(KEYS.settings, settings);
  }

  function defaultPeriods() {
    return clone(DEFAULT_PERIODS);
  }

  // ---- 授業 ----

  function normalizeClass(c) {
    return {
      id: String(c.id),
      name: String(c.name || ''),
      formTitle: String(c.formTitle || ''),
      url: String(c.url || ''),
      nameFieldId: String(c.nameFieldId || ''),
      fields: (Array.isArray(c.fields) ? c.fields : [])
        .filter((f) => f && f.id)
        .map((f) => ({ id: String(f.id), label: String(f.label || ''), type: String(f.type || '') })),
      slots: (Array.isArray(c.slots) ? c.slots : [])
        .filter((s) => s && Number.isInteger(s.day) && s.day >= 0 && s.day <= 6 &&
          Number.isInteger(s.period) && s.period >= 1 && s.period <= MAX_PERIODS)
        .map((s) => ({ day: s.day, period: s.period })),
      createdAt: c.createdAt || '',
      updatedAt: c.updatedAt || '',
    };
  }

  function getClasses() {
    const list = read(KEYS.classes, []);
    return Array.isArray(list) ? list.filter((c) => c && c.id).map(normalizeClass) : [];
  }

  function saveClasses(classes) {
    return write(KEYS.classes, classes);
  }

  function upsertClass(cls) {
    const classes = getClasses();
    const now = new Date().toISOString();
    const data = normalizeClass(Object.assign({}, cls, { id: cls.id || newId() }));
    const i = classes.findIndex((c) => c.id === data.id);
    data.createdAt = i >= 0 ? classes[i].createdAt : now;
    data.updatedAt = now;
    if (i >= 0) classes[i] = data;
    else classes.push(data);
    saveClasses(classes);
    return data;
  }

  function deleteClass(id) {
    saveClasses(getClasses().filter((c) => c.id !== id));
  }

  // ---- 提出履歴 ----

  function getHistory() {
    const list = read(KEYS.history, []);
    return Array.isArray(list) ? list.filter((r) => r && r.at) : [];
  }

  function addHistory(entry) {
    const at = new Date().toISOString();
    const list = getHistory();
    list.push({
      classId: entry.classId,
      className: entry.className,
      at,
      date: dateKey(at),
    });
    write(KEYS.history, list.slice(-HISTORY_LIMIT));
  }

  function getTodayHistory(classId) {
    const today = dateKey(new Date());
    return getHistory()
      .filter((r) => r.classId === classId && r.date === today)
      .sort((a, b) => (a.at < b.at ? -1 : 1));
  }

  function clearHistory() {
    write(KEYS.history, []);
  }

  root.NkoStorage = {
    MAX_PERIODS,
    getProfile, saveName,
    getSettings, saveSettings, defaultPeriods,
    getClasses, upsertClass, deleteClass,
    getHistory, addHistory, getTodayHistory, clearHistory,
    dateKey,
  };
})(window);
