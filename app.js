const WEBHOOK_URL = 'http://192.168.100.100:5678/webhook/hmlrnCh2eQpRD9cs/webhook/visited-place';
const QUEUE_KEY = 'visited_places_queue';

let currentRating = 3;
let currentLat = null;
let currentLon = null;

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

      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/reverse?lat=${currentLat}&lon=${currentLon}&format=json&accept-language=ja`,
          { headers: { 'User-Agent': 'visited-places-pwa/1.0' } }
        );
        const data = await res.json();
        const addr = data.display_name || '';
        addressInput.value = addr;
      } catch {
        // GPS取得はできたが住所変換失敗
      }

      btn.classList.remove('loading');
      btn.textContent = '✅';
      setTimeout(() => { btn.textContent = '📍'; }, 2000);
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
