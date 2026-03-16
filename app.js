const WEBHOOK_URL = 'http://192.168.100.100:5678/webhook/hmlrnCh2eQpRD9cs/webhook/visited-place';
const QUEUE_KEY = 'visited_places_queue';

let currentRating = 3;
let currentLat = null;
let currentLon = null;
let shopNameDebounceTimer = null;

// OSM amenity → カテゴリ and icon mapping
const AMENITY_MAP = {
  restaurant:   { label: 'レストラン・和食', icon: '🍽️' },
  cafe:         { label: 'カフェ・喫茶店',  icon: '☕' },
  bar:          { label: '居酒屋・バー',    icon: '🍺' },
  pub:          { label: '居酒屋・バー',    icon: '🍺' },
  fast_food:    { label: 'ファストフード',  icon: '🍔' },
  food_court:   { label: 'ファストフード',  icon: '🍔' },
  ice_cream:    { label: 'スイーツ・デザート', icon: '🍦' },
  bakery:       { label: 'スイーツ・デザート', icon: '🥐' },
  default:      { label: 'その他',          icon: '🏪' },
};

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  setTodayDate();
  initStars();
  loadQueue();
  checkOnline();

  window.addEventListener('online', () => { checkOnline(); trySendQueue(); });
  window.addEventListener('offline', checkOnline);

  document.getElementById('form').addEventListener('submit', handleSubmit);
  document.getElementById('btn-gps').addEventListener('click', getGPS);

  // 店名入力 → 住所オートコンプリート
  const shopInput = document.getElementById('shopName');
  shopInput.addEventListener('input', onShopNameInput);
  shopInput.addEventListener('blur', () => setTimeout(() => hideSuggestions('shop-suggestions'), 200));

  // 住所フィールド外クリックでサジェスト閉じる
  document.getElementById('address').addEventListener('blur', () => setTimeout(() => hideSuggestions('nearby-suggestions'), 200));
});

function setTodayDate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  document.getElementById('visitDate').value = `${yyyy}-${mm}-${dd}`;
}

// --- Stars ---
function initStars() {
  const stars = document.querySelectorAll('.star-rating span');
  setStars(currentRating, stars);
  stars.forEach((star, i) => {
    star.addEventListener('click', () => {
      currentRating = i + 1;
      setStars(currentRating, stars);
    });
    star.addEventListener('touchend', e => {
      e.preventDefault();
      currentRating = i + 1;
      setStars(currentRating, stars);
    });
  });
}

function setStars(rating, stars) {
  stars.forEach((s, i) => {
    s.classList.toggle('active', i < rating);
    s.textContent = i < rating ? '★' : '☆';
  });
}

// --- 店名 → 住所オートコンプリート (Nominatim) ---
function onShopNameInput() {
  const q = document.getElementById('shopName').value.trim();
  clearTimeout(shopNameDebounceTimer);
  if (q.length < 2) { hideSuggestions('shop-suggestions'); return; }
  shopNameDebounceTimer = setTimeout(() => searchShopByName(q), 500);
}

async function searchShopByName(q) {
  const el = document.getElementById('shop-suggestions');
  showSuggestionsLoading(el, '店名を検索中...');

  // 現在地がある場合は近くの結果を優先
  const viewbox = currentLat && currentLon
    ? `&viewbox=${(+currentLon-0.05).toFixed(4)},${(+currentLat+0.05).toFixed(4)},${(+currentLon+0.05).toFixed(4)},${(+currentLat-0.05).toFixed(4)}&bounded=0`
    : '';

  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5&accept-language=ja&countrycodes=jp&addressdetails=1${viewbox}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'visited-places-pwa/1.0' } });
    const results = await res.json();

    if (!results.length) { hideSuggestions('shop-suggestions'); return; }

    const items = results.map(r => ({
      name: r.namedetails?.name || r.display_name.split(',')[0],
      addr: r.display_name,
      lat: parseFloat(r.lat).toFixed(6),
      lon: parseFloat(r.lon).toFixed(6),
      icon: getOsmIcon(r.type, r.class),
    }));

    showSuggestions(el, items, (item) => {
      document.getElementById('shopName').value = item.name;
      document.getElementById('address').value = item.addr;
      currentLat = item.lat;
      currentLon = item.lon;
      document.getElementById('coords-display').textContent = `${item.lat}, ${item.lon}`;
      hideSuggestions('shop-suggestions');
    });
  } catch {
    hideSuggestions('shop-suggestions');
  }
}

