'use strict';
// ═══════════════════════════════════════════════════════════
// 1. 常數
// ═══════════════════════════════════════════════════════════
const VALID_COLORS   = ['green', 'blue', 'orange', 'teal'];
const VALID_TYPES    = ['attraction', 'food', 'hotel', 'transport'];
const VALID_STATUSES = ['booked', 'pending', 'none'];
const VALID_CURRENCY = ['CAD', 'TWD', 'JPY', 'USD', 'EUR'];
const DATE_REGEX     = /^\d{4}-\d{2}-\d{2}$/;
const TIME_REGEX     = /^\d{2}:\d{2}$/;
const TYPE_COLORS    = { attraction:'#4a7c59', food:'#e8a020', hotel:'#8e44ad', transport:'#3b7ecb' };
const TYPE_LABELS    = { attraction:'景點', food:'餐廳', hotel:'住宿', transport:'交通' };
const CURRENCY_SYMBOLS = { TWD:'NT$', JPY:'¥', USD:'$', CAD:'CA$', EUR:'€' };
const WEEKDAYS       = ['日', '一', '二', '三', '四', '五', '六'];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TRIP_PANELS    = ['itinerary', 'booking', 'expense', 'notes', 'members'];
const MEMBER_COLORS  = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c'];

// 景點 Modal 暫存連結列表
let _modalLinks = [];

// ═══════════════════════════════════════════════════════════
// 2. 全域狀態
// ═══════════════════════════════════════════════════════════
const appState = {
  currentTrip: null,
  currentDay: 0,
  editMode: false,
  deletingCard: null,
  currentTab: 'home',
  currentTripTab: 'itinerary',
  lastFbWriteTime: 0,
};

// ═══════════════════════════════════════════════════════════
// 3. DataManager（唯一資料層）
// ═══════════════════════════════════════════════════════════
const DataManager = {
  KEY: 'travel_app_data',
  _data: null,
  _saveTimer: null,

  init() {
    try {
      const raw = localStorage.getItem(this.KEY);
      this._data = raw ? JSON.parse(raw) : { trips: [], packing: [], links: [] };
    } catch (e) {
      this._data = { trips: [], packing: [], links: [] };
    }
    if (!Array.isArray(this._data.trips))   this._data.trips   = [];
    if (!Array.isArray(this._data.packing)) this._data.packing = [];
    if (!Array.isArray(this._data.links))   this._data.links   = [];
  },

  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try { localStorage.setItem(this.KEY, JSON.stringify(this._data)); }
      catch (e) { showToast('儲存失敗，儲存空間可能已滿', 'error'); }
    }, 300);
  },

  getAll()    { return this._data; },
  getTrips()  { return this._data.trips; },
  getTrip(id) { return this._data.trips.find(t => t.id === id) || null; },

  addTrip(trip) { this._data.trips.push(trip); this.save(); },

  updateTrip(id, data) {
    const idx = this._data.trips.findIndex(t => t.id === id);
    if (idx >= 0) {
      this._data.trips[idx] = { ...this._data.trips[idx], ...data };
      this.save();
      _scheduleFbSync(id);
    }
  },

  // Update from Firebase listener — does NOT trigger re-sync (avoids infinite loop)
  updateTripFromFirebase(id, sharedData) {
    const idx = this._data.trips.findIndex(t => t.id === id);
    if (idx >= 0) {
      this._data.trips[idx] = { ...this._data.trips[idx], ...sharedData };
    } else {
      this._data.trips.push({ id, ...sharedData });
    }
    this.save();
  },

  deleteTrip(id) {
    this._data.trips = this._data.trips.filter(t => t.id !== id);
    this.removeMyTripId(id);
    this.save();
  },

  // Device ID
  getDeviceId() {
    let id = localStorage.getItem('travel_device_id');
    if (!id) {
      id = 'dev_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
      localStorage.setItem('travel_device_id', id);
    }
    return id;
  },

  // My trip IDs list (for Firebase-backed trips)
  getMyTripIds() {
    try { return JSON.parse(localStorage.getItem('travel_my_trips') || '[]'); }
    catch (e) { return []; }
  },
  addMyTripId(id) {
    const ids = this.getMyTripIds();
    if (!ids.includes(id)) { ids.push(id); localStorage.setItem('travel_my_trips', JSON.stringify(ids)); }
  },
  removeMyTripId(id) {
    const ids = this.getMyTripIds().filter(i => i !== id);
    localStorage.setItem('travel_my_trips', JSON.stringify(ids));
  },

  // My display name (persists across trips)
  getMyName() { return localStorage.getItem('travel_my_name') || ''; },
  setMyName(name) { if (name) localStorage.setItem('travel_my_name', name); },

  addPackingItem(item) { this._data.packing.push(item); this.save(); },

  togglePackingItem(id) {
    const item = this._data.packing.find(p => p.id === id);
    if (item) { item.checked = !item.checked; this.save(); }
  },

  deletePackingItem(id) { this._data.packing = this._data.packing.filter(p => p.id !== id); this.save(); },

  uncheckAllPacking() {
    this._data.packing.forEach(p => { p.checked = false; });
    this.save();
  },

  exportAll() { return JSON.stringify(this._data, null, 2); },
};

// ═══════════════════════════════════════════════════════════
// 3b. Firebase 輔助 + FirebaseManager
// ═══════════════════════════════════════════════════════════

// Firebase 陣列正規化（Firebase 將 JS 陣列儲存為 {0:…,1:…}，讀回時需還原）
function _fbNormalize(val) {
  if (!val || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(_fbNormalize);
  const keys = Object.keys(val);
  const isArrayLike = keys.length > 0 && keys.every((k, i) => k === String(i));
  if (isArrayLike) return keys.map(k => _fbNormalize(val[k]));
  const result = {};
  keys.forEach(k => { result[k] = _fbNormalize(val[k]); });
  return result;
}

// 從行程物件擷取需要同步到 Firebase shared 的資料
function _getSharedData(trip) {
  return {
    trip_name:    trip.trip_name    || '',
    cover_color:  trip.cover_color  || 'green',
    start_date:   trip.start_date   || '',
    end_date:     trip.end_date     || '',
    members:      trip.members      || [],
    member_notes: trip.member_notes || {},
    days:         trip.days         || [],
    flights:      trip.flights      || [],
    links:        trip.links        || [],
    shopping:     trip.shopping     || [],
    memo:         trip.memo         || '',
    shareCode:    trip.shareCode    || '',
  };
}

// 防抖 Firebase 同步（僅對有 shareCode 的行程同步）
const _fbSyncTimers = {};
async function _syncTripToFirebase(tripId) {
  if (!window.db) return;
  const trip = DataManager.getTrip(tripId);
  if (!trip || !trip.shareCode) return;
  try {
    appState.lastFbWriteTime = Date.now();
    await db.ref(`trips/${tripId}/shared`).set(_getSharedData(trip));
  } catch (_) { /* silent fail */ }
}
function _scheduleFbSync(tripId) {
  clearTimeout(_fbSyncTimers[tripId]);
  _fbSyncTimers[tripId] = setTimeout(() => _syncTripToFirebase(tripId), 600);
}

const FirebaseManager = {
  _listeners: {},
  _presenceInterval: null,

  init() {
    if (!window.firebaseConfig) return;
    if (!firebase.apps.length) firebase.initializeApp(window.firebaseConfig);
    window.db = firebase.database();
  },

  async createTrip(tripData) {
    const shareCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const ref = db.ref('trips').push();
    const tripId = ref.key;
    const deviceId = DataManager.getDeviceId();
    await ref.set({
      meta: {
        trip_name:   tripData.trip_name,
        cover_color: tripData.cover_color,
        start_date:  tripData.start_date,
        end_date:    tripData.end_date,
        shareCode,
        createdAt:   Date.now(),
      },
      shared: _getSharedData({ ...tripData, shareCode }),
      members: {
        [deviceId]: {
          name:     DataManager.getMyName() || (tripData.members && tripData.members[0]) || '我',
          joinedAt: Date.now(),
          color:    MEMBER_COLORS[0],
          lastSeen: Date.now(),
        },
      },
    });
    // 建立分享碼查找表（避免需要 orderByChild 全資料庫掃描）
    await db.ref(`shareCodes/${shareCode}`).set(tripId);
    return { tripId, shareCode };
  },

  async joinTrip(shareCode, memberName) {
    const deviceId = DataManager.getDeviceId();
    const code = shareCode.toUpperCase();
    // 從快速索引表取得 tripId
    const codeSnap = await db.ref(`shareCodes/${code}`).once('value');
    if (!codeSnap.exists()) return null;
    const tripId = codeSnap.val();
    const color = MEMBER_COLORS[Math.floor(Math.random() * MEMBER_COLORS.length)];
    await db.ref(`trips/${tripId}/members/${deviceId}`).set({
      name: memberName, joinedAt: Date.now(), color, lastSeen: Date.now(),
    });
    return tripId;
  },

  // 補建 shareCodes 索引（給在功能上線前建立的舊行程用）
  async ensureShareCodeIndex(tripId, shareCode) {
    if (!shareCode) return;
    const snap = await db.ref(`shareCodes/${shareCode}`).once('value');
    if (!snap.exists()) {
      await db.ref(`shareCodes/${shareCode}`).set(tripId);
    }
  },

  // 即時監聽 members（在線狀態）
  listenMembers(tripId, callback) {
    if (this._memberListeners?.[tripId]) this.offMembers(tripId);
    if (!this._memberListeners) this._memberListeners = {};
    const ref     = db.ref(`trips/${tripId}/members`);
    const handler = ref.on('value', snap => callback(snap.val() || {}));
    this._memberListeners[tripId] = { ref, handler };
  },

  offMembers(tripId) {
    if (this._memberListeners?.[tripId]) {
      const { ref, handler } = this._memberListeners[tripId];
      ref.off('value', handler);
      delete this._memberListeners[tripId];
    }
  },

  async getTripData(tripId) {
    const snap = await db.ref(`trips/${tripId}`).once('value');
    return snap.val();
  },

  listenTrip(tripId, callback) {
    if (this._listeners[tripId]) this.off(tripId);
    const ref     = db.ref(`trips/${tripId}/shared`);
    const handler = ref.on('value', snap => callback(snap.val()));
    this._listeners[tripId] = { ref, handler };
  },

  async updateShared(tripId, path, data) {
    const fullPath = path ? `trips/${tripId}/shared/${path}` : `trips/${tripId}/shared`;
    await db.ref(fullPath).set(data);
  },

  async getMembers(tripId) {
    const snap = await db.ref(`trips/${tripId}/members`).once('value');
    return snap.val() || {};
  },

  updatePresence(tripId) {
    if (!window.db) return;
    const deviceId = DataManager.getDeviceId();
    const myName = DataManager.getMyName();
    const memberRef = db.ref(`trips/${tripId}/members/${deviceId}`);
    // 讀取現有記錄，若 name 是 '我' 或空白則一併修正
    memberRef.once('value').then(snap => {
      const existing = snap.val();
      const updates = { lastSeen: Date.now() };
      if (myName && (!existing || !existing.name || existing.name === '我')) {
        updates.name = myName;
      }
      memberRef.update(updates);
    });
  },

  clearPresence(tripId) {
    if (!window.db) return;
    const deviceId = DataManager.getDeviceId();
    db.ref(`trips/${tripId}/members/${deviceId}/lastSeen`).set(null);
  },

  off(tripId) {
    if (this._listeners[tripId]) {
      const { ref, handler } = this._listeners[tripId];
      ref.off('value', handler);
      delete this._listeners[tripId];
    }
    if (this._presenceInterval) {
      clearInterval(this._presenceInterval);
      this._presenceInterval = null;
    }
  },
};

// ═══════════════════════════════════════════════════════════
// 4. 工具函式
// ═══════════════════════════════════════════════════════════
function encodeHTML(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast show ${type}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2800);
}

function formatDate(str) {
  if (!str) return '';
  const parts = str.split('-');
  if (parts.length !== 3) return str;
  const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  return `${parseInt(parts[1])}/${parseInt(parts[2])}（${WEEKDAYS[d.getDay()]}）`;
}

function formatFullDate(str) {
  if (!str) return '';
  return str.replace(/-/g, '/');
}

function formatShortDate(str) {
  if (!str) return '';
  const parts = str.split('-');
  if (parts.length !== 3) return str;
  return `${parts[0]}/${parseInt(parts[1])}/${parseInt(parts[2])}`;
}

function formatDayDate(str) {
  if (!str || !DATE_REGEX.test(str)) return '';
  const parts = str.split('-');
  const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  return `${parseInt(parts[1])}/${parseInt(parts[2])} ${WEEKDAYS_SHORT[d.getDay()]}`;
}

function typeColor(type) { return TYPE_COLORS[type] || TYPE_COLORS.attraction; }

function genId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function calcTripDays(trip) {
  if (!trip.start_date || !trip.end_date) return trip.days ? trip.days.length : 0;
  const ms = new Date(trip.end_date) - new Date(trip.start_date);
  return Math.max(Math.round(ms / 86400000) + 1, 1);
}

// ═══════════════════════════════════════════════════════════
// 5. JSON 驗證
// ═══════════════════════════════════════════════════════════
function validateTripJSON(raw) {
  let data;
  const errors = [];
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return { ok: false, errors: ['JSON 格式錯誤，請確認語法正確（可用 jsonlint.com 檢查）'] };
  }
  if (!data.trip_name || typeof data.trip_name !== 'string')
    errors.push('缺少必填欄位：trip_name');
  if (!data.start_date || !DATE_REGEX.test(data.start_date))
    errors.push('start_date 格式錯誤，應為 YYYY-MM-DD');
  if (!data.end_date || !DATE_REGEX.test(data.end_date))
    errors.push('end_date 格式錯誤，應為 YYYY-MM-DD');
  if (data.cover_color && !VALID_COLORS.includes(data.cover_color))
    data.cover_color = 'green';
  if (!Array.isArray(data.days) || data.days.length === 0) {
    errors.push('days 必須是非空陣列');
  } else {
    data.days.forEach((day, di) => {
      if (!day.date || !DATE_REGEX.test(day.date))
        errors.push(`days[${di}].date 格式錯誤（應為 YYYY-MM-DD）`);
      if (day.hotel) {
        const h = day.hotel;
        if (!h.name || typeof h.name !== 'string')
          errors.push(`days[${di}].hotel.name 為必填`);
        if (h.status && !VALID_STATUSES.includes(h.status)) h.status = 'none';
        if (h.currency && !VALID_CURRENCY.includes(h.currency)) h.currency = 'TWD';
        if (Array.isArray(h.links)) h.links = h.links.filter(l => l.url && l.url.startsWith('http'));
      }
      if (Array.isArray(day.events)) {
        day.events.forEach((ev, ei) => {
          if (!ev.name || typeof ev.name !== 'string')
            errors.push(`days[${di}].events[${ei}].name 為必填`);
          if (ev.type && !VALID_TYPES.includes(ev.type))   ev.type = 'attraction';
          if (ev.status && !VALID_STATUSES.includes(ev.status)) ev.status = 'none';
          if (ev.currency && !VALID_CURRENCY.includes(ev.currency)) ev.currency = 'TWD';
          if (ev.time && !TIME_REGEX.test(ev.time)) ev.time = null;
          if (ev.url && !ev.url.startsWith('http')) ev.url = null;
          if (Array.isArray(ev.links)) {
            ev.links = ev.links.filter(l => l.url && l.url.startsWith('http'));
          }
        });
      }
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  // Normalize timed event order on import (minimal change: only reposition timed events)
  data.days.forEach(day => { if (Array.isArray(day.events)) _normalizeDayEvents(day.events); });
  return { ok: true, data };
}

// ═══════════════════════════════════════════════════════════
// 6. 頁面切換
// ═══════════════════════════════════════════════════════════
let _currentPageId = 'page-home';

function showPage(toId, direction = 'right') {
  const from = document.getElementById(_currentPageId);
  const to   = document.getElementById(toId);
  if (!from || !to || from === to) return;
  from.classList.add(direction === 'right' ? 'slide-left' : 'hidden');
  to.classList.remove('hidden', 'slide-left');
  _currentPageId = toId;
}

function switchTab(page) {
  const pageId = `page-${page}`;
  document.getElementById('fab-home').classList.add('hidden');
  document.getElementById('fab-add-event').classList.add('hidden');
  document.querySelectorAll('#tab-main .tab-item').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.page === page));
  appState.currentTab = page;
  showPage(pageId, 'none');
  if (page === 'home') {
    document.getElementById('fab-home').classList.remove('hidden');
    renderHome();
  } else if (page === 'packing') {
    renderPacking();
  }
}

