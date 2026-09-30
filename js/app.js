/**
 * app.js — Webアプリのメインロジック（画面の描画とイベント処理）
 *
 *   時間割エリア     … 今日の授業（ボタンからすぐ開ける）と、曜日×時限のグリッド
 *   授業の登録エリア … ブックマークレットでコピーしたJSONを貼り付けて授業を登録する
 *   あなたの情報     … 名前の保存と、提出時の注意
 *   履歴             … フォームを開いた日時
 *
 * 「名前を入れて開く」… /viewform?usp=pp_url&entry.XXXX=名前 を開く。
 *   「メールアドレスを記録する」のチェックと送信は、フォームの画面で本人が行う。
 */
(function () {
  'use strict';

  const S = window.NkoStorage;

  const DAYS = ['日', '月', '火', '水', '木', '金', '土'];
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const NAME_RE = /氏名|名前|なまえ|フルネーム|name/i;
  const KANA_RE = /ふりがな|フリガナ|よみがな|ヨミガナ|ひらがな|カタカナ|カナ|読み/;
  const MANUAL = '__manual';

  const state = {
    reg: null,          // 登録中の授業 { name, formTitle, url, fields, nameFieldId, slots, manual }
    regMessage: null,   // 登録エリアのメッセージ { text, tone }
    pendingSlot: null,  // 時間割の「＋」から登録を始めたときのコマ
    ttSignature: '',    // 時間割を描き直す必要があるかの判定用
  };

  // ---------------------------------------------------------------------------
  // 共通ヘルパー
  // ---------------------------------------------------------------------------

  const $ = (selector) => document.querySelector(selector);
  const toastEl = $('#toast');
  const dialogEl = $('#dialog');
  let toastTimer = null;

  /** 要素を作る。on〇〇 はイベント、value / checked はプロパティ、それ以外は属性として設定 */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const child of children.flat(Infinity)) {
      if (child == null || child === false) continue;
      el.append(child instanceof Node ? child : String(child));
    }
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key === 'value' || key === 'checked') el[key] = value;
      else el.setAttribute(key, value === true ? '' : value);
    }
    return el;
  }

  /** 子要素を入れ替える（replaceChildren は null を "null" という文字にしてしまうので除く） */
  function setChildren(el, ...children) {
    el.replaceChildren(...children.flat().filter((c) => c != null && c !== false));
  }

  function debounce(fn, wait) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  /** モーダルが開いているときは、その中に出さないと隠れてしまう */
  function overlayHost() {
    return dialogEl.open ? dialogEl : document.body;
  }

  function toast(message, tone) {
    const host = overlayHost();
    if (toastEl.parentElement !== host) host.append(toastEl);
    toastEl.textContent = message;
    toastEl.dataset.tone = tone || '';
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3800);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = h('textarea', { style: 'position:fixed;top:0;left:0;opacity:0' });
      ta.value = text;
      overlayHost().append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  function scrollToArea(id, focusSelector) {
    const area = document.getElementById(id);
    if (!area) return;
    area.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const target = focusSelector && $(focusSelector);
    if (target) target.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------------------
  // テーマ（🌙 / ☀️）
  // ---------------------------------------------------------------------------

  const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function currentTheme() {
    const t = S.getSettings().theme;
    if (t === 'light' || t === 'dark') return t;
    return darkQuery && darkQuery.matches ? 'dark' : 'light';
  }

  function applyTheme() {
    const theme = currentTheme();
    document.documentElement.dataset.theme = theme;
    const label = theme === 'dark' ? 'ライトモードに切り替え' : 'ダークモードに切り替え';
    const btn = $('#theme-toggle');
    btn.textContent = theme === 'dark' ? '☀️' : '🌙';
    btn.setAttribute('aria-label', label);
    btn.title = label;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#111418' : '#ffffff');
  }

  function toggleTheme() {
    const settings = S.getSettings();
    settings.theme = currentTheme() === 'dark' ? 'light' : 'dark';
    S.saveSettings(settings);
    applyTheme();
  }

  // ---------------------------------------------------------------------------
  // フォームのURL
  // ---------------------------------------------------------------------------

  /** フォームのURLを回答用の /viewform に変換する（/edit・/formResponse・/u/0/ なども対応） */
  function toViewformUrl(input) {
    let url;
    try {
      url = new URL(String(input || '').trim());
    } catch (e) {
      return '';
    }
    if (url.hostname !== 'docs.google.com') return '';
    const m = url.pathname.match(/^\/forms(?:\/u\/\d+)?\/d\/(e\/)?([A-Za-z0-9_-]+)/);
    return m ? `https://docs.google.com/forms/d/${m[1] || ''}${m[2]}/viewform` : '';
  }

  function urlError(input) {
    if (/forms\.gle\//.test(input)) {
      return '短縮URL（forms.gle）は使えません。フォームを開いて、アドレスバーに表示される長いURLを使ってください。';
    }
    return 'GoogleフォームのURL（https://docs.google.com/forms/…）ではありません。';
  }

  /** entry.123 / 123 / emailAddress をそろえる。正しくなければ '' */
  function normalizeFieldId(id) {
    const s = String(id || '').trim();
    if (s === 'emailAddress') return s;
    const m = s.match(/^(?:entry\.)?(\d+)$/);
    return m ? `entry.${m[1]}` : '';
  }

  /**
   * 事前入力URLを作る。
   *   https://docs.google.com/forms/d/e/…/viewform?usp=pp_url&entry.XXXX=名前
   *   ※ emailAddress だけは entry. を付けずに &emailAddress=名前
   */
  function buildFormUrl(cls, name) {
    const base = toViewformUrl(cls.url);
    if (!base) return '';
    let url = `${base}?usp=pp_url`;
    const fieldId = normalizeFieldId(cls.nameFieldId);
    if (fieldId && name) url += `&${fieldId}=${encodeURIComponent(name)}`;
    return url;
  }

  /** URLに含まれる entry.XXXX（事前入力URLの場合）を質問の候補にする */
  function fieldsFromUrl(input) {
    try {
      const params = new URL(String(input).trim()).searchParams;
      const fields = [];
      for (const [key, value] of params) {
        const id = key === 'emailAddress' ? key : normalizeFieldId(key.replace(/_(year|month|day|hour|minute)$/, ''));
        if (id && !fields.some((f) => f.id === id)) {
          fields.push({ id, label: value ? `URLの値：${value}` : '', type: '' });
        }
      }
      return fields;
    } catch (e) {
      return [];
    }
  }

  /** 名前を入れる質問を推測する（「名前（ふりがな）」より「名前」を優先） */
  function guessNameField(fields) {
    const textLike = fields.filter((f) => /記述|段落|メール|^$/.test(f.type || ''));
    const pool = textLike.length ? textLike : fields;
    const hit = pool.find((f) => NAME_RE.test(f.label) && !KANA_RE.test(f.label)) ||
      pool.find((f) => NAME_RE.test(f.label));
    if (hit) return hit.id;
    const entries = pool.filter((f) => f.id !== 'emailAddress');
    return entries.length === 1 ? entries[0].id : '';
  }

  /** ブックマークレットでコピーしたJSONを読む → { data } / { error } */
  function parseFormJson(text) {
    const s = String(text || '').trim();
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start < 0 || end <= start) {
      if (/^https?:\/\//.test(s)) {
        return { error: 'これはURLです。URLで登録するときは、下の「JSONを使わずに登録する」を使ってください。' };
      }
      return { error: 'JSONが見つかりません。ブックマークレットでコピーした内容を、そのまま貼り付けてください。' };
    }
    let data;
    try {
      data = JSON.parse(s.slice(start, end + 1));
    } catch (e) {
      return { error: 'JSONの形式が正しくありません。途中で切れていないか確認してください。' };
    }
    const url = toViewformUrl(data && data.url);
    if (!url) return { error: `フォームのURLが読み取れませんでした。${urlError(String(data && data.url || ''))}` };
    const fields = (Array.isArray(data.fields) ? data.fields : [])
      .map((f) => ({
        id: normalizeFieldId(f && f.id),
        label: String((f && (f.label || f.title)) || ''),
        type: String((f && f.type) || ''),
      }))
      .filter((f, i, list) => f.id && list.findIndex((x) => x.id === f.id) === i);
    return { data: { title: String(data.title || ''), url, fields } };
  }

  // ---------------------------------------------------------------------------
  // 時間・コマ
  // ---------------------------------------------------------------------------

  function minutesOf(t) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t || '');
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  function timeOf(min) {
    const hh = Math.floor(min / 60) % 24;
    const mm = min % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  const shortTime = (t) => (t ? t.replace(/^0(\d)/, '$1') : '');

  function periodRange(settings, period) {
    const p = settings.periods[period - 1];
    if (!p || !p.start) return '';
    return p.end ? `${shortTime(p.start)}〜${shortTime(p.end)}` : shortTime(p.start);
  }

  /** 今の時限（開始10分前〜終了まで）。なければ 0 */
  function currentPeriod(settings, now) {
    const n = now.getHours() * 60 + now.getMinutes();
    for (let i = 0; i < settings.periods.length; i++) {
      const start = minutesOf(settings.periods[i].start);
      if (start == null) continue;
      const end = minutesOf(settings.periods[i].end) ?? start + 50;
      if (n >= start - 10 && n <= end) return i + 1;
    }
    return 0;
  }

  function clock(iso) {
    const d = new Date(iso);
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function sortSlots(slots) {
    return slots.slice().sort((a, b) => DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day) || a.period - b.period);
  }

  function isShownSlot(slot, settings) {
    return settings.days.includes(slot.day) && slot.period <= settings.periods.length;
  }

  function latestToday(classId) {
    const list = S.getTodayHistory(classId);
    return list[list.length - 1] || null;
  }

  // ---------------------------------------------------------------------------
  // フォームを開く（名前を入れて開く）
  // ---------------------------------------------------------------------------

  function openForm(cls) {
    const name = S.getProfile().name.trim();
    if (!name) {
      closeDialog();
      toast('先に「あなたの情報」で名前を保存してください', 'error');
      scrollToArea('profile-area', '#profile-name');
      return false;
    }
    if (!normalizeFieldId(cls.nameFieldId) &&
        !confirm(`「${cls.name}」には名前を入れる質問が設定されていません。名前なしで開きますか？`)) return false;

    const url = buildFormUrl(cls, name);
    if (!url) {
      toast('フォームのURLが正しくありません。授業を編集してください', 'error');
      return false;
    }

    S.addHistory({ classId: cls.id, className: cls.name });
    const win = window.open(url, '_blank');
    if (win) {
      try { win.opener = null; } catch (e) { /* ignore */ }
    } else {
      location.href = url; // ポップアップがブロックされたときは、このタブで開く
    }
    toast('フォームを開きました。「メールアドレスを記録する」にチェックを入れて送信してください');
    renderDynamic();
    return true;
  }

  function openButton(cls, extraClass, after) {
    return h('button', {
      class: `btn primary ${extraClass || ''}`, type: 'button',
      onclick: () => {
        if (openForm(cls) && after) after();
      },
    }, '名前を入れて開く');
  }

  function statusChip(rec) {
    return rec ? h('span', { class: 'chip accent' }, `${clock(rec.at)} に開きました`) : null;
  }

  // ---------------------------------------------------------------------------
  // 時間割エリア
  // ---------------------------------------------------------------------------

  function onboarding(classes) {
    if (classes.length) return null;
    const hasName = !!S.getProfile().name;
    const step = (done, text, target, focus) => h('li', null,
      h('a', {
        href: `#${target}`,
        onclick: (e) => {
          e.preventDefault();
          scrollToArea(target, focus);
        },
      }, text),
      done && h('span', { class: 'done' }, '（完了）'));
    return h('div', { class: 'onboarding' },
      h('p', { class: 'onboarding-title' }, 'はじめに'),
      h('ol', null,
        step(hasName, '「あなたの情報」に名前を保存する', 'profile-area', '#profile-name'),
        step(false, '出席フォームでブックマークレットを実行し、フォームの情報をコピーする', 'register-area'),
        step(false, '「授業の登録」にコピーした内容を貼り付けて登録する', 'register-area', '#reg-json')));
  }

  function todaySection(classes, settings, now) {
    const today = now.getDay();
    const cur = currentPeriod(settings, now);
    const items = [];
    for (const cls of classes) {
      for (const s of cls.slots) if (s.day === today) items.push({ cls, period: s.period });
    }
    items.sort((a, b) => a.period - b.period);

    return h('section', { class: 'today', 'aria-label': '今日の授業' },
      h('h3', { class: 'sub-title' }, `今日の授業（${now.getMonth() + 1}/${now.getDate()} ${DAYS[today]}曜日）`),
      items.length
        ? h('div', { class: 'today-list' }, items.map(({ cls, period }) => {
          const rec = latestToday(cls.id);
          const isNow = period === cur;
          return h('article', { class: `today-item${isNow ? ' is-now' : ''}` },
            h('div', { class: 'today-period' },
              h('strong', null, `${period}限`),
              h('span', null, periodRange(settings, period))),
            h('div', { class: 'today-main' },
              h('div', { class: 'today-name' }, cls.name),
              (isNow || rec) && h('div', { class: 'today-meta' },
                isNow && h('span', { class: 'chip now' }, '今の時限'),
                statusChip(rec))),
            h('div', { class: 'today-actions' }, openButton(cls, 'small')));
        }))
        : h('p', { class: 'muted small' }, '今日の授業は登録されていません。'));
  }

  function gridSection(classes, settings, now) {
    const days = DAY_ORDER.filter((d) => settings.days.includes(d));
    const today = now.getDay();
    const cur = currentPeriod(settings, now);
    const cells = [h('div', { class: 'tt-corner' })];

    for (const d of days) {
      cells.push(h('div', { class: `tt-day${d === today ? ' is-today' : ''}` }, DAYS[d]));
    }
    settings.periods.forEach((p, i) => {
      const period = i + 1;
      cells.push(h('div', { class: `tt-period${period === cur ? ' is-now' : ''}` },
        h('strong', null, `${period}限`),
        p.start && h('span', null, shortTime(p.start))));
      for (const d of days) {
        const list = classes.filter((c) => c.slots.some((s) => s.day === d && s.period === period));
        const isToday = d === today;
        cells.push(h('div', { class: `tt-cell${isToday ? ' is-today' : ''}${isToday && period === cur ? ' is-now' : ''}` },
          list.length
            ? list.map((c) => h('button', {
              class: 'tt-class', type: 'button', title: c.name,
              'aria-label': `${DAYS[d]}曜${period}限 ${c.name}`,
              onclick: () => openClassDialog(c),
            }, h('span', { class: 'tt-class-name' }, c.name)))
            : h('button', {
              class: 'tt-add', type: 'button', title: 'この時限に授業を登録',
              'aria-label': `${DAYS[d]}曜${period}限に授業を登録`,
              onclick: () => startRegisterAt(d, period),
            }, '+')));
      }
    });

    return h('div', { class: 'tt-scroll' },
      h('div', { class: 'tt-grid', style: `--days:${days.length}` }, cells));
  }

  function hiddenClassesSection(classes, settings) {
    const hidden = classes.filter((c) => !c.slots.some((s) => isShownSlot(s, settings)));
    if (!hidden.length) return null;
    return h('section', { class: 'unscheduled' },
      h('h3', { class: 'sub-title' }, '時間割に表示されていない授業'),
      h('div', { class: 'chip-row' }, hidden.map((c) => h('button', {
        class: 'tt-class inline', type: 'button', onclick: () => openClassDialog(c),
      }, c.name))));
  }

  function renderTimetableArea() {
    const settings = S.getSettings();
    const classes = S.getClasses();
    const now = new Date();
    state.ttSignature = `${S.dateKey(now)}|${currentPeriod(settings, now)}`;

    // 授業を1つでも登録したら、「はじめに」を消して1週間の時間割をいちばん上に出す
    const hasClasses = classes.length > 0;
    const weekly = [h('h3', { class: 'sub-title' }, '1週間の時間割'), gridSection(classes, settings, now)];

    setChildren($('#timetable-area'),
      h('div', { class: 'area-head' },
        h('h2', { class: 'area-title' }, '時間割'),
        h('button', { class: 'btn small', type: 'button', onclick: openTimetableSettings }, '曜日と時間の設定')),
      hasClasses ? weekly : onboarding(classes),
      todaySection(classes, settings, now),
      hasClasses ? null : weekly,
      hiddenClassesSection(classes, settings));
  }

  // ---------------------------------------------------------------------------
  // 授業の登録エリア
  // ---------------------------------------------------------------------------

  function bookmarkletSource() {
    return [
      '(function(){',
      'var d=window.FB_PUBLIC_LOAD_DATA_;',
      "if(!d||!d[1]){alert('Googleフォームの回答ページで実行してください');return}",
      "var T={0:'記述式',1:'段落',2:'ラジオボタン',3:'プルダウン',4:'チェックボックス',5:'均等目盛',7:'グリッド',9:'日付',10:'時刻'};",
      'var f=[];',
      "if(document.querySelector('input[type=email]'))f.push({id:'emailAddress',label:'メールアドレス（回答者が入力）',type:'メール'});",
      '(d[1][1]||[]).forEach(function(x){',
      'if(!x||!x[4]||!x[4][0]||x[4][0][0]==null)return;',
      "f.push({id:'entry.'+x[4][0][0],label:String(x[1]||''),type:T[x[3]]||'その他'})",
      '});',
      "var j=JSON.stringify({app:'n-ko-autoform',title:d[1][8]||d[3]||document.title,url:location.href.split(/[?#]/)[0],fields:f});",
      "var m='フォームの情報をコピーしました（質問'+f.length+'件）。アプリの「授業の登録」に貼り付けてください。';",
      'function c(){var t=document.createElement("textarea");t.value=j;t.style.position="fixed";t.style.opacity="0";',
      'document.body.appendChild(t);t.select();var ok=false;try{ok=document.execCommand("copy")}catch(e){}t.remove();',
      'if(ok){alert(m)}else{prompt("自動でコピーできませんでした。下の文字をすべてコピーしてください",j)}}',
      'if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(j).then(function(){alert(m)},c)}else{c()}',
      '})()',
    ].join('');
  }

  /** javascript: URL は実行前に %xx がデコードされるので、% はエスケープしておく */
  function bookmarkletUrl() {
    return `javascript:${bookmarkletSource().replace(/%/g, '%25')}`;
  }

  function renderRegisterArea() {
    const code = bookmarkletUrl();
    const textarea = h('textarea', {
      id: 'reg-json', class: 'input mono', rows: '4', spellcheck: 'false', autocomplete: 'off',
      placeholder: '{"title":"…","url":"https://docs.google.com/forms/…","fields":[…]}',
      oninput: debounce((e) => handleJsonInput(e.target.value), 250),
    });

    $('#register-area').replaceChildren(
      h('div', { class: 'area-head' }, h('h2', { class: 'area-title' }, '授業の登録')),
      h('ol', { class: 'reg-steps' },
        h('li', null,
          h('p', { class: 'step-title' }, 'ブックマークレットを用意する（最初の1回だけ）'),
          h('p', { class: 'muted small' }, 'フォームの質問ごとのID（entry.〇〇）を調べるために使います。'),
          h('div', { class: 'btn-row' },
            h('a', {
              class: 'btn bookmarklet', href: code, title: 'ブックマークバーにドラッグして登録',
              onclick: (e) => {
                e.preventDefault();
                toast('このリンクをブックマークバーにドラッグして登録してください');
              },
            }, 'N高フォーム解析'),
            h('button', {
              class: 'btn small', type: 'button',
              onclick: async () => {
                const ok = await copyText(code);
                toast(ok ? 'ブックマークレットのコードをコピーしました' : 'コピーできませんでした', ok ? '' : 'error');
              },
            }, 'コードをコピー')),
          h('details', { class: 'howto' },
            h('summary', null, 'PCでの登録のしかた'),
            h('ol', null,
              h('li', null, 'ブックマークバーを表示します（Chromeは Ctrl+Shift+B / ⌘+Shift+B）。'),
              h('li', null, '上の「N高フォーム解析」のリンクを、ブックマークバーにドラッグします。'))),
          h('details', { class: 'howto' },
            h('summary', null, 'スマホでの登録のしかた'),
            h('ol', null,
              h('li', null, '「コードをコピー」を押します。'),
              h('li', null, 'このページをブックマークに追加します。'),
              h('li', null, 'そのブックマークを編集して、名前を「N高フォーム解析」に、URLをコピーしたコードに書き換えて保存します。')))),
        h('li', null,
          h('p', { class: 'step-title' }, '出席フォームを開いて、ブックマークレットを実行する'),
          h('p', { class: 'muted small' }, 'PC：ブックマークバーの「N高フォーム解析」をクリックします。スマホ：アドレスバーに「N高フォーム解析」と入力し、表示されたブックマークをタップします（iPhoneのSafariはブックマーク一覧から）。フォームの情報がコピーされます。')),
        h('li', null,
          h('label', { class: 'step-title', for: 'reg-json' }, 'コピーした内容を貼り付けて登録する'),
          textarea,
          h('div', { id: 'reg-details', class: 'reg-details' }))));
    renderRegDetails();
  }

  function setRegMessage(text, tone) {
    state.regMessage = text ? { text, tone } : null;
    renderRegDetails();
  }

  function handleJsonInput(text) {
    if (!String(text).trim()) {
      state.reg = null;
      setRegMessage(null);
      return;
    }
    const r = parseFormJson(text);
    if (r.error) {
      state.reg = null;
      setRegMessage(r.error, 'error');
      return;
    }
    const prev = state.reg;
    state.reg = {
      name: r.data.title,
      formTitle: r.data.title,
      url: r.data.url,
      fields: r.data.fields,
      nameFieldId: guessNameField(r.data.fields),
      slots: prev ? prev.slots : (state.pendingSlot ? [Object.assign({}, state.pendingSlot)] : []),
      manual: false,
    };
    const existing = S.getClasses().find((c) => c.url === r.data.url);
    setRegMessage(
      `「${r.data.title || '無題のフォーム'}」を読み込みました（質問${r.data.fields.length}件）。` +
      (existing ? `このフォームは「${existing.name}」として登録済みです。` : ''),
      existing ? 'warn' : 'ok');
  }

  function manualRegister() {
    const urlInput = h('input', {
      class: 'input', type: 'url', id: 'manual-url', autocomplete: 'off',
      placeholder: 'https://docs.google.com/forms/d/e/…/viewform',
    });
    const idInput = h('input', {
      class: 'input mono', id: 'manual-id', autocomplete: 'off',
      placeholder: 'entry.123456789 または emailAddress',
    });
    return h('details', { class: 'howto manual' },
      h('summary', null, 'JSONを使わずに登録する（URLとIDを直接入力）'),
      h('p', { class: 'muted small' }, '名前を入れる質問のID（entry.〇〇）がわかる場合はこちら。事前入力したURLを貼ると、URLの中のIDも候補に出ます。'),
      h('label', { class: 'label', for: 'manual-url' }, 'フォームのURL'),
      urlInput,
      h('label', { class: 'label', for: 'manual-id' }, '名前を入れる質問のID'),
      idInput,
      h('button', {
        class: 'btn small', type: 'button',
        onclick: () => {
          const raw = urlInput.value.trim();
          const url = toViewformUrl(raw);
          if (!url) {
            setRegMessage(urlError(raw), 'error');
            return;
          }
          const typedId = idInput.value.trim();
          const fieldId = normalizeFieldId(typedId);
          if (typedId && !fieldId) {
            setRegMessage('IDの形式が正しくありません（例：entry.123456789）。', 'error');
            return;
          }
          const fields = fieldsFromUrl(raw);
          if (fieldId && !fields.some((f) => f.id === fieldId)) fields.unshift({ id: fieldId, label: '直接入力したID', type: '' });
          state.reg = {
            name: '', formTitle: '', url, fields,
            nameFieldId: fieldId || (fields.length === 1 ? fields[0].id : ''),
            slots: state.pendingSlot ? [Object.assign({}, state.pendingSlot)] : [],
            manual: false,
          };
          setRegMessage('フォームのURLを読み込みました。授業名とコマを入れて登録してください。', 'ok');
          const nameInput = $('#reg-name');
          if (nameInput) nameInput.focus();
        },
      }, '次へ'));
  }

  /** 「名前を入れる質問」の選択欄（候補にないIDは直接入力できる） */
  function nameFieldControl(draft, id) {
    const known = draft.fields.some((f) => f.id === draft.nameFieldId);
    const manualMode = draft.manual || (!!draft.nameFieldId && !known);
    const manualInput = h('input', {
      class: 'input mono', 'aria-label': '名前を入れる質問のID', autocomplete: 'off',
      placeholder: 'entry.123456789 または emailAddress',
      value: manualMode ? draft.nameFieldId : '', hidden: !manualMode,
      oninput: (e) => { draft.nameFieldId = e.target.value.trim(); },
    });
    const select = h('select', {
      class: 'input select', id, value: manualMode ? MANUAL : draft.nameFieldId,
      onchange: (e) => {
        const v = e.target.value;
        draft.manual = v === MANUAL;
        draft.nameFieldId = draft.manual ? manualInput.value.trim() : v;
        manualInput.hidden = !draft.manual;
        if (draft.manual) manualInput.focus();
      },
    },
      h('option', { value: '' }, '（名前を入れない）'),
      draft.fields.map((f) => h('option', { value: f.id }, `${f.label || '（無題の質問）'} ［${f.id}］`)),
      h('option', { value: MANUAL }, 'IDを直接入力する…'));

    return h('div', { class: 'field-block' },
      h('label', { class: 'label', for: id }, '名前を入れる質問'),
      select,
      manualInput,
      h('p', { class: 'hint' }, 'ここで選んだ質問に、「あなたの情報」で保存した名前が入ります。'));
  }

  /** 時間割のコマを選ぶ小さな表（タップで選択／解除、複数選択可） */
  function slotPicker(slots) {
    const settings = S.getSettings();
    const days = DAY_ORDER.filter((d) => settings.days.includes(d) || slots.some((s) => s.day === d));
    const maxPeriod = Math.max(settings.periods.length, ...slots.map((s) => s.period));
    const cells = [h('div', { class: 'sp-corner' })];
    days.forEach((d) => cells.push(h('div', { class: 'sp-day' }, DAYS[d])));

    for (let p = 1; p <= maxPeriod; p++) {
      cells.push(h('div', { class: 'sp-period' }, `${p}限`));
      for (const d of days) {
        const on = slots.some((s) => s.day === d && s.period === p);
        const btn = h('button', {
          class: 'sp-cell', type: 'button', 'aria-pressed': String(on), 'aria-label': `${DAYS[d]}曜${p}限`,
          onclick: () => {
            const i = slots.findIndex((s) => s.day === d && s.period === p);
            if (i >= 0) slots.splice(i, 1);
            else slots.push({ day: d, period: p });
            btn.setAttribute('aria-pressed', String(i < 0));
            btn.textContent = i < 0 ? '✓' : '';
          },
        }, on ? '✓' : '');
        cells.push(btn);
      }
    }
    return h('div', { class: 'slot-picker', style: `--days:${days.length}` }, cells);
  }

  function renderRegDetails() {
    const root = $('#reg-details');
    if (!root) return;
    const reg = state.reg;
    const nodes = [];
    if (state.regMessage) nodes.push(h('p', { class: `form-msg ${state.regMessage.tone || ''}`, role: 'status' }, state.regMessage.text));

    if (!reg) {
      if (state.pendingSlot) {
        nodes.push(h('p', { class: 'hint' },
          `${DAYS[state.pendingSlot.day]}曜${state.pendingSlot.period}限に登録します。JSONを貼り付けてください。`));
      }
      nodes.push(manualRegister());
      root.replaceChildren(...nodes);
      return;
    }

    nodes.push(h('div', { class: 'reg-form' },
      h('label', { class: 'label', for: 'reg-name' }, '授業名'),
      h('input', {
        class: 'input', id: 'reg-name', autocomplete: 'off', placeholder: '例：数学Ⅰ', value: reg.name,
        oninput: (e) => { reg.name = e.target.value; },
      }),
      nameFieldControl(reg, 'reg-field'),
      h('p', { class: 'label' }, '時間割のコマ（タップで選択・複数可）'),
      slotPicker(reg.slots),
      h('div', { class: 'btn-row reg-actions' },
        h('button', { class: 'btn primary', type: 'button', onclick: registerClass }, '登録'),
        h('button', { class: 'btn', type: 'button', onclick: resetRegister }, '入力をクリア'))));
    root.replaceChildren(...nodes);
  }

  function registerClass() {
    const reg = state.reg;
    if (!reg) return;
    const fieldId = normalizeFieldId(reg.nameFieldId);
    if (reg.nameFieldId && !fieldId) {
      setRegMessage('名前を入れる質問のIDが正しくありません（例：entry.123456789）。', 'error');
      return;
    }
    if (!fieldId && !confirm('名前を入れる質問が選ばれていません。このまま登録しますか？')) return;

    const cls = S.upsertClass({
      name: reg.name.trim() || reg.formTitle || '無題の授業',
      formTitle: reg.formTitle,
      url: reg.url,
      nameFieldId: fieldId,
      fields: reg.fields,
      slots: reg.slots,
    });
    state.reg = null;
    state.pendingSlot = null;
    $('#reg-json').value = '';
    setRegMessage(`「${cls.name}」を登録しました。`, 'ok');
    toast(`「${cls.name}」を登録しました`);
    renderDynamic();
  }

  function resetRegister() {
    state.reg = null;
    state.pendingSlot = null;
    $('#reg-json').value = '';
    setRegMessage(null);
  }

  /** 時間割の「＋」から、そのコマに登録する */
  function startRegisterAt(day, period) {
    state.pendingSlot = { day, period };
    if (state.reg) {
      if (!state.reg.slots.some((s) => s.day === day && s.period === period)) state.reg.slots.push({ day, period });
      renderRegDetails();
      scrollToArea('register-area', '#reg-name');
    } else {
      renderRegDetails();
      scrollToArea('register-area', '#reg-json');
    }
    toast(`${DAYS[day]}曜${period}限に授業を登録します`);
  }

  // ---------------------------------------------------------------------------
  // あなたの情報・提出履歴
  // ---------------------------------------------------------------------------

  function renderProfileArea() {
    const input = h('input', {
      class: 'input', id: 'profile-name', autocomplete: 'name', placeholder: '例：山田 太郎',
      value: S.getProfile().name,
      onkeydown: (e) => {
        if (e.key === 'Enter' && !e.isComposing) save();
      },
    });
    const save = () => {
      S.saveName(input.value);
      input.value = S.getProfile().name;
      toast(input.value ? '名前を保存しました' : '名前を消しました');
      renderDynamic();
    };

    $('#profile-area').replaceChildren(
      h('div', { class: 'area-head' }, h('h2', { class: 'area-title' }, 'あなたの情報')),
      h('label', { class: 'label', for: 'profile-name' }, '名前'),
      h('div', { class: 'input-row' },
        input,
        h('button', { class: 'btn primary', type: 'button', onclick: save }, '保存')),
      h('p', { class: 'hint' }, '名前はこの端末のブラウザにだけ保存され、フォームを開くときにURLに入ります。'),
      h('div', { class: 'alert-warning', role: 'note' },
        h('p', { class: 'alert-title' }, '⚠️ 提出時の注意'),
        h('p', null, 'Googleの仕様により、フォームの一番上にある『メールアドレスを記録する』のチェックボックスだけは自動でチェックできません。スマホでもPCでも、毎回手動でチェックを入れてから送信を押してください。')));
  }

  function renderHistoryArea() {
    const list = S.getHistory().slice().reverse().slice(0, 20);
    setChildren($('#history-area'),
      h('div', { class: 'area-head' },
        h('h2', { class: 'area-title' }, '履歴'),
        list.length > 0 && h('button', {
          class: 'btn small', type: 'button',
          onclick: () => {
            if (!confirm('履歴をすべて削除しますか？')) return;
            S.clearHistory();
            renderDynamic();
          },
        }, '履歴を消す')),
      list.length
        ? h('ul', { class: 'history' }, list.map((r) => {
          const d = new Date(r.at);
          return h('li', null,
            h('span', { class: 'history-time' }, `${d.getMonth() + 1}/${d.getDate()}（${DAYS[d.getDay()]}）${clock(r.at)}`),
            h('span', { class: 'history-name' }, r.className || '（削除された授業）'));
        }))
        : h('p', { class: 'muted small' }, 'まだ履歴はありません。'),
      h('p', { class: 'hint' }, 'フォームを開いた日時の記録です（最新20件）。送信できたかどうかは記録されないので、フォームの画面で確認してください。'));
  }

  // ---------------------------------------------------------------------------
  // ダイアログ
  // ---------------------------------------------------------------------------

  function showDialog(content) {
    const keepToast = toastEl.parentElement === dialogEl;
    dialogEl.replaceChildren(content);
    if (keepToast) dialogEl.append(toastEl);
    if (!dialogEl.open) {
      if (typeof dialogEl.showModal === 'function') dialogEl.showModal();
      else dialogEl.setAttribute('open', '');
    }
  }

  /** 閉じたあとも表示中のトーストは残す */
  function cleanupDialog() {
    if (toastEl.parentElement === dialogEl) document.body.append(toastEl);
    dialogEl.replaceChildren();
  }

  function closeDialog() {
    if (!dialogEl.open) return;
    if (typeof dialogEl.close === 'function') {
      dialogEl.close(); // close イベントで cleanupDialog が呼ばれる
    } else {
      dialogEl.removeAttribute('open');
      cleanupDialog();
    }
  }

  function dialogHead(title) {
    return h('div', { class: 'dialog-head' },
      h('h2', null, title),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': '閉じる', onclick: closeDialog }, '×'));
  }

  function openClassDialog(cls) {
    const settings = S.getSettings();
    const rec = latestToday(cls.id);
    const slots = sortSlots(cls.slots);
    showDialog(h('div', { class: 'dialog-inner' },
      dialogHead(cls.name),
      h('p', { class: 'muted small' }, slots.length
        ? slots.map((s) => {
          const range = periodRange(settings, s.period);
          return `${DAYS[s.day]}曜${s.period}限${range ? `（${range}）` : ''}`;
        }).join('・')
        : '時間割に入っていません'),
      cls.formTitle && h('p', { class: 'small' }, `フォーム：${cls.formTitle}`),
      rec && h('p', null, statusChip(rec)),
      !normalizeFieldId(cls.nameFieldId) && h('p', { class: 'form-msg warn' }, '名前を入れる質問が設定されていません。「編集」から設定できます。'),
      h('div', { class: 'dialog-actions' }, openButton(cls, 'wide', closeDialog)),
      h('p', { class: 'hint' }, 'フォームが開いたら「メールアドレスを記録する」にチェックを入れて、送信を押してください。'),
      h('div', { class: 'btn-row dialog-sub' },
        h('button', { class: 'btn small', type: 'button', onclick: () => openEditDialog(cls) }, '編集'),
        h('button', { class: 'btn small danger', type: 'button', onclick: () => deleteClassWithConfirm(cls) }, '削除'))));
  }

  function deleteClassWithConfirm(cls) {
    if (!confirm(`「${cls.name}」を削除しますか？`)) return;
    S.deleteClass(cls.id);
    closeDialog();
    toast(`「${cls.name}」を削除しました`);
    renderDynamic();
  }

  function openEditDialog(cls) {
    const draft = JSON.parse(JSON.stringify(cls));
    draft.manual = false;
    const msg = h('p', { class: 'form-msg error', role: 'alert', hidden: true });
    const showError = (text) => {
      msg.textContent = text;
      msg.hidden = false;
    };

    const save = () => {
      const url = toViewformUrl(draft.url);
      if (!url) {
        showError(urlError(draft.url));
        return;
      }
      const fieldId = normalizeFieldId(draft.nameFieldId);
      if (draft.nameFieldId && !fieldId) {
        showError('名前を入れる質問のIDが正しくありません（例：entry.123456789）。');
        return;
      }
      S.upsertClass(Object.assign({}, draft, { url, nameFieldId: fieldId, name: draft.name.trim() || cls.name }));
      closeDialog();
      toast('保存しました');
      renderDynamic();
    };

    showDialog(h('div', { class: 'dialog-inner' },
      dialogHead('授業を編集'),
      h('label', { class: 'label', for: 'edit-name' }, '授業名'),
      h('input', {
        class: 'input', id: 'edit-name', autocomplete: 'off', value: draft.name,
        oninput: (e) => { draft.name = e.target.value; },
      }),
      h('label', { class: 'label', for: 'edit-url' }, 'フォームのURL'),
      h('input', {
        class: 'input', type: 'url', id: 'edit-url', autocomplete: 'off', value: draft.url,
        oninput: (e) => { draft.url = e.target.value.trim(); },
      }),
      nameFieldControl(draft, 'edit-field'),
      h('p', { class: 'label' }, '時間割のコマ（タップで選択・複数可）'),
      slotPicker(draft.slots),
      msg,
      h('div', { class: 'btn-row dialog-foot' },
        h('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'キャンセル'),
        h('button', { class: 'btn primary', type: 'button', onclick: save }, '保存'))));
  }

  function openTimetableSettings() {
    const settings = S.getSettings();
    const draft = { days: settings.days.slice(), periods: settings.periods.map((p) => Object.assign({}, p)) };
    const msg = h('p', { class: 'form-msg error', role: 'alert', hidden: true });

    const periodList = h('div', { class: 'period-list' });
    const renderPeriods = () => periodList.replaceChildren(...draft.periods.map((p, i) => h('div', { class: 'period-row' },
      h('span', { class: 'period-label' }, `${i + 1}限`),
      h('input', {
        type: 'time', class: 'input', 'aria-label': `${i + 1}限の開始時刻`, value: p.start,
        oninput: (e) => { p.start = e.target.value; },
      }),
      h('span', { class: 'muted', 'aria-hidden': 'true' }, '〜'),
      h('input', {
        type: 'time', class: 'input', 'aria-label': `${i + 1}限の終了時刻`, value: p.end,
        oninput: (e) => { p.end = e.target.value; },
      }))));
    renderPeriods();

    const setCount = (n) => {
      while (draft.periods.length < n) {
        const last = draft.periods[draft.periods.length - 1];
        const lastEnd = last ? minutesOf(last.end) ?? minutesOf(last.start) : null;
        const start = lastEnd != null ? lastEnd + 10 : 9 * 60 + 45;
        draft.periods.push({ start: timeOf(start), end: timeOf(start + 50) });
      }
      draft.periods.length = n;
      renderPeriods();
    };
    const countSelect = h('select', {
      class: 'input select', id: 'period-count', value: String(draft.periods.length),
      onchange: (e) => setCount(Number(e.target.value)),
    }, Array.from({ length: S.MAX_PERIODS }, (_, i) => h('option', { value: String(i + 1) }, `${i + 1}限まで`)));

    const save = () => {
      if (!draft.days.length) {
        msg.textContent = '表示する曜日を1つ以上選んでください。';
        msg.hidden = false;
        return;
      }
      const hiddenCount = S.getClasses().filter((c) => c.slots.length &&
        !c.slots.some((s) => draft.days.includes(s.day) && s.period <= draft.periods.length)).length;
      if (hiddenCount && !confirm(`${hiddenCount}件の授業が時間割に表示されなくなります（登録は消えません）。保存しますか？`)) return;
      const next = S.getSettings();
      next.days = DAY_ORDER.filter((d) => draft.days.includes(d));
      next.periods = draft.periods;
      S.saveSettings(next);
      closeDialog();
      toast('時間割の設定を保存しました');
      renderDynamic();
      renderRegDetails();
    };

    showDialog(h('div', { class: 'dialog-inner' },
      dialogHead('曜日と時間の設定'),
      h('p', { class: 'label' }, '表示する曜日'),
      h('div', { class: 'day-checks' }, DAY_ORDER.map((d) => h('label', { class: 'day-check' },
        h('input', {
          type: 'checkbox', checked: draft.days.includes(d),
          onchange: (e) => {
            draft.days = e.target.checked ? draft.days.concat(d) : draft.days.filter((x) => x !== d);
          },
        }),
        h('span', null, DAYS[d])))),
      h('label', { class: 'label', for: 'period-count' }, '時限の数'),
      countSelect,
      h('p', { class: 'label' }, '時限の時間'),
      periodList,
      msg,
      h('div', { class: 'btn-row dialog-foot' },
        h('button', {
          class: 'btn small', type: 'button',
          onclick: () => {
            draft.periods = S.defaultPeriods();
            countSelect.value = String(draft.periods.length);
            renderPeriods();
          },
        }, '時間を初期値に戻す'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'キャンセル'),
        h('button', { class: 'btn primary', type: 'button', onclick: save }, '保存'))));
  }

  // ---------------------------------------------------------------------------
  // 起動
  // ---------------------------------------------------------------------------

  /** 登録内容・履歴が変わったときに描き直す部分（入力中の欄がある登録エリア・名前欄は描き直さない） */
  function renderDynamic() {
    renderTimetableArea();
    renderHistoryArea();
  }

  /** 下にスクロールしたらヘッダーを隠し、上にスクロールしたらまた出す */
  function setupHeaderAutoHide() {
    const header = $('.app-header');
    let lastY = Math.max(window.scrollY, 0);
    let ticking = false;

    const update = () => {
      ticking = false;
      const y = Math.max(window.scrollY, 0); // iPhoneの引っぱりすぎでマイナスになることがある
      const delta = y - lastY;
      if (Math.abs(delta) < 6) return; // 小さな揺れでは切り替えない
      header.classList.toggle('is-hidden', delta > 0 && y > header.offsetHeight);
      lastY = y;
    };

    window.addEventListener('scroll', () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(update);
      }
    }, { passive: true });
    // キーボード操作でヘッダー内のボタンに移ったときは出す
    header.addEventListener('focusin', () => header.classList.remove('is-hidden'));
  }

  function init() {
    applyTheme();
    setupHeaderAutoHide();
    $('#theme-toggle').addEventListener('click', toggleTheme);
    if (darkQuery) {
      const onSystemChange = () => { if (!S.getSettings().theme) applyTheme(); };
      if (darkQuery.addEventListener) darkQuery.addEventListener('change', onSystemChange);
      else if (darkQuery.addListener) darkQuery.addListener(onSystemChange);
    }

    // 背景（ダイアログの外側）をクリックしたら閉じる
    dialogEl.addEventListener('click', (e) => {
      if (e.target === dialogEl) closeDialog();
    });
    dialogEl.addEventListener('close', cleanupDialog);

    renderTimetableArea();
    renderRegisterArea();
    renderProfileArea();
    renderHistoryArea();

    // 日付や「今の時限」の表示が変わったときだけ描き直す
    setInterval(() => {
      const settings = S.getSettings();
      const now = new Date();
      if (`${S.dateKey(now)}|${currentPeriod(settings, now)}` !== state.ttSignature) renderDynamic();
    }, 30 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) renderDynamic();
    });
    // 別のタブで変更されたとき
    window.addEventListener('storage', (e) => {
      if (!e.key || !e.key.startsWith('nko.')) return;
      if (e.key === 'nko.settings') {
        applyTheme();
        renderRegDetails();
      }
      if (e.key === 'nko.profile') $('#profile-name').value = S.getProfile().name;
      renderDynamic();
    });
  }

  init();
})();