// --- GPS → 近くの店候補 (Overpass API) ---
async function searchNearbyPlaces(lat, lon) {
  const el = document.getElementById('nearby-suggestions');
  showSuggestionsLoading(el, '近くの店を検索中...');

  try {
    const radius = 300;
    const query = `[out:json][timeout:8];(node(around:${radius},${lat},${lon})[amenity~"restaurant|cafe|bar|pub|fast_food|food_court|bakery|ice_cream"];);out 10;`;
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: query,
    });
    const data = await res.json();
    const elements = data.elements || [];

    if (!elements.length) {
      el.innerHTML = '<div class="suggestion-loading">近くに店舗が見つかりませんでした</div>';
      el.hidden = false;
      setTimeout(() => hideSuggestions('nearby-suggestions'), 2000);
      return;
    }

    const items = elements.map(e => {
      const tags = e.tags || {};
      const amenity = tags.amenity || 'default';
      const info = AMENITY_MAP[amenity] || AMENITY_MAP.default;
      const name = tags.name || tags['name:ja'] || '名称不明';
      const addrParts = [tags['addr:province'], tags['addr:city'], tags['addr:suburb'], tags['addr:street'], tags['addr:housenumber']].filter(Boolean);
      const addr = addrParts.join('') || '';
      return {
        name,
        addr,
        lat: e.lat.toFixed(6),
        lon: e.lon.toFixed(6),
        icon: info.icon,
        category: info.label,
      };
    }).filter(item => item.name !== '名称不明' || items.length <= 3);

    showSuggestions(el, items, (item) => {
      if (!document.getElementById('shopName').value.trim()) {
        document.getElementById('shopName').value = item.name;
      }
      if (item.addr) document.getElementById('address').value = item.addr;
      currentLat = item.lat;
      currentLon = item.lon;
      document.getElementById('coords-display').textContent = `${item.lat}, ${item.lon}`;
      if (item.category) {
        const catMap = {
          'カフェ・喫茶店': 'カフェ・喫茶店',
          '居酒屋・バー': '居酒屋・バー',
          'ファストフード': 'ファストフード',
          'スイーツ・デザート': 'スイーツ・デザート',
        };
        const sel = document.getElementById('category');
        for (const opt of sel.options) {
          if (opt.value === item.category) { sel.value = item.category; break; }
        }
      }
      hideSuggestions('nearby-suggestions');
    });
  } catch {
    hideSuggestions('nearby-suggestions');
  }
}

function getOsmIcon(type, cls) {
  const t = type || cls || '';
  if (t.includes('restaurant') || t.includes('food')) return '🍽️';
  if (t.includes('cafe') || t.includes('coffee')) return '☕';
  if (t.includes('bar') || t.includes('pub')) return '🍺';
  if (t.includes('fast')) return '🍔';
  if (t.includes('bakery') || t.includes('ice')) return '🍰';
  return '🏪';
}

function showSuggestions(el, items, onSelect) {
  el.innerHTML = '';
  items.forEach(item => {
    const div = document.createElement('div');
    div.className = 'suggestion-item';
    div.innerHTML = `<span class="suggestion-icon">${item.icon}</span><div class="suggestion-text"><div class="suggestion-name">${escHtml(item.name)}</div>${item.addr ? `<div class="suggestion-addr">${escHtml(item.addr)}</div>` : ''}</div>`;
    div.addEventListener('mousedown', (e) => { e.preventDefault(); onSelect(item); });
    div.addEventListener('touchend', (e) => { e.preventDefault(); onSelect(item); });
    el.appendChild(div);
  });
  el.hidden = false;
}

function showSuggestionsLoading(el, msg) {
  el.innerHTML = `<div class="suggestion-loading">${msg}</div>`;
  el.hidden = false;
}