function _switchPageDirect(pageId, dir) {
  document.querySelectorAll('.tab-item').forEach(b => b.classList.remove('active'));
  showPage(pageId, dir);
}

// ═══════════════════════════════════════════════════════════
// 7. 首頁
// ═══════════════════════════════════════════════════════════
function renderHome() {
  const trips = DataManager.getTrips();
  const list  = document.getElementById('trips-list');
  const empty = document.getElementById('empty-home');
  list.innerHTML = '';
  if (trips.length === 0) { empty.style.display = 'flex'; return; }
  empty.style.display = 'none';
  trips.forEach(trip => {
    const el = document.createElement('div');
    el.innerHTML = buildTripCardHTML(trip);
    const card = el.firstElementChild;
    list.appendChild(card);
    bindTripCardEvents(card, trip.id);
  });
}

function buildTripCardHTML(trip) {
  const color   = VALID_COLORS.includes(trip.cover_color) ? trip.cover_color : 'green';
  const days    = calcTripDays(trip);
  const start   = trip.start_date ? formatShortDate(trip.start_date) : '';
  const end     = trip.end_date   ? formatShortDate(trip.end_date)   : '';
  const members = Array.isArray(trip.members) ? trip.members : [];
  const avatarsHTML = members.slice(0, 4).map(m =>
    `<div class="member-avatar">${encodeHTML(m.charAt(0).toUpperCase())}</div>`
  ).join('');

  return `
  <div class="trip-card" data-trip-id="${encodeHTML(trip.id)}">
    <div class="trip-banner ${encodeHTML(color)}">
      <div class="trip-title">${encodeHTML(trip.trip_name)}</div>
      <div class="trip-days">${days} 天行程</div>
    </div>
    <div class="trip-meta">
      <div class="trip-date">${encodeHTML(start)} → ${encodeHTML(end)}</div>
      <div class="member-avatars">${avatarsHTML}</div>
    </div>
    <div class="delete-confirm">
      <button class="btn-delete-confirm" data-del-id="${encodeHTML(trip.id)}">🗑 刪除此行程</button>
      <button class="btn-cancel-delete">取消</button>
    </div>
  </div>`;
}

function bindTripCardEvents(card, tripId) {
  let longPressTimer = null;
  const startLP  = () => { longPressTimer = setTimeout(() => showDeleteConfirm(tripId), 500); };
  const cancelLP = () => clearTimeout(longPressTimer);

  card.addEventListener('touchstart',  startLP,  { passive: true });
  card.addEventListener('touchend',    cancelLP);
  card.addEventListener('touchcancel', cancelLP);
  card.addEventListener('mousedown',   startLP);
  card.addEventListener('mouseup',     cancelLP);
  card.addEventListener('mouseleave',  cancelLP);

  card.addEventListener('click', (e) => {
    if (e.target.closest('.delete-confirm')) return;
    if (appState.deletingCard === tripId) { hideDeleteConfirm(); return; }
    openTrip(tripId);
  });
  card.querySelector('.btn-delete-confirm').addEventListener('click', (e) => {
    e.stopPropagation(); confirmDeleteTrip(tripId);
  });
  card.querySelector('.btn-cancel-delete').addEventListener('click', (e) => {
    e.stopPropagation(); hideDeleteConfirm();
  });
}

function showDeleteConfirm(tripId) {
  hideDeleteConfirm();
  appState.deletingCard = tripId;
  const card = document.querySelector(`[data-trip-id="${tripId}"]`);
  if (card) card.querySelector('.delete-confirm').classList.add('show');
}

function hideDeleteConfirm() {
  if (appState.deletingCard) {
    const card = document.querySelector(`[data-trip-id="${appState.deletingCard}"]`);
    if (card) card.querySelector('.delete-confirm').classList.remove('show');
    appState.deletingCard = null;
  }
}

function confirmDeleteTrip(tripId) {
  const trip = DataManager.getTrip(tripId);
  const name = trip ? trip.trip_name : '此行程';
  DataManager.deleteTrip(tripId);
  hideDeleteConfirm();
  showToast(`已刪除「${name}」`);
  renderHome();
}

function openJoinTripModal() {
  if (!window.db) {
    showToast('需要網路連線才能加入行程', 'error');
    return;
  }
  openModal(`
    <div class="modal-title">加入行程 <button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="form-group"><label>分享碼</label>
      <input id="join-share-code" type="text" maxlength="8"
        style="text-transform:uppercase;letter-spacing:4px;font-size:22px;text-align:center;font-weight:700" /></div>
    <div class="form-group"><label>你的名字</label>
      <input id="join-member-name" type="text" maxlength="20" /></div>
    <button class="btn-submit" id="btn-join-submit" onclick="handleJoinTrip()">加入行程</button>
    <button class="btn-submit" style="background:var(--muted);margin-top:8px" onclick="closeModal()">取消</button>
  `);
  setTimeout(() => document.getElementById('join-share-code')?.focus(), 100);
}

async function handleJoinTrip() {
  const code = document.getElementById('join-share-code').value.trim().toUpperCase();
  const name = document.getElementById('join-member-name').value.trim();
  if (!code || code.length < 4) { showToast('請輸入分享碼', 'error'); return; }
  if (!name) { showToast('請輸入你的名字', 'error'); return; }
  DataManager.setMyName(name);

  const btn = document.getElementById('btn-join-submit');
  if (btn) { btn.disabled = true; btn.textContent = '加入中…'; }

  try {
    const tripId = await FirebaseManager.joinTrip(code, name);
    if (!tripId) {
      showToast('找不到此分享碼，請確認後重試', 'error');
      if (btn) { btn.disabled = false; btn.textContent = '加入行程'; }
      return;
    }

    const fbData = await FirebaseManager.getTripData(tripId);
    if (!fbData) { showToast('無法取得行程資料', 'error'); return; }

    const shared  = _fbNormalize(fbData.shared || {});
    const meta    = fbData.meta || {};
    const tripObj = { id: tripId, shareCode: meta.shareCode || code, ...meta, ...shared };

    if (!DataManager.getTrip(tripId)) DataManager.addTrip(tripObj);
    else DataManager.updateTripFromFirebase(tripId, { ...meta, ...shared });
    DataManager.addMyTripId(tripId);

    // 把自己的名字加入 shared.members（讓記帳、其他地方也能看到）
    const currentMembers = Array.isArray(shared.members) ? shared.members : [];
    if (!currentMembers.includes(name)) {
      await db.ref(`trips/${tripId}/shared/members`).set([...currentMembers, name]);
    }

    closeModal();
    showToast(`✅ 已加入「${tripObj.trip_name || '行程'}」！`);
    renderHome();
  } catch (e) {
    console.error('handleJoinTrip error:', e);
    const msg = e?.message || '';
    const hint = msg.includes('PERMISSION_DENIED')
      ? '權限不足，請確認 Firebase 規則設定'
      : msg || '請檢查網路連線';
    showToast(`加入失敗：${hint}`, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '加入行程'; }
  }
}

function openAddTripModal() {
  const html = `
    <div class="modal-title">新增行程 <button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="form-group"><label>你的名字 *</label>
      <input id="f-creator-name" type="text" placeholder="例：小明" maxlength="20" /></div>
    <div class="form-group"><label>行程名稱 *</label>
      <input id="f-trip-name" type="text" placeholder="例：東京 5 日遊" maxlength="50" /></div>
    <div class="form-group"><label>出發日期 *</label>
      <input id="f-start" type="date" /></div>
    <div class="form-group"><label>結束日期 *</label>
      <input id="f-end" type="date" /></div>
    <div class="form-group"><label>封面顏色</label>
      <div class="color-picker" id="color-picker">
        <div class="color-dot green selected" data-color="green" onclick="selectColor(this)"></div>
        <div class="color-dot blue" data-color="blue" onclick="selectColor(this)"></div>
        <div class="color-dot orange" data-color="orange" onclick="selectColor(this)"></div>
        <div class="color-dot teal" data-color="teal" onclick="selectColor(this)"></div>
      </div></div>
    <div class="form-group"><label>其他成員（逗號分隔，可留空）</label>
      <input id="f-members" type="text" placeholder="例：阿花,老王" /></div>
    <button class="btn-submit" onclick="createTrip()">建立行程</button>
  `;
  openModal(html);
}

function selectColor(el) {
  document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('selected'));
  el.classList.add('selected');
}

async function createTrip() {
  const creatorName = document.getElementById('f-creator-name').value.trim();
  const name        = document.getElementById('f-trip-name').value.trim();
  const start       = document.getElementById('f-start').value;
  const end         = document.getElementById('f-end').value;
  const colorEl     = document.querySelector('.color-dot.selected');
  const color       = colorEl ? colorEl.dataset.color : 'green';
  const membersRaw  = document.getElementById('f-members').value;
  const otherMembers = membersRaw.split(',').map(s => s.trim()).filter(Boolean);
  const members     = [creatorName, ...otherMembers];

  if (!creatorName) { showToast('請輸入你的名字', 'error'); return; }
  if (!name)  { showToast('請輸入行程名稱', 'error'); return; }
  DataManager.setMyName(creatorName);
  if (!start || !DATE_REGEX.test(start)) { showToast('請選擇出發日期', 'error'); return; }
  if (!end   || !DATE_REGEX.test(end))   { showToast('請選擇結束日期', 'error'); return; }
  if (end < start) { showToast('結束日期不能早於出發日期', 'error'); return; }

  const days = buildDaysFromRange(start, end);
  const tripData = { trip_name: name, cover_color: color, start_date: start, end_date: end, members, days };

  if (window.db) {
    const btn = document.querySelector('#modal-content .btn-submit');
    if (btn) { btn.disabled = true; btn.textContent = '建立中…'; }
    try {
      const { tripId, shareCode } = await FirebaseManager.createTrip(tripData);
      const trip = { id: tripId, shareCode, ...tripData };
      DataManager.addTrip(trip);
      DataManager.addMyTripId(tripId);
      closeModal();
      renderHome();
      _showShareCodeModal(tripId, shareCode, name);
    } catch (e) {
      showToast('建立失敗，請檢查網路連線', 'error');
      if (btn) { btn.disabled = false; btn.textContent = '建立行程'; }
    }
  } else {
    const trip = { id: genId('trip'), ...tripData };
    DataManager.addTrip(trip);
    closeModal();
    showToast(`✅ 已新增「${name}」`);
    renderHome();
  }
}

function _showShareCodeModal(_tripId, shareCode, tripName) {
  openModal(`
    <div class="modal-title">行程已建立！ <button class="modal-close" onclick="closeModal()">✕</button></div>
    <p style="font-size:14px;color:var(--muted);margin-bottom:16px">把分享碼給旅伴，讓他們加入「${encodeHTML(tripName)}」</p>
    <div class="share-code-display">
      <div class="share-code-value" id="share-code-value">${encodeHTML(shareCode)}</div>
      <button class="btn-copy-share" onclick="document.getElementById('share-code-value').textContent && navigator.clipboard.writeText(document.getElementById('share-code-value').textContent).then(()=>showToast('已複製分享碼！'))">複製</button>
    </div>
    <button class="btn-submit" style="margin-top:16px" onclick="closeModal()">好的</button>
  `);
}

function buildDaysFromRange(start, end) {
  const days = [];
  let cur = new Date(start);
  const last = new Date(end);
  while (cur <= last) {
    const dateStr = cur.toISOString().slice(0, 10);
    days.push({ date: dateStr, label: '', events: [] });
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

function onJSONFileSelected(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  handleJSONImport(file);
}

async function handleJSONImport(file) {
  let raw;
  try { raw = await file.text(); }
  catch (e) { showToast('讀取檔案失敗', 'error'); return; }

  // Detect backup format { trips: [...], packing: [], links: [] }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) {
    showToast('JSON 格式錯誤，請確認語法正確', 'error'); return;
  }
  if (Array.isArray(parsed.trips)) {
    importBackupFile(parsed); return;
  }

  // Single trip format
  const result = validateTripJSON(raw);
  if (!result.ok) {
    showToast(`匯入失敗：${result.errors[0]}`, 'error');
    showImportErrors(result.errors);
    return;
  }
  const trip = { id: genId('trip'), ...result.data };
  DataManager.addTrip(trip);
  showToast(`✅ 已匯入「${trip.trip_name}」`);
  renderHome();
}

function importBackupFile(backup) {
  const trips = Array.isArray(backup.trips) ? backup.trips : [];
  if (trips.length === 0) { showToast('備份檔案中沒有行程', 'error'); return; }

  const existingIds = new Set(DataManager.getTrips().map(t => t.id));
  let imported = 0;
  let skipped  = 0;

  trips.forEach(t => {
    if (!t.trip_name) { skipped++; return; }
    // Avoid id collision with existing trips
    const trip = existingIds.has(t.id) ? { ...t, id: genId('trip') } : t;
    DataManager.addTrip(trip);
    existingIds.add(trip.id);
    imported++;
  });

  if (imported === 0) { showToast('沒有可匯入的行程', 'error'); return; }
  showToast(`✅ 已匯入 ${imported} 個行程${skipped > 0 ? `（略過 ${skipped} 筆無效資料）` : ''}`);
  renderHome();
}

function showImportErrors(errors) {
  const listHTML = errors.map(e => `<li>${encodeHTML(e)}</li>`).join('');
  openModal(`
    <div class="modal-title">匯入錯誤 <button class="modal-close" onclick="closeModal()">✕</button></div>
    <p style="font-size:14px;color:var(--muted);margin-bottom:12px">請修正以下問題後重新匯入：</p>
    <ul class="error-list">${listHTML}</ul>
    <button class="btn-submit" onclick="closeModal()">關閉</button>
  `);
}

function showImportHelper() {
  const prompt = `請幫我把以下旅遊行程整理成 JSON 格式，格式規範如下：

頂層欄位：
- trip_name（字串，必填）
- cover_color（"green"/"blue"/"orange"/"teal"）
- start_date、end_date（YYYY-MM-DD 格式）
- members（字串陣列）
- days（陣列）

每個 day：date（YYYY-MM-DD）、label（地區名稱）、events（陣列）

每個 event：
- name（必填）、time（HH:MM）
- type（attraction/food/hotel/transport）
- status（booked/pending/none）
- cost（數字）、currency（CAD/TWD/JPY/USD）
- note、url、address、drive_mins（數字）、plan_b（備案說明）

只輸出 JSON，不要任何說明文字。

以下是我的行程內容：
（貼上你的行程筆記）`;

  openModal(`
    <div class="modal-title">匯入說明 <button class="modal-close" onclick="closeModal()">✕</button></div>
    <p style="font-size:14px;margin-bottom:12px">把行程筆記貼給 AI，讓它幫你生成 JSON 後上傳匯入。</p>
    <div class="form-group">
      <label>AI Prompt 範本（複製後貼給 ChatGPT/Gemini）</label>
      <div class="prompt-box" id="prompt-box">${encodeHTML(prompt)}</div>
      <button class="btn-submit" style="margin-top:4px" onclick="copyPrompt()">📋 複製 Prompt</button>
    </div>
    <button class="btn-submit" style="background:var(--blue);margin-top:8px" onclick="downloadExampleJSON()">⬇ 下載範例 JSON</button>
    <button class="btn-submit" style="background:var(--muted);margin-top:8px" onclick="closeModal()">關閉</button>
  `);
}

function copyPrompt() {
  const el = document.getElementById('prompt-box');
  navigator.clipboard.writeText(el.textContent).then(() => showToast('已複製 Prompt！'));
}

function downloadExampleJSON() {
  const example = {
    trip_name: '我的旅遊行程', cover_color: 'green',
    start_date: '2025-10-01', end_date: '2025-10-02',
    members: ['小明', '阿花'],
    days: [
      { date: '2025-10-01', label: '東京', events: [
        { time:'09:00', name:'淺草寺', type:'attraction', status:'none', address:'東京都台東區淺草2-3-1', note:'人多建議早去' },
        { time:'12:00', name:'壽司大（午餐）', type:'food', cost:3000, currency:'JPY', drive_mins:20 },
      ], hotel: { name:'東橫INN淺草橋', status:'booked', note:'門鎖密碼：1234，check-in 15:00' } },
      { date: '2025-10-02', label: '東京', events: [
        { time:'10:00', name:'teamLab Borderless', type:'attraction', status:'booked', cost:3200, currency:'JPY', url:'https://borderless.teamlab.art/', plan_b:'若售罄可改 teamLab Planets' },
      ]},
    ],
  };
  const blob = new Blob([JSON.stringify(example, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'travel-example.json'; a.click();
  URL.revokeObjectURL(url);
}

// ═══════════════════════════════════════════════════════════
// 8. 行程詳情頁
// ═══════════════════════════════════════════════════════════
function openTrip(tripId) {
  appState.currentTrip    = tripId;
  appState.currentDay     = 0;
  appState.editMode       = false;
  appState.currentTripTab = 'itinerary';

  document.getElementById('tab-main').style.display = 'none';
  document.getElementById('tab-trip').style.display = 'flex';

  document.querySelectorAll('#tab-trip .tab-item').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.tab === 'itinerary'));

  TRIP_PANELS.forEach(t =>
    document.getElementById(`trip-panel-${t}`).classList.toggle('hidden', t !== 'itinerary'));

  document.getElementById('fab-home').classList.add('hidden');
  document.getElementById('fab-add-event').classList.add('hidden');

  renderDetail();
  updateTripBookingBadge();
  _switchPageDirect('page-detail', 'right');

  // Firebase: 補建 shareCodes 索引（舊行程相容）、即時監聽、在線狀態
  if (window.db) {
    const trip = DataManager.getTrip(tripId);
    if (trip?.shareCode) FirebaseManager.ensureShareCodeIndex(tripId, trip.shareCode).catch(() => {});
    FirebaseManager.listenTrip(tripId, (sharedData) => {
      if (!sharedData) return;
      // 若是自己剛寫入的（2 秒內），不重繪避免閃爍
      if (Date.now() - appState.lastFbWriteTime < 2000) return;
      const normalized = _fbNormalize(sharedData);
      DataManager.updateTripFromFirebase(tripId, normalized);
      if (appState.currentTrip !== tripId) return;
      renderDetail();
      if (appState.currentTripTab === 'booking')  renderTripBooking();
      else if (appState.currentTripTab === 'expense') renderTripExpense();
      else if (appState.currentTripTab === 'notes')   renderTripNotes();
      updateTripBookingBadge();
    });
    FirebaseManager.updatePresence(tripId);
    FirebaseManager._presenceInterval = setInterval(() => {
      if (appState.currentTrip === tripId) FirebaseManager.updatePresence(tripId);
    }, 15000);  // 15 秒更新一次，搭配 60 秒門檻

    // 即時監聽 members，成員頁自動刷新在線狀態
    FirebaseManager.listenMembers(tripId, (fbMembers) => {
      if (appState.currentTrip !== tripId) return;
      if (appState.currentTripTab === 'members') {
        const trip = DataManager.getTrip(tripId);
        if (trip) _renderMembersHTML(
          document.getElementById('trip-members-content'), trip, fbMembers
        );
      }
    });
  }
}

function goHome() {
  const leavingTripId = appState.currentTrip;
  appState.editMode       = false;
  appState.currentTripTab = null;

  document.getElementById('tab-trip').style.display = 'none';
  document.getElementById('tab-main').style.display = 'flex';

  document.getElementById('fab-add-event').classList.add('hidden');
  _switchPageDirect('page-home', 'left');
  document.getElementById('fab-home').classList.remove('hidden');
  document.querySelectorAll('#tab-main .tab-item').forEach(b =>
    b.classList.toggle('active', b.dataset.page === 'home'));
  renderHome();

  // Firebase: 清除在線狀態 + 取消監聽
  if (window.db && leavingTripId) {
    FirebaseManager.clearPresence(leavingTripId);
    FirebaseManager.off(leavingTripId);
    FirebaseManager.offMembers(leavingTripId);
  }
}

function switchTripTab(tab) {
  appState.currentTripTab = tab;

  document.querySelectorAll('#tab-trip .tab-item').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.tab === tab));

  TRIP_PANELS.forEach(t =>
    document.getElementById(`trip-panel-${t}`).classList.toggle('hidden', t !== tab));

  const fab = document.getElementById('fab-add-event');
  fab.classList.toggle('hidden', tab !== 'itinerary' || !appState.editMode);

  document.getElementById('page-detail').scrollTop = 0;

  if (tab === 'booking') renderTripBooking();
  else if (tab === 'expense') renderTripExpense();
  else if (tab === 'notes')   renderTripNotes();
  else if (tab === 'members') renderTripMembers();
}

function renderDetail() {
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) { goHome(); return; }

  document.getElementById('detail-title').textContent = trip.trip_name;
  document.getElementById('detail-dates').textContent =
    `${formatFullDate(trip.start_date)} → ${formatFullDate(trip.end_date)}`;

  renderModebar();
  renderDayButtons(trip);

  const day    = trip.days[appState.currentDay];
  const events = day ? (day.events || []) : [];
  renderWeather(day);
  renderEventsList(events);
  renderDriveWarning(events);
  renderHotelBar(day);
  renderDayTitle(day);
}

function editTripTitle() {
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) return;
  const titleEl = document.getElementById('detail-title');
  const current = trip.trip_name;

  titleEl.outerHTML = `<input id="detail-title-input" class="detail-title-input"
    type="text" value="${encodeHTML(current)}" maxlength="60"
    onblur="saveTripTitle(this.value)"
    onkeydown="if(event.key==='Enter')this.blur()" />`;

  const input = document.getElementById('detail-title-input');
  input.focus();
  input.select();
}

function saveTripTitle(newName) {
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) return;
  const name = newName.trim() || trip.trip_name;
  trip.trip_name = name;
  DataManager.updateTrip(trip.id, trip);
  const input = document.getElementById('detail-title-input');
  if (input) {
    const div = document.createElement('div');
    div.className = 'detail-title';
    div.id = 'detail-title';
    div.setAttribute('onclick', 'editTripTitle()');
    div.title = '點擊編輯';
    div.textContent = name;
    input.replaceWith(div);
  }
}

function renderDayTitle(day) {
  const el = document.getElementById('day-label-text');
  if (!el) return;
  el.textContent = day && day.label ? day.label : '';
}

function editDayLabel() {
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) return;
  const day = trip.days[appState.currentDay];
  if (!day) return;
  const el = document.getElementById('day-label-text');
  if (!el) return;
  el.outerHTML = `<input id="day-label-input" class="day-label-input"
    type="text" value="${encodeHTML(day.label || '')}" maxlength="20"
    placeholder="日期標題（例：東京）"
    onblur="saveDayLabel(this.value)"
    onkeydown="if(event.key==='Enter')this.blur()" />`;
  const input = document.getElementById('day-label-input');
  if (input) { input.focus(); input.select(); }
}

function saveDayLabel(value) {
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) return;
  const day = trip.days[appState.currentDay];
  if (!day) return;
  day.label = value.trim();
  DataManager.updateTrip(trip.id, trip);
  const input = document.getElementById('day-label-input');
  if (input) {
    const div = document.createElement('div');
    div.id = 'day-label-text';
    div.className = 'day-label-text';
    div.setAttribute('onclick', 'editDayLabel()');
    div.textContent = day.label;
    input.replaceWith(div);
  }
  renderDayButtons(trip);
}

function renderModebar() {
  const bar  = document.getElementById('mode-bar');
  const icon = document.getElementById('mode-icon');
  const text = document.getElementById('mode-text');
  const btn  = document.getElementById('mode-btn');
  if (appState.editMode) {
    bar.classList.add('edit');
    icon.textContent = '🔓'; text.textContent = '編輯中'; btn.textContent = '完成編輯';
  } else {
    bar.classList.remove('edit');
    icon.textContent = '🔒'; text.textContent = '目前為瀏覽模式'; btn.textContent = '解鎖編輯';
  }
}

function toggleEditMode() {
  appState.editMode = !appState.editMode;
  renderModebar();
  const trip   = DataManager.getTrip(appState.currentTrip);
  const day    = trip ? trip.days[appState.currentDay] : null;
  const events = day ? (day.events || []) : [];
  renderEventsList(events);
  renderHotelBar(day);
  if (trip) renderDayButtons(trip);
  const fab = document.getElementById('fab-add-event');
  fab.classList.toggle('hidden', !appState.editMode);
}

function renderDayButtons(trip) {
  const scroll = document.getElementById('days-scroll');
  scroll.innerHTML = '';
  (trip.days || []).forEach((day, i) => {
    const btn = document.createElement('button');
    btn.className = `day-btn${i === appState.currentDay ? ' active' : ''}`;
    btn.dataset.dayIdx = i;
    const dateLabel = formatDayDate(day.date);
    btn.innerHTML = `<span class="day-btn-num">Day ${i + 1}</span>${dateLabel ? `<span class="day-btn-date">${encodeHTML(dateLabel)}</span>` : ''}`;
    btn.addEventListener('click', () => switchDay(i));
    scroll.appendChild(btn);
  });
  if (appState.editMode) {
    const addBtn = document.createElement('button');
    addBtn.className = 'day-btn-add';
    addBtn.innerHTML = '<span class="day-btn-num">＋ Day</span>';
    addBtn.addEventListener('click', addNewDay);
    scroll.appendChild(addBtn);
  }
}

function addNewDay() {
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) return;
  const days = trip.days || [];
  const lastDay = days[days.length - 1];
  let nextDate = '';
  if (lastDay?.date && DATE_REGEX.test(lastDay.date)) {
    const d = new Date(lastDay.date);
    d.setDate(d.getDate() + 1);
    nextDate = d.toISOString().slice(0, 10);
    trip.end_date = nextDate;
    document.getElementById('detail-dates').textContent =
      `${formatFullDate(trip.start_date)} → ${formatFullDate(trip.end_date)}`;
  }
  trip.days.push({ date: nextDate, label: '', events: [] });
  DataManager.updateTrip(trip.id, trip);
  appState.currentDay = trip.days.length - 1;
  renderDayButtons(trip);
  switchDay(appState.currentDay);
  showToast(`✅ 已新增 Day ${trip.days.length}`);
  // 捲動至新 Day 按鈕
  setTimeout(() => {
    const activeBtn = document.querySelector('#days-scroll .day-btn.active');
    if (activeBtn) activeBtn.scrollIntoView({ inline: 'nearest', behavior: 'smooth' });
  }, 50);
}

function switchDay(index) {
  appState.currentDay = index;
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) return;
  document.querySelectorAll('#days-scroll .day-btn').forEach(b =>
    b.classList.toggle('active', parseInt(b.dataset.dayIdx) === index));
  const day    = trip.days[index];
  const events = day ? (day.events || []) : [];
  renderWeather(day);
  renderEventsList(events);
  renderDriveWarning(events);
  renderHotelBar(day);
  renderDayTitle(day);
}

function renderMembers(trip) {
  const bar = document.getElementById('members-bar');
  if (!bar) return;
  const members = Array.isArray(trip.members) ? trip.members : [];
  if (members.length === 0) { bar.innerHTML = ''; return; }
  bar.innerHTML = members.map(m => `
    <div class="member-chip">
      <div class="member-chip-avatar">${encodeHTML(m.charAt(0).toUpperCase())}</div>
      <span>${encodeHTML(m)}</span>
    </div>`).join('');
}

// ── 天氣 ──────────────────────────────────────────────────
const _weatherGeoCache  = {};
const _weatherDataCache = {};

function _getWeatherIcon(wmoCode) {
  if (wmoCode === 0) return '☀️';
  if (wmoCode <= 2)  return '🌤️';
  if (wmoCode <= 3)  return '⛅';
  if (wmoCode <= 48) return '🌫️';
  if (wmoCode <= 57) return '🌦️';
  if (wmoCode <= 67) return '🌧️';
  if (wmoCode <= 77) return '🌨️';
  if (wmoCode <= 82) return '🌧️';
  if (wmoCode <= 99) return '⛈️';
  return '🌡️';
}

function _getOutfitTip(tempMax, rainProb) {
  if (rainProb >= 60) return '帶雨傘，防水外套';
  if (tempMax >= 28)  return '輕薄舒適，防曬必備';
  if (tempMax >= 22)  return 'T-shirt + 薄外套';
  if (tempMax >= 15)  return '建議帶薄外套';
  return '注意保暖，多帶一件';
}

function _buildWeatherHTML(w, isReal) {
  return `
    <div class="weather-card">
      <span class="weather-icon">${w.icon}</span>
      <div class="weather-info">
        <div class="weather-rain">降雨機率 ${w.rain}</div>
        <div class="weather-outfit">${encodeHTML(w.outfit)}</div>
        ${isReal ? `<div class="weather-source">Open-Meteo</div>` : ''}
      </div>
      <div class="weather-temps">
        <div class="weather-temp-high">${w.tempHigh}</div>
        <div class="weather-temp-low">${w.tempLow}</div>
      </div>
    </div>`;
}