function hideSuggestions(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = true;
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// --- GPS ---
async function getGPS() {
  const btn = document.getElementById('btn-gps');
  const addressInput = document.getElementById('address');
  const coordsDisplay = document.getElementById('coords-display');

  btn.classList.add('loading');
  btn.textContent = '↻';

  if (!navigator.geolocation) {
    showToast('GPS非対応のブラウザです', 'error');
    btn.classList.remove('loading');
    btn.textContent = '📍';
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      currentLat = pos.coords.latitude.toFixed(6);
      currentLon = pos.coords.longitude.toFixed(6);
      coordsDisplay.textContent = `${currentLat}, ${currentLon}`;

      // 逆ジオコーディングで住所取得
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/reverse?lat=${currentLat}&lon=${currentLon}&format=json&accept-language=ja`,
          { headers: { 'User-Agent': 'visited-places-pwa/1.0' } }
        );
        const data = await res.json();
        if (data.display_name) addressInput.value = data.display_name;
      } catch { /* 住所変換失敗は無視 */ }

      btn.classList.remove('loading');
      btn.textContent = '✅';
      setTimeout(() => { btn.textContent = '📍'; }, 2000);

      // 近くの店候補を表示
      searchNearbyPlaces(currentLat, currentLon);
    },
    (err) => {
      const msgs = {
        1: '位置情報の許可が必要です（設定からサイトの権限を確認してください）',
        2: '位置情報を取得できませんでした',
        3: '位置情報の取得がタイムアウトしました',
      };
      showToast(msgs[err.code] || '位置情報の取得に失敗しました', 'error');
      btn.classList.remove('loading');
      btn.textContent = '📍';
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

// --- Submit ---
async function handleSubmit(e) {
  e.preventDefault();

  const shopName = document.getElementById('shopName').value.trim();
  if (!shopName) {
    showToast('店名を入力してください', 'error');
    document.getElementById('shopName').focus();
    return;
  }

  const priceVal = document.getElementById('price').value;
  const payload = {
    shopName,
    visitDate: document.getElementById('visitDate').value,
    rating: currentRating,
    price: priceVal ? parseInt(priceVal) : null,
    category: document.getElementById('category').value,
    address: document.getElementById('address').value.trim(),
    memo: document.getElementById('memo').value.trim(),
    latitude: currentLat,
    longitude: currentLon,
  };

  const btn = document.getElementById('btn-submit');
  btn.disabled = true;
  btn.textContent = '送信中...';

  if (navigator.onLine) {
    const ok = await sendPayload(payload);
    if (ok) {
      showToast('記録しました！', 'success');
      resetForm();
    } else {
      enqueue(payload);
      showToast('送信失敗。オフラインキューに保存しました', 'error');
    }
  } else {
    enqueue(payload);
    showToast('オフライン保存。次回接続時に送信します', 'success');
  }

  btn.disabled = false;
  btn.innerHTML = '📝 記録する';
}

async function sendPayload(payload) {
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function resetForm() {
  document.getElementById('shopName').value = '';
  document.getElementById('price').value = '';
  document.getElementById('category').value = '';
  document.getElementById('address').value = '';
  document.getElementById('memo').value = '';
  document.getElementById('coords-display').textContent = '';
  hideSuggestions('shop-suggestions');
  hideSuggestions('nearby-suggestions');
  currentLat = null;
  currentLon = null;
  currentRating = 3;
  initStars();
  setTodayDate();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// --- Offline Queue ---
function enqueue(payload) {
  const q = getQueue();
  q.push({ ...payload, _queuedAt: new Date().toISOString() });
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  loadQueue();
}

function getQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; }
}

function loadQueue() {
  const q = getQueue();
  const el = document.getElementById('queue-info');
  if (q.length > 0) {
    el.textContent = `📦 オフラインキュー: ${q.length}件（オンライン復帰時に自動送信）`;
    el.classList.add('visible');
  } else {
    el.classList.remove('visible');
  }
}

async function trySendQueue() {
  const q = getQueue();
  if (q.length === 0) return;

  const failed = [];
  for (const item of q) {
    const ok = await sendPayload(item);
    if (!ok) failed.push(item);
  }

  localStorage.setItem(QUEUE_KEY, JSON.stringify(failed));
  loadQueue();

  if (failed.length < q.length) {
    showToast(`${q.length - failed.length}件を送信しました`, 'success');
  }
}

// --- Online/Offline ---
function checkOnline() {
  document.body.classList.toggle('offline', !navigator.onLine);
}

// --- Toast ---
let toastTimer;
function showToast(msg, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.classList.remove('show'); }, 3000);
}