function _getSimulatedWeather(day) {
  const seed = new Date(day.date).getDay();
  const data = [
    { icon:'☀️',  tempHigh:'26°C', tempLow:'19°C', rain:'5%',  outfit:'輕薄舒適，防曬必備' },
    { icon:'⛅',  tempHigh:'22°C', tempLow:'16°C', rain:'30%', outfit:'建議帶薄外套' },
    { icon:'🌧️', tempHigh:'18°C', tempLow:'14°C', rain:'80%', outfit:'帶雨傘，防水外套' },
    { icon:'🌤️', tempHigh:'24°C', tempLow:'17°C', rain:'15%', outfit:'T-shirt + 薄外套' },
  ];
  return data[seed % data.length];
}

async function _fetchWeatherForTrip(trip, day) {
  const bar = document.getElementById('weather-bar');
  if (!bar) return;

  const cityName = day.label || trip.trip_name || '';
  const cacheKey = cityName.toLowerCase().trim();

  let lat, lon;
  if (_weatherGeoCache[cacheKey]) {
    ({ lat, lon } = _weatherGeoCache[cacheKey]);
  } else if (cacheKey) {
    try {
      const geoRes = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cacheKey)}&count=1&language=zh&format=json`,
        { signal: AbortSignal.timeout(5000) }
      );
      const geoData = await geoRes.json();
      if (geoData.results && geoData.results.length > 0) {
        lat = geoData.results[0].latitude;
        lon = geoData.results[0].longitude;
        _weatherGeoCache[cacheKey] = { lat, lon };
      }
    } catch (_) { /* ignore */ }
  }

  if (!lat || !lon) {
    bar.innerHTML = _buildWeatherHTML(_getSimulatedWeather(day), false);
    return;
  }

  const dataCacheKey = `${lat},${lon},${day.date}`;
  let w;
  if (_weatherDataCache[dataCacheKey]) {
    w = _weatherDataCache[dataCacheKey];
  } else {
    try {
      const wRes = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode&timezone=auto&start_date=${day.date}&end_date=${day.date}`,
        { signal: AbortSignal.timeout(5000) }
      );
      const wData = await wRes.json();
      if (wData.daily && wData.daily.temperature_2m_max) {
        const tempMax  = Math.round(wData.daily.temperature_2m_max[0]);
        const tempMin  = Math.round(wData.daily.temperature_2m_min[0]);
        const rainProb = wData.daily.precipitation_probability_max[0] || 0;
        const wmoCode  = wData.daily.weathercode[0] || 0;
        w = {
          icon:     _getWeatherIcon(wmoCode),
          tempHigh: `${tempMax}°C`,
          tempLow:  `${tempMin}°C`,
          rain:     `${rainProb}%`,
          outfit:   _getOutfitTip(tempMax, rainProb),
        };
        _weatherDataCache[dataCacheKey] = w;
      }
    } catch (_) { /* ignore */ }
  }

  if (!w) {
    bar.innerHTML = _buildWeatherHTML(_getSimulatedWeather(day), false);
    return;
  }
  bar.innerHTML = _buildWeatherHTML(w, true);
}

function renderWeather(day) {
  const bar = document.getElementById('weather-bar');
  if (!bar) return;
  if (!day) { bar.innerHTML = ''; return; }
  bar.innerHTML = _buildWeatherHTML(_getSimulatedWeather(day), false);
  const trip = DataManager.getTrip(appState.currentTrip);
  if (trip && day.date) _fetchWeatherForTrip(trip, day);
}

function renderDriveWarning(events) {
  const el    = document.getElementById('drive-warning');
  const total = events.reduce((sum, e) => sum + (Number(e.drive_mins) || 0), 0);
  if (total < 240) { el.innerHTML = ''; return; }
  const h = Math.floor(total / 60), m = total % 60;
  el.innerHTML = `<div class="drive-warning">⚠️ 今日開車時間約 ${h}小時${m > 0 ? m + '分' : ''}，行程較緊湊</div>`;
}

// ── 住宿 Bar ──────────────────────────────────────────────
function renderHotelBar(day) {
  const el = document.getElementById('hotel-bar');
  if (!el) return;
  const hotel = day && day.hotel
    ? day.hotel
    : (day ? (day.events || []).find(e => e.type === 'hotel') || null : null);

  if (!hotel) {
    el.innerHTML = appState.editMode && day
      ? `<button class="hotel-bar-add-btn" onclick="openEditHotelModal()"><span>🏠</span> 設定今晚住宿</button>`
      : '';
    renderDeleteDayBar();
    return;
  }

  let bodyContent = '';
  if (hotel.note) bodyContent += `<p class="event-note">${encodeHTML(hotel.note)}</p>`;
  const hotelLinks = Array.isArray(hotel.links) && hotel.links.length > 0
    ? hotel.links
    : (hotel.url ? [{ label: hotel.url_title || hotel.url, url: hotel.url }] : []);
  hotelLinks.forEach(l => {
    bodyContent += `<a class="event-link" href="${encodeHTML(l.url)}" target="_blank" rel="noopener">🔗 ${encodeHTML(l.label || l.url)}</a>`;
  });
  if (hotel.address) {
    const mapsUrl = `https://maps.google.com?q=${encodeURIComponent(hotel.address)}`;
    bodyContent += `<a class="map-link" href="${encodeHTML(mapsUrl)}" target="_blank" rel="noopener">🗺️ 開啟地圖</a>`;
  }
  if (hotel.cost && hotel.cost > 0) {
    const sym = CURRENCY_SYMBOLS[hotel.currency] || '';
    bodyContent += `<div class="event-cost">💰 ${sym}${hotel.cost}</div>`;
  }
  if (!bodyContent) bodyContent = '<span style="font-size:13px;color:var(--muted)">無備註</span>';

  if (appState.editMode) {
    el.innerHTML = `
      <div class="hotel-bar-header">
        <span style="font-size:18px">🏠</span>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:14px">${encodeHTML(hotel.name)}</div>
          <div style="font-size:12px;color:var(--muted)">今晚住宿</div>
        </div>
        <div class="edit-actions">
          <button class="edit-icon-btn" onclick="openEditHotelModal()" title="編輯">✏️</button>
          <button class="edit-icon-btn del" onclick="deleteHotelData()" title="移除住宿">🗑</button>
        </div>
      </div>`;
  } else {
    el.innerHTML = `
      <div class="hotel-bar-header" id="hotel-bar-header" onclick="toggleHotelBar()">
        <span style="font-size:18px">🏠</span>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:14px">${encodeHTML(hotel.name)}</div>
          <div style="font-size:12px;color:var(--muted)">今晚住宿</div>
        </div>
        <span class="hotel-arrow" id="hotel-arrow">▾</span>
      </div>
      <div class="hotel-bar-body" id="hotel-bar-body">
        <div class="hotel-bar-body-inner">${bodyContent}</div>
      </div>`;
  }
  renderDeleteDayBar();
}

function renderDeleteDayBar() {
  const el = document.getElementById('delete-day-bar');
  if (!el) return;
  if (!appState.editMode) { el.innerHTML = ''; return; }
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip || (trip.days || []).length <= 1) { el.innerHTML = ''; return; }
  el.innerHTML = `<button class="btn-delete-day" onclick="confirmDeleteDay()">🗑 刪除本日行程</button>`;
}

function confirmDeleteDay() {
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) return;
  const day = trip.days[appState.currentDay];
  const label = day.label ? `「${encodeHTML(day.label)}」` : `Day ${appState.currentDay + 1}`;
  openModal(`
    <div class="modal-title">刪除行程日 <button class="modal-close" onclick="closeModal()">✕</button></div>
    <p style="font-size:14px;color:var(--muted);margin-bottom:16px">確定刪除 ${label} 及其所有景點嗎？此操作無法復原。</p>
    <button class="btn-submit" style="background:var(--danger)" onclick="executeDeleteDay()">確定刪除</button>
    <button class="btn-submit" style="background:var(--muted);margin-top:8px" onclick="closeModal()">取消</button>
  `);
}

function executeDeleteDay() {
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) return;
  const dayIndex = appState.currentDay;
  const day = trip.days[dayIndex];
  const label = day.label ? `「${day.label}」` : `Day ${dayIndex + 1}`;
  trip.days.splice(dayIndex, 1);
  if (trip.days.length > 0) {
    const lastDate = trip.days[trip.days.length - 1].date;
    if (lastDate) trip.end_date = lastDate;
  }
  DataManager.updateTrip(trip.id, trip);
  appState.currentDay = Math.max(0, dayIndex - 1);
  closeModal();
  showToast(`已刪除 ${label}`);
  renderDetail();
}

function openEditHotelModal() {
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) return;
  const day = trip.days[appState.currentDay];
  const h = day.hotel || {};
  _modalLinks = Array.isArray(h.links) ? h.links.map(l => ({ ...l })) : [];
  if (_modalLinks.length === 0 && h.url) _modalLinks = [{ label: h.url_title || '', url: h.url }];

  const statusOptions = VALID_STATUSES.map(s =>
    `<option value="${s}" ${(h.status || 'none') === s ? 'selected' : ''}>${s}</option>`).join('');
  const currOptions = VALID_CURRENCY.map(c =>
    `<option value="${c}" ${(h.currency || 'TWD') === c ? 'selected' : ''}>${c}</option>`).join('');

  openModal(`
    <div class="modal-title">${h.name ? '編輯住宿' : '設定今晚住宿'} <button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="form-group"><label>住宿名稱 *</label>
      <input id="hotel-name" type="text" value="${encodeHTML(h.name || '')}" placeholder="住宿名稱" maxlength="60" /></div>
    <div class="form-group"><label>預訂狀態</label>
      <select id="hotel-status">${statusOptions}</select></div>
    <div class="form-group"><label>費用</label>
      <div style="display:flex;gap:8px">
        <input id="hotel-cost" type="number" value="${encodeHTML(String(h.cost || ''))}" placeholder="0" style="flex:1" />
        <select id="hotel-currency" style="width:90px">${currOptions}</select>
      </div></div>
    <div class="form-group"><label>地址（Google Maps 用）</label>
      <input id="hotel-address" type="text" value="${encodeHTML(h.address || '')}" /></div>
    <div class="form-group">
      <label>連結</label>
      <div id="modal-links-list"></div>
      <div style="height:1px; background:var(--border); margin:10px 0; opacity:0.6;"></div>
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">
        <input id="modal-link-label" type="text" placeholder="顯示名稱（可留空）" maxlength="80"
          style="width:100%;padding:8px 12px;border:1.5px solid var(--border);border-radius:var(--radius-btn);font-size:14px;background:var(--cream);color:var(--text);outline:none;font-family:inherit" />
        <div style="display:flex;gap:8px">
          <input id="modal-link-url" type="url" placeholder="https://..."
            style="flex:1;padding:8px 12px;border:1.5px solid var(--border);border-radius:var(--radius-btn);font-size:14px;background:var(--cream);color:var(--text);outline:none;font-family:inherit" />
          <button type="button" class="btn-ghost-sm" onclick="addModalLink()" style="white-space:nowrap">＋ 新增</button>
        </div>
      </div>
    </div>
    <div class="form-group"><label>備註（房號 / 密碼等）</label>
      <textarea id="hotel-note">${encodeHTML(h.note || '')}</textarea></div>
    <button class="btn-submit" onclick="saveHotelData()">儲存住宿</button>
  `);
  _renderModalLinks();
}

function saveHotelData() {
  const name = document.getElementById('hotel-name').value.trim();
  if (!name) { showToast('請輸入住宿名稱', 'error'); return; }
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) return;
  const day = trip.days[appState.currentDay];
  day.hotel = {
    name,
    status:   document.getElementById('hotel-status').value,
    cost:     parseFloat(document.getElementById('hotel-cost').value) || 0,
    currency: document.getElementById('hotel-currency').value,
    address:  document.getElementById('hotel-address').value.trim(),
    note:     document.getElementById('hotel-note').value.trim(),
    links:    _modalLinks.slice(),
  };
  DataManager.updateTrip(trip.id, trip);
  closeModal();
  renderHotelBar(day);
  updateTripBookingBadge();
  showToast('✅ 已儲存住宿資訊');
}

function deleteHotelData() {
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) return;
  const day = trip.days[appState.currentDay];
  delete day.hotel;
  DataManager.updateTrip(trip.id, trip);
  renderHotelBar(day);
  updateTripBookingBadge();
  showToast('已移除今晚住宿');
}

function toggleHotelBar() {
  const header = document.getElementById('hotel-bar-header');
  const body   = document.getElementById('hotel-bar-body');
  if (!header || !body) return;
  if (header.classList.contains('open')) {
    body.style.maxHeight = body.scrollHeight + 'px';
    header.classList.remove('open');
    requestAnimationFrame(() => { body.style.maxHeight = '0'; });
    body.addEventListener('transitionend', () => {
      body.classList.remove('open');
    }, { once: true });
  } else {
    header.classList.add('open');
    body.classList.add('open');
    body.style.maxHeight = body.scrollHeight + 'px';
    body.addEventListener('transitionend', () => {
      if (header.classList.contains('open')) body.style.maxHeight = 'none';
    }, { once: true });
  }
}

// ── 景點列表 ──────────────────────────────────────────────
function renderEventsList(events) {
  const el = document.getElementById('events-list');
  el.innerHTML = '';
  if (events.length === 0) {
    el.innerHTML = `<div class="no-items">${appState.editMode ? '點右下角 + 新增景點' : '今天沒有安排'}</div>`;
    return;
  }
  events.forEach((ev, idx) => el.appendChild(buildEventCard(ev, idx, events.length)));
}

function buildEventCard(ev, idx, totalCount) {
  const div = document.createElement('div');
  div.className = 'event-card';
  div.style.setProperty('--dot-color', typeColor(ev.type));
  div.dataset.eventIdx = idx;

  const dot    = `<div class="event-dot" style="background:${typeColor(ev.type)}"></div>`;
  const time   = ev.time ? `<span class="event-time">${encodeHTML(ev.time)}</span>` : `<span class="event-time"></span>`;
  const name   = `<span class="event-name">${encodeHTML(ev.name)}</span>`;
  const planB  = ev.plan_b ? `<span class="plan-b-badge">Plan B</span>` : '';
  let statusBadge = '';
  if (ev.status === 'pending') statusBadge = `<span class="pending-badge">⚠ 需訂</span>`;
  if (ev.status === 'booked')  statusBadge = `<span class="booked-badge">✓ 已訂</span>`;

  let rightSection = appState.editMode
    ? `<div class="edit-actions">
        ${idx > 0 ? `<button class="edit-icon-btn" data-action="up" data-idx="${idx}" title="上移">↑</button>` : ''}
        ${idx < totalCount - 1 ? `<button class="edit-icon-btn" data-action="down" data-idx="${idx}" title="下移">↓</button>` : ''}
        <button class="edit-icon-btn" data-action="edit" data-idx="${idx}" title="編輯">✏️</button>
        <button class="edit-icon-btn del" data-action="del" data-idx="${idx}" title="刪除">🗑</button>
       </div>`
    : `<span class="event-arrow">▾</span>`;

  let costLine = '';
  if (ev.cost && ev.cost > 0) {
    const sym = CURRENCY_SYMBOLS[ev.currency] || '';
    costLine = `<div class="event-cost">💰 ${sym}${ev.cost}</div>`;
  }
  let bodyContent = costLine;
  if (ev.note)    bodyContent += `<p class="event-note">${encodeHTML(ev.note)}</p>`;
  if (ev.plan_b)  bodyContent += `<p class="plan-b-note">📋 備案：${encodeHTML(ev.plan_b)}</p>`;
  const evLinks = Array.isArray(ev.links) && ev.links.length > 0
    ? ev.links
    : (ev.url ? [{ label: ev.url_title || ev.url, url: ev.url }] : []);
  evLinks.forEach(l => {
    bodyContent += `<a class="event-link" href="${encodeHTML(l.url)}" target="_blank" rel="noopener">🔗 ${encodeHTML(l.label || l.url)}</a>`;
  });
  if (ev.address) {
    const mapsUrl = `https://maps.google.com?q=${encodeURIComponent(ev.address)}`;
    bodyContent += `<a class="map-link" href="${encodeHTML(mapsUrl)}" target="_blank" rel="noopener">🗺️ 開啟地圖</a>`;
  }

  div.innerHTML = `
    <div class="event-header">${time}${dot}${name}${planB}${statusBadge}${rightSection}</div>
    <div class="event-body"><div class="event-body-inner">${bodyContent || '<span style="font-size:13px;color:var(--muted)">無備註</span>'}</div></div>`;

  if (!appState.editMode) {
    div.querySelector('.event-header').addEventListener('click', () => toggleEvent(div));
  } else {
    if (idx > 0) div.querySelector('[data-action="up"]')?.addEventListener('click', (e) => {
      e.stopPropagation(); moveEvent(appState.currentDay, idx, -1);
    });
    if (idx < totalCount - 1) div.querySelector('[data-action="down"]')?.addEventListener('click', (e) => {
      e.stopPropagation(); moveEvent(appState.currentDay, idx, 1);
    });
    div.querySelector('[data-action="edit"]').addEventListener('click', (e) => {
      e.stopPropagation();
      openEditEventModal(parseInt(e.currentTarget.dataset.idx));
    });
    div.querySelector('[data-action="del"]').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteEvent(appState.currentDay, parseInt(e.currentTarget.dataset.idx));
    });
  }
  return div;
}

// Insert ev into events array at the correct time-sorted position.
// No time → append to end. Has time → insert after last timed event with time ≤ ev.time.
function _insertEventSorted(events, ev) {
  if (!ev.time) { events.push(ev); return; }
  let insertAfter = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i].time && events[i].time <= ev.time) insertAfter = i;
  }
  events.splice(insertAfter + 1, 0, ev);
}

// Normalize a day's events: sort timed events by time while keeping timeless events
// at their original index positions. Used on import only (minimal-change sort).
function _normalizeDayEvents(events) {
  if (!Array.isArray(events) || events.length < 2) return;
  const timedIdxs   = events.reduce((acc, e, i) => { if (e.time) acc.push(i); return acc; }, []);
  const sortedTimed = timedIdxs.map(i => events[i]).sort((a, b) => a.time.localeCompare(b.time));
  timedIdxs.forEach((idx, j) => { events[idx] = sortedTimed[j]; });
}

function moveEvent(dayIdx, eventIdx, direction) {
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) return;
  const events = trip.days[dayIdx].events;
  const newIdx = eventIdx + direction;
  if (newIdx < 0 || newIdx >= events.length) return;

  const ev       = events[eventIdx];
  const neighbor = events[newIdx];

  // Time constraint: only applies when the moving event has a time
  if (ev.time && neighbor.time) {
    if (direction === -1 && neighbor.time < ev.time) {
      showToast(`不能移到 ${neighbor.time} 之前`, 'error'); return;
    }
    if (direction === 1 && neighbor.time > ev.time) {
      showToast(`不能移到 ${neighbor.time} 之後`, 'error'); return;
    }
  }

  [events[eventIdx], events[newIdx]] = [events[newIdx], events[eventIdx]];
  DataManager.updateTrip(trip.id, trip);
  renderEventsList(events);
}

function toggleEvent(card) {
  const body = card.querySelector('.event-body');
  if (card.classList.contains('expanded')) {
    body.style.maxHeight = `${body.scrollHeight || 9999}px`;
    card.classList.remove('expanded');
    requestAnimationFrame(() => { body.style.maxHeight = '0'; });
  } else {
    card.classList.add('expanded');
    body.style.maxHeight = `${body.scrollHeight || 9999}px`;
    body.addEventListener('transitionend', () => {
      if (card.classList.contains('expanded')) body.style.maxHeight = 'none';
    }, { once: true });
  }
}

function deleteEvent(dayIdx, eventIdx) {
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) return;
  const ev = trip.days[dayIdx].events[eventIdx];
  trip.days[dayIdx].events.splice(eventIdx, 1);
  DataManager.updateTrip(trip.id, trip);
  showToast(`已刪除「${ev.name}」`);
  const events = trip.days[dayIdx].events;
  renderEventsList(events);
  renderDriveWarning(events);
  renderHotelBar(trip.days[dayIdx]);
  updateTripBookingBadge();
}

function openAddEventModal() { _openEventModal(null, appState.currentDay, null); }

function openEditEventModal(eventIdx) {
  const trip = DataManager.getTrip(appState.currentTrip);
  const ev   = trip ? trip.days[appState.currentDay].events[eventIdx] : null;
  _openEventModal(ev, appState.currentDay, eventIdx);
}

function _openEventModal(ev, dayIdx, eventIdx) {
  const isNew = eventIdx === null;
  const v = ev || {};
  const typeOptions    = VALID_TYPES.map(t =>
    `<option value="${t}" ${v.type === t ? 'selected' : ''}>${TYPE_LABELS[t]}</option>`).join('');
  const statusOptions  = VALID_STATUSES.map(s =>
    `<option value="${s}" ${(v.status || 'none') === s ? 'selected' : ''}>${s}</option>`).join('');
  const currOptions    = VALID_CURRENCY.map(c =>
    `<option value="${c}" ${(v.currency || 'TWD') === c ? 'selected' : ''}>${c}</option>`).join('');

  _modalLinks = Array.isArray(v.links) ? v.links.map(l => ({ ...l })) : [];
  if (_modalLinks.length === 0 && v.url) {
    _modalLinks = [{ label: v.url_title || '', url: v.url }];
  }

  openModal(`
    <div class="modal-title">${isNew ? '新增景點' : '編輯景點'} <button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="form-group"><label>時間（HH:MM）</label>
      <div style="display:flex;gap:8px;align-items:stretch">
        <input id="ev-time" type="time" value="${encodeHTML(v.time || '')}" style="flex:1" />
        <button type="button" class="btn-ghost-sm" onclick="document.getElementById('ev-time').value=''" title="清除時間">✕</button>
      </div></div>
    <div class="form-group"><label>景點名稱 *</label>
      <input id="ev-name" type="text" value="${encodeHTML(v.name || '')}" placeholder="景點名稱" maxlength="60" /></div>
    <div class="form-group"><label>類型</label>
      <select id="ev-type">${typeOptions}</select></div>
    <div class="form-group"><label>預訂狀態</label>
      <select id="ev-status">${statusOptions}</select></div>
    <div class="form-group"><label>費用</label>
      <div style="display:flex;gap:8px">
        <input id="ev-cost" type="number" value="${encodeHTML(String(v.cost || ''))}" placeholder="0" style="flex:1" />
        <select id="ev-currency" style="width:90px">${currOptions}</select>
      </div></div>
    <div class="form-group"><label>地址（Google Maps 用）</label>
      <input id="ev-address" type="text" value="${encodeHTML(v.address || '')}" /></div>
    <div class="form-group">
      <label>連結</label>
      <div id="modal-links-list"></div>
      <div style="height:1px; background:var(--border); margin:10px 0; opacity:0.6;"></div>
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">
        <div style="display:flex;gap:8px">
          <div style="display:flex;flex-direction:column;gap:6px;width:100%;">
            <input id="modal-link-label" type="text" placeholder="顯示名稱（可留空）" maxlength="80"
              style="padding:8px 12px;border:1.5px solid var(--border);border-radius:var(--radius-btn);font-size:14px;background:var(--cream);color:var(--text);outline:none;font-family:inherit" />
            <input id="modal-link-url" type="url" placeholder="https://..."
              style="padding:8px 12px;border:1.5px solid var(--border);border-radius:var(--radius-btn);font-size:14px;background:var(--cream);color:var(--text);outline:none;font-family:inherit" />
          </div>
          <button type="button" class="btn-ghost-sm" onclick="addModalLink()" style="white-space:nowrap">＋ 新增</button>
        </div>
      </div>
    </div>
    <div class="form-group"><label>開車分鐘（從上一站）</label>
      <input id="ev-drive" type="number" value="${encodeHTML(String(v.drive_mins || ''))}" placeholder="0" /></div>
    <div class="form-group"><label>備案（Plan B）</label>
      <input id="ev-planb" type="text" value="${encodeHTML(v.plan_b || '')}" /></div>
    <div class="form-group"><label>備註</label>
      <textarea id="ev-note">${encodeHTML(v.note || '')}</textarea></div>
    <button class="btn-submit" onclick="saveEvent(${dayIdx}, ${isNew ? 'null' : eventIdx})">
      ${isNew ? '新增景點' : '儲存變更'}
    </button>
  `);
  _renderModalLinks();
}

function _renderModalLinks() {
  const el = document.getElementById('modal-links-list');
  if (!el) return;
  if (_modalLinks.length === 0) {
    el.innerHTML = '<div style="font-size:13px;color:var(--muted);padding:2px 0 4px">尚無連結</div>';
    return;
  }
  el.innerHTML = _modalLinks.map((l, i) => `
    <div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">
      <div style="display:flex;gap:8px">
        <div style="display:flex;flex-direction:column;gap:6px;width:100%;">
          <input type="text" value="${encodeHTML(l.label || '')}" placeholder="顯示名稱" oninput="updateModalLinkLabel(${i}, this.value)"
            style="padding:8px 12px; border:1.5px solid var(--border); border-radius:var(--radius-btn); font-size:14px; background:var(--cream); color:var(--text); outline:none; font-family:inherit; box-sizing:border-box; width:100%;" />
          <input type="url" value="${encodeHTML(l.url || '')}" placeholder="https://..." oninput="updateModalLinkUrl(${i}, this.value)"
            style="padding:8px 12px;border:1.5px solid var(--border);border-radius:var(--radius-btn); font-size:14px; background:var(--cream); color:var(--text); outline:none; font-family:inherit; box-sizing:border-box; width:100%;"/>
        </div>
        <button type="button" class="btn-icon-del" onclick="removeModalLink(${i})">🗑</button>
      </div>
    </div>`).join('');
}

function addModalLink() {
  const labelEl = document.getElementById('modal-link-label');
  const urlEl   = document.getElementById('modal-link-url');
  if (!urlEl) return;
  const url = urlEl.value.trim();
  if (!url || !url.startsWith('http')) { showToast('請輸入有效的 URL（https://...）', 'error'); return; }
  const label = labelEl ? labelEl.value.trim() : '';
  _modalLinks.push({ label, url });
  if (labelEl) labelEl.value = '';
  urlEl.value = '';
  _renderModalLinks();
}

function removeModalLink(idx) {
  _modalLinks.splice(idx, 1);
  _renderModalLinks();
}

function saveEvent(dayIdx, eventIdx) {
  const name = document.getElementById('ev-name').value.trim();
  if (!name) { showToast('請輸入景點名稱', 'error'); return; }

  const timeVal = document.getElementById('ev-time').value;
  const ev = {
    time:       TIME_REGEX.test(timeVal) ? timeVal : null,
    name,
    type:       document.getElementById('ev-type').value,
    status:     document.getElementById('ev-status').value,
    cost:       parseFloat(document.getElementById('ev-cost').value) || 0,
    currency:   document.getElementById('ev-currency').value,
    address:    document.getElementById('ev-address').value.trim(),
    links:      _modalLinks.slice(),
    drive_mins: parseInt(document.getElementById('ev-drive').value) || 0,
    plan_b:     document.getElementById('ev-planb').value.trim(),
    note:       document.getElementById('ev-note').value.trim(),
  };

  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) return;

  if (eventIdx === null) {
    _insertEventSorted(trip.days[dayIdx].events, ev);
    showToast(`✅ 已新增「${name}」`);
  } else {
    trip.days[dayIdx].events[eventIdx] = ev;
    showToast(`✅ 已更新「${name}」`);
  }
  DataManager.updateTrip(trip.id, trip);
  closeModal();

  const events = trip.days[dayIdx].events;
  renderEventsList(events);
  renderDriveWarning(events);
  renderHotelBar(trip.days[dayIdx]);
  updateTripBookingBadge();
}

// ═══════════════════════════════════════════════════════════
// 9. 行程內：預訂 tab
// ═══════════════════════════════════════════════════════════
function renderTripBooking() {
  const trip = DataManager.getTrip(appState.currentTrip);
  const el   = document.getElementById('trip-booking-content');
  if (!trip) return;

  // Preserve open/closed state across re-renders
  const savedOpen = new Set([...el.querySelectorAll('.collapsible-card.open')].map(c => c.id));
  const hadCards  = el.querySelector('.collapsible-card') !== null;

  const flights        = Array.isArray(trip.flights) ? trip.flights : [];
  const transportItems = [];
  const otherItems     = [];

  (trip.days || []).forEach((day, di) => {
    (day.events || []).forEach((ev, ei) => {
      if (ev.status === 'pending' || ev.status === 'booked') {
        const item = { day, ev, di, ei };
        if (ev.type === 'transport') transportItems.push(item);
        else otherItems.push(item);
      }
    });
  });

  // pending first, then booked; within each group sort by date + time
  function sortBookingItems(items) {
    return [...items].sort((a, b) => {
      if (a.ev.status !== b.ev.status) return a.ev.status === 'pending' ? -1 : 1;
      const ka = (a.day.date || '') + (a.ev.time || '');
      const kb = (b.day.date || '') + (b.ev.time || '');
      return ka.localeCompare(kb);
    });
  }

  let html = '';

  const flightsBody = flights.length === 0
    ? '<div class="no-items">尚未新增機票</div>'
    : `<div class="booking-list">${flights.map((f, i) => buildFlightItemHTML(f, i)).join('')}</div>`;
  html += `<div class="collapsible-card" id="booking-flights-card">
    <button class="collapsible-hdr" onclick="toggleCollapsible('booking-flights-card')">
      <span>✈ 機票資訊</span>
      <span class="collapsible-hdr-title"></span>
      ${flights.length > 0 ? `<span class="collapsible-hdr-badge-green">${flights.length} 機票</span>` : ''}
      <span class="collapsible-hdr-arrow">▾</span>
    </button>
    <div class="collapsible-body">
      ${flightsBody}
      <div style="padding:10px 16px;border-top:1px solid var(--border)">
        <button class="btn-submit" style="margin-top:0" onclick="openAddFlightModal()">＋ 新增機票</button>
      </div>
    </div>
  </div>`;

  const sortedTransport = sortBookingItems(transportItems);
  if (sortedTransport.length > 0) {
    const pendingCount = sortedTransport.filter(x => x.ev.status === 'pending').length;
    html += `<div class="collapsible-card open" id="booking-transport-card">
      <button class="collapsible-hdr" onclick="toggleCollapsible('booking-transport-card')">
        <span>🚌 交通景點</span>
        <span class="collapsible-hdr-title"></span>
        ${pendingCount > 0 ? `<span class="collapsible-hdr-badge-red">${pendingCount} 待訂</span>` : ''}
        <span class="collapsible-hdr-arrow">▾</span>
      </button>
      <div class="collapsible-body">
        <div class="booking-list">
          ${sortedTransport.map(({ day, ev, di, ei }) => buildBookingItemHTML(trip, day, ev, di, ei)).join('')}
        </div>
      </div>
    </div>`;
  }

  const sortedOther = sortBookingItems(otherItems);
  if (sortedOther.length > 0) {
    const pendingCount = sortedOther.filter(x => x.ev.status === 'pending').length;
    html += `<div class="collapsible-card open" id="booking-other-card">
      <button class="collapsible-hdr" onclick="toggleCollapsible('booking-other-card')">
        <span>🎫 其他預訂</span>
        <span class="collapsible-hdr-title"></span>
        ${pendingCount > 0 ? `<span class="collapsible-hdr-badge-red">${pendingCount} 待訂</span>` : ''}
        <span class="collapsible-hdr-arrow">▾</span>
      </button>
      <div class="collapsible-body">
        <div class="booking-list">
          ${sortedOther.map(({ day, ev, di, ei }) => buildBookingItemHTML(trip, day, ev, di, ei)).join('')}
        </div>
      </div>
    </div>`;
  }

  el.innerHTML = html;

  // Restore open/closed states (skip on first render — use HTML defaults)
  if (hadCards) {
    el.querySelectorAll('.collapsible-card').forEach(card => {
      if (savedOpen.has(card.id)) card.classList.add('open');
      else card.classList.remove('open');
    });
  }
}

function buildFlightItemHTML(f, idx) {
  // route line: dep_city/arr_city if available, fall back to legacy route field
  const depCity = f.dep_city ? encodeHTML(f.dep_city) + (f.dep_terminal ? ` T${encodeHTML(f.dep_terminal)}` : '') : '';
  const arrCity = f.arr_city ? encodeHTML(f.arr_city) + (f.arr_terminal ? ` T${encodeHTML(f.arr_terminal)}` : '') : '';
  const routeStr = (depCity || arrCity) ? `${depCity || '?'} → ${arrCity || '?'}` : encodeHTML(f.route || '未填航線');

  // departure / arrival time lines
  const depDate = f.dep_date ? formatDate(f.dep_date) : (f.date ? formatDate(f.date) : '');
  const depTime = f.dep_time || f.time || '';
  const arrDate = f.arr_date ? formatDate(f.arr_date) : '';
  const arrTime = f.arr_time || '';
  const depStr  = [depDate, depTime].filter(Boolean).join(' ');
  const arrStr  = [arrDate, arrTime].filter(Boolean).join(' ');
  const timeLineStr = (depStr && arrStr) ? `${depStr} → ${arrStr}` : (depStr || arrStr);

  const details  = [f.flight_no ? `航班 ${f.flight_no}` : '', f.seat ? `座位 ${f.seat}` : '', f.baggage ? `行李 ${f.baggage}` : ''].filter(Boolean).join(' · ');
  const noteHTML = f.note ? `<div class="booking-note">${encodeHTML(f.note)}</div>` : '';

  return `
    <div class="booking-item">
      <div class="booking-info">
        <div class="booking-name">${routeStr}</div>
        ${timeLineStr ? `<div class="booking-sub">${encodeHTML(timeLineStr)}</div>` : ''}
        ${details     ? `<div class="booking-sub">${encodeHTML(details)}</div>` : ''}
        ${noteHTML}
      </div>
      <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
        <button class="edit-icon-btn" onclick="openEditFlightModal(${idx})">✏️</button>
        <button class="edit-icon-btn del" onclick="deleteFlightItem(${idx})">🗑</button>
      </div>
    </div>`;
}

function openAddFlightModal() {
  openModal(`
    <div class="modal-title">新增機票 <button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="form-row-2">
      <div class="form-group"><label>出發地 *</label>
        <input id="f-dep-city" type="text" placeholder="例：TPE" maxlength="10" /></div>
      <div class="form-group"><label>航廈</label>
        <input id="f-dep-terminal" type="text" placeholder="例：2" maxlength="5" /></div>
    </div>
    <div class="form-row-2">
      <div class="form-group"><label>出發日期</label>
        <input id="f-dep-date" type="date" /></div>
      <div class="form-group"><label>出發時間</label>
        <input id="f-dep-time" type="time" /></div>
    </div>
    <div class="form-row-2">
      <div class="form-group"><label>抵達地 *</label>
        <input id="f-arr-city" type="text" placeholder="例：NRT" maxlength="10" /></div>
      <div class="form-group"><label>航廈</label>
        <input id="f-arr-terminal" type="text" placeholder="例：1" maxlength="5" /></div>
    </div>
    <div class="form-row-2">
      <div class="form-group"><label>抵達日期</label>
        <input id="f-arr-date" type="date" /></div>
      <div class="form-group"><label>抵達時間</label>
        <input id="f-arr-time" type="time" /></div>
    </div>
    <div class="form-row-2">
      <div class="form-group"><label>航班號</label>
        <input id="f-flight-no" type="text" placeholder="例：BR197" maxlength="20" /></div>
      <div class="form-group"><label>座位</label>
        <input id="f-seat" type="text" placeholder="例：15A" maxlength="10" /></div>
    </div>
    <div class="form-group"><label>行李</label>
      <input id="f-baggage" type="text" placeholder="例：20kg" maxlength="30" /></div>
    <div class="form-group"><label>備註</label>
      <input id="f-flight-note" type="text" placeholder="例：PNR: ABCDEF" /></div>
    <button class="btn-submit" onclick="saveFlightItem()">新增機票</button>
  `);
  setTimeout(() => document.getElementById('f-dep-city')?.focus(), 100);
}

function saveFlightItem() {
  const depCity = document.getElementById('f-dep-city').value.trim();
  const arrCity = document.getElementById('f-arr-city').value.trim();
  if (!depCity && !arrCity) { showToast('請輸入出發地或抵達地', 'error'); return; }
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) return;
  if (!Array.isArray(trip.flights)) trip.flights = [];
  trip.flights.push({
    id:           genId('flt'),
    dep_city:     depCity,
    dep_terminal: document.getElementById('f-dep-terminal').value.trim(),
    dep_date:     document.getElementById('f-dep-date').value || '',
    dep_time:     document.getElementById('f-dep-time').value || '',
    arr_city:     arrCity,
    arr_terminal: document.getElementById('f-arr-terminal').value.trim(),
    arr_date:     document.getElementById('f-arr-date').value || '',
    arr_time:     document.getElementById('f-arr-time').value || '',
    flight_no:    document.getElementById('f-flight-no').value.trim(),
    seat:         document.getElementById('f-seat').value.trim(),
    baggage:      document.getElementById('f-baggage').value.trim(),
    note:         document.getElementById('f-flight-note').value.trim(),
    status:       'pending',
  });
  DataManager.updateTrip(trip.id, trip);
  closeModal();
  showToast('✅ 已新增機票');
  renderTripBooking();
}

function deleteFlightItem(idx) {
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip || !Array.isArray(trip.flights)) return;
  const f    = trip.flights[idx];
  const name = (f?.dep_city && f?.arr_city) ? `${f.dep_city} → ${f.arr_city}` : (f?.route || '機票');
  trip.flights.splice(idx, 1);
  DataManager.updateTrip(trip.id, trip);
  showToast(`已刪除「${name}」`);
  renderTripBooking();
}

function openEditFlightModal(idx) {
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip || !trip.flights?.[idx]) return;
  const f = trip.flights[idx];
  openModal(`
    <div class="modal-title">編輯機票 <button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="form-row-2">
      <div class="form-group"><label>出發地</label>
        <input id="f-dep-city" type="text" value="${encodeHTML(f.dep_city || '')}" maxlength="10" /></div>
      <div class="form-group"><label>航廈</label>
        <input id="f-dep-terminal" type="text" value="${encodeHTML(f.dep_terminal || '')}" maxlength="5" /></div>
    </div>
    <div class="form-row-2">
      <div class="form-group"><label>出發日期</label>
        <input id="f-dep-date" type="date" value="${encodeHTML(f.dep_date || f.date || '')}" /></div>
      <div class="form-group"><label>出發時間</label>
        <input id="f-dep-time" type="time" value="${encodeHTML(f.dep_time || f.time || '')}" /></div>
    </div>
    <div class="form-row-2">
      <div class="form-group"><label>抵達地</label>
        <input id="f-arr-city" type="text" value="${encodeHTML(f.arr_city || '')}" maxlength="10" /></div>
      <div class="form-group"><label>航廈</label>
        <input id="f-arr-terminal" type="text" value="${encodeHTML(f.arr_terminal || '')}" maxlength="5" /></div>
    </div>
    <div class="form-row-2">
      <div class="form-group"><label>抵達日期</label>
        <input id="f-arr-date" type="date" value="${encodeHTML(f.arr_date || '')}" /></div>
      <div class="form-group"><label>抵達時間</label>
        <input id="f-arr-time" type="time" value="${encodeHTML(f.arr_time || '')}" /></div>
    </div>
    <div class="form-row-2">
      <div class="form-group"><label>航班號</label>
        <input id="f-flight-no" type="text" value="${encodeHTML(f.flight_no || '')}" maxlength="20" /></div>
      <div class="form-group"><label>座位</label>
        <input id="f-seat" type="text" value="${encodeHTML(f.seat || '')}" maxlength="10" /></div>
    </div>
    <div class="form-group"><label>行李</label>
      <input id="f-baggage" type="text" value="${encodeHTML(f.baggage || '')}" maxlength="30" /></div>
    <div class="form-group"><label>備註</label>
      <input id="f-flight-note" type="text" value="${encodeHTML(f.note || '')}" /></div>
    <button class="btn-submit" onclick="saveEditFlightItem(${idx})">儲存</button>
    <button class="btn-submit" style="background:var(--muted);margin-top:8px" onclick="closeModal()">取消</button>
  `);
}

function saveEditFlightItem(idx) {
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip || !trip.flights?.[idx]) return;
  const f = trip.flights[idx];
  f.dep_city     = document.getElementById('f-dep-city').value.trim();
  f.dep_terminal = document.getElementById('f-dep-terminal').value.trim();
  f.dep_date     = document.getElementById('f-dep-date').value || '';
  f.dep_time     = document.getElementById('f-dep-time').value || '';
  f.arr_city     = document.getElementById('f-arr-city').value.trim();
  f.arr_terminal = document.getElementById('f-arr-terminal').value.trim();
  f.arr_date     = document.getElementById('f-arr-date').value || '';
  f.arr_time     = document.getElementById('f-arr-time').value || '';
  f.flight_no    = document.getElementById('f-flight-no').value.trim();
  f.seat         = document.getElementById('f-seat').value.trim();
  f.baggage      = document.getElementById('f-baggage').value.trim();
  f.note         = document.getElementById('f-flight-note').value.trim();
  DataManager.updateTrip(trip.id, trip);
  closeModal();
  showToast('✅ 已儲存機票');
  renderTripBooking();
}

function buildBookingItemHTML(trip, day, ev, di, ei) {
  const statusLabel = ev.status === 'booked' ? '✓ 已訂' : '⚠ 需訂';
  const noteHTML    = ev.note ? `<div class="booking-note">${encodeHTML(ev.note)}</div>` : '';
  const bkLinks = Array.isArray(ev.links) && ev.links.length > 0
    ? ev.links
    : (ev.url ? [{ label: '查看連結', url: ev.url }] : []);
  const linkHTML = bkLinks.map(l =>
    `<a class="booking-link" href="${encodeHTML(l.url)}" target="_blank" rel="noopener">🔗 ${encodeHTML(l.label || '查看連結')}</a>`
  ).join('');
  return `
    <div class="booking-item">
      <div class="booking-info">
        <div class="booking-name">${encodeHTML(ev.name)}</div>
        <div class="booking-sub">${encodeHTML(formatDate(day.date))} · ${encodeHTML(TYPE_LABELS[ev.type] || ev.type)}</div>
        ${noteHTML}${linkHTML}
      </div>
      <button class="booking-status-btn ${encodeHTML(ev.status)}"
        onclick="toggleTripBookingStatus('${encodeHTML(trip.id)}',${di},${ei})">
        ${statusLabel}
      </button>
    </div>`;
}

function toggleTripBookingStatus(tripId, dayIdx, evIdx) {
  const trip = DataManager.getTrip(tripId);
  if (!trip) return;
  const ev = trip.days[dayIdx].events[evIdx];
  ev.status = ev.status === 'booked' ? 'pending' : 'booked';
  DataManager.updateTrip(tripId, trip);
  renderTripBooking();
  updateTripBookingBadge();
}

function updateTripBookingBadge() {
  const badge = document.getElementById('trip-booking-badge');
  if (!badge) return;
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) { badge.style.display = 'none'; return; }
  let pending = 0;
  (trip.days || []).forEach(day => {
    if (day.hotel && day.hotel.status === 'pending') pending++;
    (day.events || []).forEach(ev => { if (ev.status === 'pending') pending++; });
  });
  if (pending > 0) { badge.textContent = pending; badge.style.display = 'flex'; }
  else { badge.style.display = 'none'; }
}

// ═══════════════════════════════════════════════════════════
// 10. 行程內：記帳 tab
// ═══════════════════════════════════════════════════════════
function renderTripExpense() {
  const el   = document.getElementById('trip-expense-content');
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) return;
  const cardHTML = buildExpenseTripCard(trip);
  el.innerHTML = cardHTML || '<div class="no-items" style="padding-top:40px">這個行程沒有費用記錄</div>';
}

function buildExpenseTripCard(trip) {
  const eventsWithCost = [];
  (trip.days || []).forEach(day => {
    if (day.hotel && day.hotel.cost > 0)
      eventsWithCost.push({ ev: day.hotel, date: day.date });
    (day.events || []).forEach(ev => {
      if (ev.cost && ev.cost > 0) eventsWithCost.push({ ev, date: day.date });
    });
  });
  if (eventsWithCost.length === 0) return '';

  const totals = {};
  eventsWithCost.forEach(({ ev }) => {
    const c = ev.currency || 'TWD';
    totals[c] = (totals[c] || 0) + (ev.cost || 0);
  });
  const members = Array.isArray(trip.members) && trip.members.length > 0 ? trip.members : null;
  const totalHTML = Object.entries(totals).map(([c, v]) => {
    const sym = CURRENCY_SYMBOLS[c] || c;
    const perPerson = members ? `（每人約 ${sym}${Math.ceil(v / members.length)}）` : '';
    return `${sym}${v.toLocaleString()}${perPerson}`;
  }).join('　');

  const rows = eventsWithCost.map(({ ev, date }) => {
    const sym = CURRENCY_SYMBOLS[ev.currency] || '';
    return `
      <div class="expense-row">
        <span style="font-size:11px;color:var(--muted);min-width:38px">${formatDate(date)}</span>
        <span class="expense-ev-name">${encodeHTML(ev.name)}</span>
        <span class="expense-amount">${sym}${(ev.cost || 0).toLocaleString()}</span>
        <span class="expense-currency">${ev.currency || ''}</span>
      </div>`;
  }).join('');

  return `
    <div class="expense-trip-card">
      <div class="expense-trip-header">
        <span class="expense-trip-name">${encodeHTML(trip.trip_name)}</span>
        <span style="font-size:12px;color:var(--muted)">${members ? members.length + '人' : ''}</span>
      </div>
      <div class="expense-rows">${rows}</div>
      <div class="expense-split">💰 合計：${totalHTML}</div>
    </div>`;
}

// ═══════════════════════════════════════════════════════════
// 11. 行程內：備忘錄 tab
// ═══════════════════════════════════════════════════════════
function renderTripNotes() {
  const el   = document.getElementById('trip-notes-content');
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) return;

  const links    = Array.isArray(trip.links)    ? trip.links    : [];
  const shopping = Array.isArray(trip.shopping) ? trip.shopping : [];
  const memo     = trip.memo || '';

  el.innerHTML = `
    <div class="collapsible-card open" id="notes-memo-card">
      <button class="collapsible-hdr" onclick="toggleCollapsible('notes-memo-card')">
        <span>📝 備忘錄</span>
        <span class="collapsible-hdr-title"></span>
        <span class="collapsible-hdr-arrow">▾</span>
      </button>
      <div class="collapsible-body">
        <textarea class="memo-textarea" id="trip-memo-input"
          placeholder="記錄行程重要事項、注意事項..."
          onblur="saveTripMemo()">${encodeHTML(memo)}</textarea>
      </div>
    </div>

    <div class="collapsible-card open" id="notes-links-card">
      <div class="collapsible-hdr-row">
        <button class="collapsible-hdr" onclick="toggleCollapsible('notes-links-card')">
          <span>🔗 重要連結</span>
          <span class="collapsible-hdr-title"></span>
          <span class="collapsible-hdr-arrow">▾</span>
        </button>
        <button class="collapsible-add-btn" onclick="openAddTripLinkModal()">＋</button>
      </div>
      <div class="collapsible-body">
        <div id="trip-links-list">
          ${links.length === 0
            ? '<div class="no-items">還沒有連結</div>'
            : links.map(l => `
              <div class="link-item">
                <a href="${encodeHTML(l.url)}" target="_blank" rel="noopener">${encodeHTML(l.label || l.url)}</a>
                <button class="btn-icon-del" onclick="deleteTripLink('${encodeHTML(l.id)}')">🗑</button>
              </div>`).join('')}
        </div>
      </div>
    </div>

    <div class="collapsible-card open" id="notes-shopping-card">
      <div class="collapsible-hdr-row">
        <button class="collapsible-hdr" onclick="toggleCollapsible('notes-shopping-card')">
          <span>🛍 購買清單</span>
          <span class="collapsible-hdr-title"></span>
          <span class="collapsible-hdr-arrow">▾</span>
        </button>
        <button class="collapsible-add-btn" onclick="openAddTripShoppingModal()">＋</button>
      </div>
      <div class="collapsible-body">
        <div id="trip-shopping-list">
          ${shopping.length === 0
            ? '<div class="no-items">清單是空的</div>'
            : shopping.map(s => `
              <div class="packing-item">
                <input type="checkbox" class="packing-cb" id="sh-${encodeHTML(s.id)}" ${s.checked ? 'checked' : ''}
                  onchange="toggleTripShopping('${encodeHTML(s.id)}')" />
                <label for="sh-${encodeHTML(s.id)}" class="${s.checked ? 'checked' : ''}">${encodeHTML(s.text)}</label>
                <button class="btn-icon-del" onclick="deleteTripShopping('${encodeHTML(s.id)}')">🗑</button>
              </div>`).join('')}
        </div>
      </div>
    </div>
  `;
}

function saveTripMemo() {
  const input = document.getElementById('trip-memo-input');
  if (!input) return;
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) return;
  trip.memo = input.value;
  DataManager.updateTrip(trip.id, trip);
}

async function fetchPageTitle(url) {
  try {
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    const match = data.contents && data.contents.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (match) return match[1].trim().slice(0, 80);
  } catch (_) { /* ignore */ }
  try { return new URL(url).hostname; } catch (_) { return url; }
}

async function addTripLink() {
  const urlInput   = document.getElementById('trip-link-url');
  const labelInput = document.getElementById('trip-link-label');
  const addBtn     = document.getElementById('trip-link-add-btn');
  if (!urlInput) return;
  const url = urlInput.value.trim();
  if (!url || !url.startsWith('http')) { showToast('請輸入有效的 URL（https://...）', 'error'); return; }
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) return;

  const manualLabel = labelInput ? labelInput.value.trim() : '';
  let label;
  if (manualLabel) {
    label = manualLabel;
  } else {
    if (addBtn) { addBtn.disabled = true; addBtn.textContent = '…'; }
    label = await fetchPageTitle(url);
    if (addBtn) { addBtn.disabled = false; addBtn.textContent = '新增'; }
  }

  if (!Array.isArray(trip.links)) trip.links = [];
  trip.links.push({ id: genId('lnk'), label, url });
  DataManager.updateTrip(trip.id, trip);
  urlInput.value = '';
  if (labelInput) labelInput.value = '';
  _refreshTripLinksList(trip);
}

function deleteTripLink(linkId) {
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip || !Array.isArray(trip.links)) return;
  trip.links = trip.links.filter(l => l.id !== linkId);
  DataManager.updateTrip(trip.id, trip);
  _refreshTripLinksList(trip);
  showToast('已刪除連結');
}

function openAddTripLinkModal() {
  openModal(`
    <div class="modal-title">新增重要連結</div>
    <div class="form-group">
      <label>顯示名稱（可留空自動抓取）</label>
      <input id="modal-link-label" type="text" placeholder="例：訂房確認信" maxlength="80" />
    </div>
    <div class="form-group">
      <label>連結網址</label>
      <input id="modal-link-url" type="url" placeholder="https://..." />
    </div>
    <button class="btn-submit" id="modal-link-add-btn" onclick="addTripLinkFromModal()">新增</button>
    <button class="btn-submit" style="background:var(--muted);margin-top:8px" onclick="closeModal()">取消</button>
  `);
  setTimeout(() => document.getElementById('modal-link-label')?.focus(), 100);
}

async function addTripLinkFromModal() {
  const urlInput   = document.getElementById('modal-link-url');
  const labelInput = document.getElementById('modal-link-label');
  const addBtn     = document.getElementById('modal-link-add-btn');
  if (!urlInput) return;
  const url = urlInput.value.trim();
  if (!url || !url.startsWith('http')) { showToast('請輸入有效的 URL（https://...）', 'error'); return; }
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) return;
  const manualLabel = labelInput ? labelInput.value.trim() : '';
  let label;
  if (manualLabel) {
    label = manualLabel;
  } else {
    if (addBtn) { addBtn.disabled = true; addBtn.textContent = '抓取中…'; }
    label = await fetchPageTitle(url);
    if (addBtn) { addBtn.disabled = false; addBtn.textContent = '新增'; }
  }
  if (!Array.isArray(trip.links)) trip.links = [];
  trip.links.push({ id: genId('lnk'), label, url });
  DataManager.updateTrip(trip.id, trip);
  closeModal();
  _refreshTripLinksList(trip);
}

function openAddTripShoppingModal() {
  openModal(`
    <div class="modal-title">新增購買項目</div>
    <div class="form-group">
      <label>項目名稱</label>
      <input id="modal-shopping-text" type="text" placeholder="例：抹茶點心" />
    </div>
    <button class="btn-submit" onclick="addTripShoppingFromModal()">新增</button>
    <button class="btn-submit" style="background:var(--muted);margin-top:8px" onclick="closeModal()">取消</button>
  `);
  setTimeout(() => document.getElementById('modal-shopping-text')?.focus(), 100);
}

function addTripShoppingFromModal() {
  const input = document.getElementById('modal-shopping-text');
  if (!input) return;
  const text = input.value.trim();
  if (!text) { showToast('請輸入項目名稱', 'error'); return; }
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) return;
  if (!Array.isArray(trip.shopping)) trip.shopping = [];
  trip.shopping.push({ id: genId('sh'), text, checked: false });
  DataManager.updateTrip(trip.id, trip);
  closeModal();
  _refreshTripShoppingList(trip);
}

function _refreshTripLinksList(trip) {
  const el    = document.getElementById('trip-links-list');
  if (!el) return;
  const links = Array.isArray(trip.links) ? trip.links : [];
  el.innerHTML = links.length === 0
    ? '<div class="no-items">還沒有連結</div>'
    : links.map(l => `
        <div class="link-item">
          <a href="${encodeHTML(l.url)}" target="_blank" rel="noopener">${encodeHTML(l.label || l.url)}</a>
          <button class="btn-icon-del" onclick="deleteTripLink('${encodeHTML(l.id)}')">🗑</button>
        </div>`).join('');
}

function addTripShopping() {
  const input = document.getElementById('trip-shopping-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) { showToast('請輸入項目名稱', 'error'); return; }
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) return;
  if (!Array.isArray(trip.shopping)) trip.shopping = [];
  trip.shopping.push({ id: genId('sh'), text, checked: false });
  DataManager.updateTrip(trip.id, trip);
  input.value = '';
  _refreshTripShoppingList(trip);
}

function toggleTripShopping(itemId) {
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip || !Array.isArray(trip.shopping)) return;
  const item = trip.shopping.find(s => s.id === itemId);
  if (item) { item.checked = !item.checked; DataManager.updateTrip(trip.id, trip); }
  _refreshTripShoppingList(trip);
}

function deleteTripShopping(itemId) {
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip || !Array.isArray(trip.shopping)) return;
  trip.shopping = trip.shopping.filter(s => s.id !== itemId);
  DataManager.updateTrip(trip.id, trip);
  _refreshTripShoppingList(trip);
  showToast('已刪除項目');
}

function _refreshTripShoppingList(trip) {
  const el       = document.getElementById('trip-shopping-list');
  if (!el) return;
  const shopping = Array.isArray(trip.shopping) ? trip.shopping : [];
  el.innerHTML = shopping.length === 0
    ? '<div class="no-items">清單是空的</div>'
    : shopping.map(s => `
        <div class="packing-item">
          <input type="checkbox" class="packing-cb" id="sh-${encodeHTML(s.id)}" ${s.checked ? 'checked' : ''}
            onchange="toggleTripShopping('${encodeHTML(s.id)}')" />
          <label for="sh-${encodeHTML(s.id)}" class="${s.checked ? 'checked' : ''}">${encodeHTML(s.text)}</label>
          <button class="btn-icon-del" onclick="deleteTripShopping('${encodeHTML(s.id)}')">🗑</button>
        </div>`).join('');
}

// ═══════════════════════════════════════════════════════════
// 12. 行程內：成員 tab
// ═══════════════════════════════════════════════════════════
function renderTripMembers() {
  const el   = document.getElementById('trip-members-content');
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) return;

  // Firebase 行程：立即讀取一次（避免等監聽器觸發），監聽器負責後續即時更新
  if (window.db && trip.shareCode) {
    _renderMembersHTML(el, trip, {});   // 先用本機資料快速渲染（無在線狀態）
    FirebaseManager.getMembers(appState.currentTrip).then(fbMembers => {
      if (appState.currentTrip === trip.id) _renderMembersHTML(el, trip, fbMembers || {});
    }).catch(() => {});
    return;
  }

  // 本機行程：直接從 trip.members 渲染
  _renderMembersHTML(el, trip, {});
}

function _renderMembersHTML(el, trip, fbMembers) {
  const notes      = trip.member_notes || {};
  const myDeviceId = DataManager.getDeviceId();

  // 合併來源：Firebase members（含 deviceId）+ shared.members（只有名字的舊格式）
  // 依 joinedAt 排序，第一位即為創建者
  const fbEntries = Object.entries(fbMembers).filter(([, m]) => m && m.name);
  fbEntries.sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
  const fbList  = fbEntries.map(([deviceId, m]) => ({ ...m, deviceId }));
  const fbNames = new Set(fbList.map(m => m.name));

  // 創建者 = joinedAt 最早的成員（本機行程則為 members[0]）
  const creatorDeviceId = fbList.length > 0 ? fbList[0].deviceId : null;
  const creatorName     = fbList.length > 0 ? fbList[0].name : (trip.members?.[0] || null);

  // 目前裝置是否已在 Firebase 成員清單中
  const myFbEntry = fbList.find(m => m.deviceId === myDeviceId);

  // shared.members 裡有但 Firebase members 沒有的名字（向下相容）
  const localOnly = (Array.isArray(trip.members) ? trip.members : [])
    .filter(name => !fbNames.has(name));

  const hasAny = fbList.length > 0 || localOnly.length > 0;

  let html = '<div class="more-card">';

  // 當前使用者是否為創建者
  const isCurrentUserCreator = myDeviceId === creatorDeviceId;

  if (!hasAny) {
    html += '<div class="no-items">還沒有成員</div>';
  } else {
    // Firebase 成員（有在線資訊）
    fbList.forEach(m => {
      const online    = m.lastSeen && (Date.now() - m.lastSeen < 60000);
      const initial   = m.name.charAt(0).toUpperCase();
      const isCreator = m.deviceId === creatorDeviceId;
      const isMe      = m.deviceId === myDeviceId;
      // 安全地將 deviceId 與 name 嵌入 onclick 屬性
      // JSON.stringify 加引號，encodeHTML 將 " 轉為 &quot; 避免破壞 HTML 屬性
      const dId  = encodeHTML(JSON.stringify(m.deviceId));
      const mName = encodeHTML(JSON.stringify(m.name));
      html += `
        <div class="member-list-item">
          <div class="member-list-avatar" style="background:${encodeHTML(m.color || '#4a7c59')}">${encodeHTML(initial)}</div>
          <div class="member-list-info">
            <div class="member-list-name">
              ${encodeHTML(m.name)}
              ${isCreator ? '<span class="member-tag creator">👑 創建者</span>' : ''}
              ${isMe && !isCreator ? '<span class="member-tag me">我</span>' : ''}
              <span class="online-dot ${online ? 'online' : 'offline'}"></span>
            </div>
            <div class="member-list-note">${notes[m.name] ? encodeHTML(notes[m.name]) : '<span style="color:var(--border)">尚無備註</span>'}</div>
          </div>
          <div class="member-list-actions">
            <button class="edit-icon-btn" onclick="openEditFbMemberModal(${dId}, ${mName})" title="編輯">✏️</button>
            ${isCurrentUserCreator ? `<button class="edit-icon-btn del" onclick="deleteFbMember(${dId}, ${mName})" title="刪除">🗑</button>` : ''}
          </div>
        </div>`;
    });
    // 純本機成員（無裝置資料，仍可顯示）
    localOnly.forEach(name => {
      const idx = trip.members.indexOf(name);   // 取得在 trip.members 中的正確索引
      const isCreator = fbList.length === 0 && name === creatorName;
      html += `
        <div class="member-list-item">
          <div class="member-list-avatar">${encodeHTML(name.charAt(0).toUpperCase())}</div>
          <div class="member-list-info">
            <div class="member-list-name">
              ${encodeHTML(name)}
              ${isCreator ? '<span class="member-tag creator">👑 創建者</span>' : ''}
            </div>
            <div class="member-list-note">${notes[name] ? encodeHTML(notes[name]) : '<span style="color:var(--border)">尚無備註</span>'}</div>
          </div>
          <div class="member-list-actions">
            <button class="edit-icon-btn" onclick="openEditMemberModal(${idx})" title="編輯">✏️</button>
            ${isCurrentUserCreator || !trip.shareCode ? `<button class="edit-icon-btn del" onclick="deleteMember(${idx})" title="刪除">🗑</button>` : ''}
          </div>
        </div>`;
    });
  }

  // 分享碼區塊
  if (trip.shareCode) {
    html += `
      <div class="share-code-section">
        <div class="share-code-label">分享碼（邀請旅伴加入）</div>
        <div class="share-code-row">
          <span class="share-code-value">${encodeHTML(trip.shareCode)}</span>
          <button class="btn-ghost-sm" onclick="navigator.clipboard.writeText('${encodeHTML(trip.shareCode)}').then(()=>showToast('已複製分享碼！'))">複製</button>
        </div>
      </div>`;
  }

  html += '</div>';
  html += `<button class="btn-submit" style="margin-top:12px" onclick="openAddMemberModal()">＋ 新增成員</button>`;

  // 退出行程按鈕（只有 Firebase 行程、且自己在成員清單中才顯示）
  if (trip.shareCode && myFbEntry) {
    html += `<button class="btn-submit" style="background:var(--danger)" onclick="confirmLeaveTrip()">退出行程</button>`;
  }

  el.innerHTML = html;
}

function confirmLeaveTrip() {
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) return;
  openModal(`
    <div class="modal-title">退出行程 <button class="modal-close" onclick="closeModal()">✕</button></div>
    <p style="margin:16px 0;color:var(--text)">確定要退出「${encodeHTML(trip.trip_name)}」嗎？</p>
    <p style="margin:-8px 0 16px;font-size:13px;color:var(--muted)">退出後，其他成員將不再看到你出現在成員頁面。你的首頁也會移除此行程。</p>
    <button class="btn-submit" style="background:var(--danger)" onclick="leaveTrip()">確定退出</button>
    <button class="btn-submit" style="background:var(--muted);margin-top:8px" onclick="closeModal()">取消</button>
  `);
}

async function leaveTrip() {
  const tripId = appState.currentTrip;
  const trip   = DataManager.getTrip(tripId);
  if (!trip) return;
  closeModal();

  const deviceId = DataManager.getDeviceId();
  const myName   = DataManager.getMyName();

  try {
    if (window.db && trip.shareCode) {
      // 從 Firebase members 移除自己的裝置記錄
      await db.ref(`trips/${tripId}/members/${deviceId}`).remove();

      // 從 shared.members 陣列中移除自己的名字
      if (myName) {
        const snap = await db.ref(`trips/${tripId}/shared/members`).once('value');
        const raw  = snap.val();
        const cur  = Array.isArray(raw) ? raw : (raw ? Object.values(raw) : []);
        await db.ref(`trips/${tripId}/shared/members`).set(cur.filter(n => n !== myName));
      }
    }
  } catch (e) {
    console.error('leaveTrip Firebase error:', e);
  }

  // 本機移除行程
  FirebaseManager.off(tripId);
  DataManager.deleteTrip(tripId);
  showToast('已退出行程');
  goHome();
}

function openAddMemberModal() {
  openModal(`
    <div class="modal-title">新增成員 <button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="form-group"><label>成員名稱 *</label>
      <input id="f-member-name" type="text" placeholder="例：小明" maxlength="20" /></div>
    <div class="form-group"><label>備註</label>
      <input id="f-member-note" type="text" placeholder="例：負責訂房、不吃海鮮..." /></div>
    <button class="btn-submit" onclick="addMember()">新增成員</button>
  `);
}

function addMember() {
  const name = document.getElementById('f-member-name').value.trim();
  const note = document.getElementById('f-member-note').value.trim();
  if (!name) { showToast('請輸入成員名稱', 'error'); return; }

  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) return;
  if (!Array.isArray(trip.members))  trip.members      = [];
  if (!trip.member_notes)            trip.member_notes = {};

  if (trip.members.includes(name)) { showToast('已有同名成員', 'error'); return; }
  trip.members.push(name);
  if (note) trip.member_notes[name] = note;

  DataManager.updateTrip(trip.id, trip);
  closeModal();
  showToast(`已新增成員「${name}」`);
  renderTripMembers();
  renderMembers(trip);
}

function openEditMemberModal(idx) {
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) return;
  const name = trip.members[idx];
  const note = (trip.member_notes || {})[name] || '';
  openModal(`
    <div class="modal-title">編輯成員 <button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="form-group"><label>成員名稱 *</label>
      <input id="f-edit-member-name" type="text" value="${encodeHTML(name)}" maxlength="20" /></div>
    <div class="form-group"><label>備註</label>
      <input id="f-edit-member-note" type="text" value="${encodeHTML(note)}" placeholder="例：負責訂房、不吃海鮮..." /></div>
    <button class="btn-submit" onclick="saveMember(${idx})">儲存變更</button>
  `);
}

function saveMember(idx) {
  const newName = document.getElementById('f-edit-member-name').value.trim();
  const newNote = document.getElementById('f-edit-member-note').value.trim();
  if (!newName) { showToast('請輸入成員名稱', 'error'); return; }

  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) return;
  const oldName = trip.members[idx];
  if (!trip.member_notes) trip.member_notes = {};

  if (newName !== oldName && trip.members.includes(newName)) {
    showToast('已有同名成員', 'error'); return;
  }

  trip.members[idx] = newName;
  if (oldName !== newName) {
    if (trip.member_notes[oldName] !== undefined) {
      trip.member_notes[newName] = trip.member_notes[oldName];
    }
    delete trip.member_notes[oldName];
  }
  if (newNote) trip.member_notes[newName] = newNote;
  else delete trip.member_notes[newName];

  DataManager.updateTrip(trip.id, trip);
  closeModal();
  showToast('已更新成員資訊');
  renderTripMembers();
  renderMembers(trip);
}

function deleteMember(idx) {
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) return;
  const name = trip.members[idx];
  trip.members.splice(idx, 1);
  if (trip.member_notes) delete trip.member_notes[name];
  DataManager.updateTrip(trip.id, trip);
  showToast(`已移除「${name}」`);
  renderTripMembers();
  renderMembers(trip);
}

// 編輯 Firebase 成員：自己可改名稱＋備註，他人只能改備註
function openEditFbMemberModal(deviceId, name) {
  const trip    = DataManager.getTrip(appState.currentTrip);
  if (!trip) return;
  const note    = (trip.member_notes || {})[name] || '';
  const isOwn   = deviceId === DataManager.getDeviceId();
  const dIdEnc  = encodeHTML(JSON.stringify(deviceId));
  const nameEnc = encodeHTML(JSON.stringify(name));
  openModal(`
    <div class="modal-title">編輯成員 <button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="form-group"><label>成員名稱${isOwn ? ' *' : ''}</label>
      ${isOwn
        ? `<input id="f-fb-member-name" type="text" value="${encodeHTML(name)}" maxlength="20" />`
        : `<div style="padding:10px 12px;background:var(--cream);border-radius:var(--radius-btn);font-size:15px;color:var(--muted)">${encodeHTML(name)}</div>`
      }
    </div>
    <div class="form-group"><label>備註</label>
      <input id="f-fb-member-note" type="text" value="${encodeHTML(note)}" placeholder="例：負責訂房、不吃海鮮..." /></div>
    <button class="btn-submit" onclick="saveEditFbMember(${dIdEnc}, ${nameEnc})">儲存變更</button>
  `);
}

async function saveEditFbMember(deviceId, oldName) {
  const trip = DataManager.getTrip(appState.currentTrip);
  if (!trip) return;

  const isOwn   = deviceId === DataManager.getDeviceId();
  const newName = isOwn
    ? (document.getElementById('f-fb-member-name')?.value.trim() || oldName)
    : oldName;
  const newNote = document.getElementById('f-fb-member-note').value.trim();

  if (!newName) { showToast('請輸入成員名稱', 'error'); return; }

  if (!trip.member_notes) trip.member_notes = {};

  // ── 步驟 1：先更新本機資料，讓後續任何 listener 觸發的 re-render 都能看到正確狀態 ──
  if (newName !== oldName) {
    if (Array.isArray(trip.members)) {
      trip.members = trip.members.map(n => (n === oldName ? newName : n));
    }
    if (trip.member_notes[oldName] !== undefined) {
      trip.member_notes[newName] = trip.member_notes[oldName];
      delete trip.member_notes[oldName];
    }
    if (isOwn) DataManager.setMyName(newName);
  }
  if (newNote) trip.member_notes[newName] = newNote;
  else delete trip.member_notes[newName];

  // 先 save 本機、關 modal、重繪
  DataManager.updateTrip(trip.id, trip);
  closeModal();
  showToast('已更新成員資訊');
  renderTripMembers();
  renderMembers(trip);

  // ── 步驟 2：寫入 Firebase（在本機已一致後才寫，listener 觸發時不會看到舊名） ──
  if (newName !== oldName && window.db && trip.shareCode) {
    const tripId = appState.currentTrip;
    // 標記本機寫入時間，讓 listenTrip 在 2 秒內不觸發 re-render
    appState.lastFbWriteTime = Date.now();
    try {
      await db.ref(`trips/${tripId}/members/${deviceId}/name`).set(newName);
      const snap = await db.ref(`trips/${tripId}/shared/members`).once('value');
      const raw  = snap.val();
      const cur  = Array.isArray(raw) ? raw : (raw ? Object.values(raw) : []);
      await db.ref(`trips/${tripId}/shared/members`).set(
        cur.map(n => (n === oldName ? newName : n))
      );
    } catch (e) {
      console.error('saveEditFbMember Firebase error:', e);
      showToast('名稱同步失敗，請重新整理', 'error');
    }
  }
}

// 創建者刪除 Firebase 成員
async function deleteFbMember(deviceId, name) {
  const tripId = appState.currentTrip;
  const trip   = DataManager.getTrip(tripId);
  if (!trip) return;

  try {
    if (window.db && trip.shareCode) {
      // 從 Firebase members 移除裝置記錄
      await db.ref(`trips/${tripId}/members/${deviceId}`).remove();
      // 從 shared.members 移除名字
      const snap = await db.ref(`trips/${tripId}/shared/members`).once('value');
      const raw  = snap.val();
      const cur  = Array.isArray(raw) ? raw : (raw ? Object.values(raw) : []);
      await db.ref(`trips/${tripId}/shared/members`).set(cur.filter(n => n !== name));
    }
  } catch (e) {
    console.error('deleteFbMember error:', e);
    showToast('刪除失敗，請再試一次', 'error'); return;
  }

  // 本機同步移除
  if (Array.isArray(trip.members)) trip.members = trip.members.filter(n => n !== name);
  if (trip.member_notes) delete trip.member_notes[name];
  DataManager.updateTripFromFirebase(tripId, { members: trip.members, member_notes: trip.member_notes });

  showToast(`已移除「${name}」`);
  renderTripMembers();
  renderMembers(trip);
}

// ═══════════════════════════════════════════════════════════
// 13. 打包清單頁（全域）
// ═══════════════════════════════════════════════════════════
function renderPacking() {
  const el   = document.getElementById('packing-list');
  const list = DataManager.getAll().packing;
  if (list.length === 0) { el.innerHTML = '<div class="no-items">清單是空的</div>'; return; }
  el.innerHTML = list.map(p => `
    <div class="packing-item">
      <input type="checkbox" class="packing-cb" id="pk-${encodeHTML(p.id)}" ${p.checked ? 'checked' : ''}
        onchange="togglePackingItem('${encodeHTML(p.id)}')" />
      <label for="pk-${encodeHTML(p.id)}" class="${p.checked ? 'checked' : ''}">${encodeHTML(p.text)}</label>
      <button class="btn-icon-del" onclick="deletePackingItem('${encodeHTML(p.id)}')">🗑</button>
    </div>`).join('');
}

function uncheckAllPacking() {
  DataManager.uncheckAllPacking();
  renderPacking();
  showToast('已取消所有勾選');
}

function openAddPackingModal() {
  openModal(`
    <div class="modal-title">新增打包項目 <button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="form-group"><label>項目名稱 *</label>
      <input id="f-pack-text" type="text" placeholder="例：護照、藥品..." /></div>
    <button class="btn-submit" onclick="addPackingItem()">新增</button>
  `);
}

function addPackingItem() {
  const text = document.getElementById('f-pack-text').value.trim();
  if (!text) { showToast('請輸入項目名稱', 'error'); return; }
  DataManager.addPackingItem({ id: genId('pk'), text, checked: false });
  closeModal();
  renderPacking();
  showToast('已新增項目');
}

function togglePackingItem(id) {
  DataManager.togglePackingItem(id);
  renderPacking();
}

function deletePackingItem(id) {
  DataManager.deletePackingItem(id);
  renderPacking();
  showToast('已刪除項目');
}

// ═══════════════════════════════════════════════════════════
// 14. 重新整理
// ═══════════════════════════════════════════════════════════
async function reloadApp() {
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) await reg.update();
    }
    // Clear all SW caches so next load fetches fresh CSS/JS from network
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch (_) { /* ignore, still reload */ }
  window.location.reload();
}

// ═══════════════════════════════════════════════════════════
// 15. 備份
// ═══════════════════════════════════════════════════════════
function downloadBackup() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const blob = new Blob([DataManager.exportAll()], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `travel-backup-${date}.json`; a.click();
  URL.revokeObjectURL(url);
  showToast('備份已下載');
}

// ═══════════════════════════════════════════════════════════
// 15. Collapsible
// ═══════════════════════════════════════════════════════════
function toggleCollapsible(id) {
  const card = document.getElementById(id);
  if (!card) return;
  const body = card.querySelector('.collapsible-body');
  if (!body) { card.classList.toggle('open'); return; }
  if (card.classList.contains('open')) {
    body.style.maxHeight = body.scrollHeight + 'px';
    card.classList.remove('open');
    requestAnimationFrame(() => { body.style.maxHeight = '0'; });
  } else {
    card.classList.add('open');
    body.style.maxHeight = body.scrollHeight + 'px';
    body.addEventListener('transitionend', () => {
      if (card.classList.contains('open')) body.style.maxHeight = 'none';
    }, { once: true });
  }
}

// ═══════════════════════════════════════════════════════════
// 16. Modal 共用
// ═══════════════════════════════════════════════════════════
function openModal(html) {
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal-overlay').classList.add('open');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}

function closeModalIfBackdrop(e) {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
}

// ═══════════════════════════════════════════════════════════
// 17. PWA
// ═══════════════════════════════════════════════════════════
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════════
// 18. 初始化
// ═══════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  DataManager.init();
  if (window.firebaseConfig) FirebaseManager.init();
  registerServiceWorker();
  renderHome();
});

window.addEventListener('beforeunload', () => {
  if (appState.currentTrip && window.db) {
    FirebaseManager.clearPresence(appState.currentTrip);
  }
});
