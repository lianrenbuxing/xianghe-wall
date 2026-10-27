const API = '/api';
const el = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const TAGS = ['表白', '寻人', '祝福', '吐槽', '日常'];
const LOCAL_NAME = 'xh_wall_nick_v1';
const LIKED_KEY = 'xh_wall_liked_v1';
const THEME_KEY = 'xh_wall_theme_v1';

const state = { tag: '', sort: 'new', q: '', offset: 0, limit: 8, total: 0, loading: false };
const liked = new Set(JSON.parse(localStorage.getItem(LIKED_KEY) || '[]'));
const openComments = new Set();
let postTag = '表白';
let pending = [];
let loadSeq = 0; // 每次筛选/排序都会 ++，用来丢弃过期的请求结果
let publishing = false;

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function relTime(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + ' 分钟前';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时前';
  const d = Math.floor(h / 24);
  if (d < 7) return d + ' 天前';
  const t = new Date(ts);
  return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
}

let toastTimer;
function toast(msg) {
  const t = el('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

async function api(path, options) {
  const res = await fetch(API + path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '网络出错了，稍后再试');
  return data;
}

function compress(file, maxSide = 1200, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('压缩失败'))), 'image/jpeg', quality);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片读取失败'));
    };
    img.src = url;
  });
}

function normalizeImages(imgs) {
  if (!imgs) return [];
  if (Array.isArray(imgs)) return imgs.filter(x => typeof x === 'string');
  if (typeof imgs === 'string') {
    try {
      const parsed = JSON.parse(imgs);
      return Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string') : [];
    } catch (e) {
      return [imgs];
    }
  }
  return [];
}

function renderTagChips() {
  el('tagList').innerHTML = TAGS.map(t =>
    '<button class="chip ' + (t === postTag ? 'active' : '') + '" data-tag="' + t + '">#' + t + '</button>'
  ).join('');
}

function renderFilterTabs() {
  const all = [{ v: '', label: '全部' }, ...TAGS.map(t => ({ v: t, label: t }))];
  el('filterTabs').innerHTML = all.map(o =>
    '<button class="tab ' + (o.v === state.tag ? 'active' : '') + '" data-filter="' + o.v + '">' + o.label + '</button>'
  ).join('');
}

function renderPreview() {
  const box = el('preview');
  box.innerHTML = '';
  pending.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'thumb';
    const img = document.createElement('img');
    img.src = p.url;
    img.alt = '预览';
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.dataset.del = String(i);
    div.appendChild(img);
    div.appendChild(del);
    box.appendChild(div);
  });
}

function postHTML(p) {
  const isLiked = liked.has(p.id);
  const isOpen = openComments.has(p.id);
  return '<div class="post-head">' +
    '<div class="avatar" style="background:' + escapeHtml(p.color) + '">' + escapeHtml(p.name.slice(0, 1)) + '</div>' +
    '<div class="meta">' +
      '<div class="name">' + escapeHtml(p.name) + '</div>' +
      '<div class="sub">' + relTime(p.created_at) + '</div>' +
    '</div>' +
    '<span class="tag-badge">#' + escapeHtml(p.tag) + '</span>' +
   (p.pinned ? '<span class="pin-badge">📌 置顶</span>' : '') +
  '</div>' +
  '<div class="post-body">' + escapeHtml(p.text) + '</div>' +
  '<div class="post-actions">' +
    '<button class="act ' + (isLiked ? 'liked' : '') + '" data-action="like">' +
      '<span class="heart">' + (isLiked ? '❤' : '🤍') + '</span> <span class="like-num">' + p.likes + '</span>' +
    '</button>' +
    '<button class="act" data-action="comment">💬 <span class="c-num">' + p.comment_count + '</span></button>' +
  '</div>' +
  '<div class="comments ' + (isOpen ? 'open' : '') + '">' +
    '<div class="c-list"><div class="loading-tip">加载中…</div></div>' +
    '<div class="comment-form">' +
      '<input class="c-input" maxlength="120" placeholder="匿名回复…" />' +
      '<button class="c-send" data-action="send">发送</button>' +
    '</div>' +
  '</div>';
}

async function loadPosts(reset = false) {
  if (reset) {
    state.offset = 0;
    el('feed').innerHTML = '';
  } else if (state.loading) {
    return;
  }
  if (state.total !== 0 && state.offset >= state.total) return;

  const seq = ++loadSeq;
  state.loading = true;

  try {
    const qs = new URLSearchParams({
      tag: state.tag,
      sort: state.sort,
      q: state.q,
      limit: state.limit,
      offset: state.offset
    });
    const data = await api('/posts?' + qs.toString());
    if (seq !== loadSeq) return; // 用户已经切到别的筛选条件，旧结果直接丢掉
    state.total = data.total;
    state.offset += data.posts.length;

    if (reset && !data.posts.length) {
      el('feed').innerHTML =
        '<div class="card empty"><div class="empty-emoji">💌</div><p>这里还空空的，来写下第一条表白吧～</p></div>';
    } else {
      data.posts.forEach(p => {
        const card = document.createElement('article');
        card.className = 'card post';
        card.dataset.id = String(p.id);
        card.innerHTML = postHTML(p);
        el('feed').appendChild(card);

        const imgs = normalizeImages(p.images);
        if (imgs.length) {
          const grid = document.createElement('div');
          grid.className = 'img-grid count-' + Math.min(imgs.length, 3);
          imgs.forEach(src => {
            const img = document.createElement('img');
            img.src = src;
            img.alt = '照片';
            img.loading = 'lazy';
            img.dataset.img = src;
            grid.appendChild(img);
          });
          const body = card.querySelector('.post-body');
          if (body) body.after(grid);
        }

        if (openComments.has(p.id)) loadComments(card, p.id);
      });
    }
  } catch (e) {
    if (seq === loadSeq) toast(e.message);
  } finally {
    if (seq === loadSeq) state.loading = false;
  }
}

async function loadComments(card, id) {
  const list = card.querySelector('.c-list');
  if (!list) return;
  try {
    const data = await api('/posts/' + id + '/comments');
    list.innerHTML = data.comments.length
      ? data.comments.map(c =>
          '<div class="comment"><span class="c-name">' + escapeHtml(c.name) + '</span>' +
          '<span class="c-text">' + escapeHtml(c.text) + '</span></div>'
        ).join('')
      : '<div class="comment" style="color:var(--muted)">还没有回复，来抢沙发～</div>';
  } catch (e) {
    list.innerHTML = '<div class="comment" style="color:var(--muted)">评论加载失败</div>';
  }
}

async function publish() {
  if (publishing) return;
  const text = el('contentInput').value.trim();
  const name = el('nickInput').value.trim();
  if (!text) return toast('先写点什么再发布吧 ✍️');

  publishing = true;
  el('postBtn').disabled = true;
  el('postBtn').textContent = '发布中…';

  try {
    const fd = new FormData();
    fd.append('text', text);
    fd.append('name', name);
    fd.append('tag', postTag);
    pending.forEach((p, i) => fd.append('images', p.blob, 'photo-' + i + '.jpg'));

    await api('/posts', { method: 'POST', body: fd });

    if (name) localStorage.setItem(LOCAL_NAME, name);
    el('contentInput').value = '';
    pending.forEach(p => URL.revokeObjectURL(p.url));
    pending = [];
    renderPreview();
    updateCounter();

    state.sort = 'new';
    el('sortSelect').value = 'new';
    await loadPosts(true);
    updateStats();
    toast('发布成功，愿你的心意被看见 💗');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) {
    toast(e.message);
  } finally {
    publishing = false;
    el('postBtn').disabled = false;
    el('postBtn').textContent = '发布表白';
  }
}

function updateCounter() {
  el('counter').textContent = el('contentInput').value.length + ' / 500';
}

async function updateStats() {
  try {
    const s = await api('/stats');
    el('statBox').textContent = '💌 ' + s.posts + ' 条表白 · ❤ ' + s.likes + ' · 💬 ' + s.comments;
  } catch (e) {}
}

function bind() {
  el('tagList').addEventListener('click', e => {
    const btn = e.target.closest('[data-tag]');
    if (!btn) return;
    postTag = btn.dataset.tag;
    renderTagChips();
  });

  el('contentInput').addEventListener('input', updateCounter);

  el('fileInput').addEventListener('change', async e => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    for (const f of files) {
      if (pending.length >= 3) { toast('最多上传 3 张照片哦'); break; }
      if (!f.type.startsWith('image/')) { toast('只能上传图片文件'); continue; }
      try {
        const blob = await compress(f);
        pending.push({ blob, url: URL.createObjectURL(blob) });
        renderPreview();
      } catch (err) {
        toast(err.message);
      }
    }
  });

  el('preview').addEventListener('click', e => {
    const btn = e.target.closest('[data-del]');
    if (!btn) return;
    const i = Number(btn.dataset.del);
    URL.revokeObjectURL(pending[i].url);
    pending.splice(i, 1);
    renderPreview();
  });

  el('postBtn').addEventListener('click', publish);

  el('filterTabs').addEventListener('click', e => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    state.tag = btn.dataset.filter;
    renderFilterTabs();
    loadPosts(true);
  });

  el('sortSelect').addEventListener('change', e => {
    state.sort = e.target.value;
    loadPosts(true);
  });

  let searchTimer;
  el('searchInput').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = e.target.value.trim();
      loadPosts(true);
    }, 260);
  });

  el('feed').addEventListener('click', async e => {
    const img = e.target.closest('[data-img]');
    if (img) {
      el('lightboxImg').src = img.dataset.img;
      el('lightbox').classList.add('show');
      return;
    }

    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const card = e.target.closest('.post');
    if (!card) return;
    const id = card.dataset.id;
    const action = btn.dataset.action;

    if (action === 'like') {
      const isLiked = liked.has(id);
      const delta = isLiked ? -1 : 1;
      const numEl = card.querySelector('.like-num');
      const heartEl = card.querySelector('.heart');
      const prevCount = Number(numEl.textContent) || 0;

      const paint = on => {
        btn.classList.toggle('liked', on);
        heartEl.textContent = on ? '❤' : '🤍';
        numEl.textContent = on ? prevCount + 1 : Math.max(0, prevCount - 1);
      };

      if (isLiked) liked.delete(id); else liked.add(id);
      paint(!isLiked);
      localStorage.setItem(LIKED_KEY, JSON.stringify([...liked]));

      try {
        const data = await api('/posts/' + id + '/like', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ delta })
        });
        numEl.textContent = data.likes;
      } catch (err) {
        // 请求失败就把本地的乐观更新回滚，避免点赞数和服务器不一致
        if (isLiked) liked.add(id); else liked.delete(id);
        paint(isLiked);
        numEl.textContent = prevCount;
        localStorage.setItem(LIKED_KEY, JSON.stringify([...liked]));
        toast(err.message);
      }

    } else if (action === 'comment') {
      const box = card.querySelector('.comments');
      const willOpen = !box.classList.contains('open');
      box.classList.toggle('open', willOpen);
      if (willOpen) {
        openComments.add(id);
        loadComments(card, id);
        const inp = card.querySelector('.c-input');
        if (inp) inp.focus();
      } else {
        openComments.delete(id);
      }

    } else if (action === 'send') {
      const input = card.querySelector('.c-input');
      const text = (input.value || '').trim();
      if (!text) return toast('回复内容不能为空');

      try {
        await api('/posts/' + id + '/comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        });
        input.value = '';
        await loadComments(card, id);
        const cNum = card.querySelector('.c-num');
        if (cNum) cNum.textContent = (Number(cNum.textContent) || 0) + 1;
        updateStats();
      } catch (err) {
        toast(err.message);
      }
    }
  });

  el('feed').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.classList.contains('c-input')) {
      e.preventDefault();
      const post = e.target.closest('.post');
      const send = post.querySelector('[data-action="send"]');
      if (send) send.click();
    }
  });

  el('lightbox').addEventListener('click', () => el('lightbox').classList.remove('show'));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') el('lightbox').classList.remove('show');
  });

  el('themeBtn').addEventListener('click', () => {
    const next = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
    document.body.dataset.theme = next;
    el('themeBtn').textContent = next === 'dark' ? '☀️' : '🌙';
    localStorage.setItem(THEME_KEY, next);
  });

  const io = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting && !state.loading && state.offset < state.total) {
      loadPosts(false);
    }
  }, { rootMargin: '300px' });
  io.observe(el('sentinel'));
}

function startHearts() {
  const canvas = el('hearts');
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const ctx = canvas.getContext('2d');
  let w, h;
  let hearts = [];

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  const spawn = () => {
    hearts.push({
      x: Math.random() * w,
      y: h + 20,
      size: 10 + Math.random() * 16,
      speed: 0.35 + Math.random() * 0.8,
      drift: (Math.random() - 0.5) * 0.5,
      alpha: 0.07 + Math.random() * 0.16,
      rot: (Math.random() - 0.5) * 0.5
    });
  };

  const drawHeart = (x, y, s, rot, alpha) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#ff5f8d';
    ctx.beginPath();
    ctx.moveTo(0, s * 0.3);
    ctx.bezierCurveTo(0, 0, -s * 0.5, 0, -s * 0.5, s * 0.35);
    ctx.bezierCurveTo(-s * 0.5, s * 0.7, 0, s * 0.85, 0, s * 1.1);
    ctx.bezierCurveTo(0, s * 0.85, s * 0.5, s * 0.7, s * 0.5, s * 0.35);
    ctx.bezierCurveTo(s * 0.5, 0, 0, 0, 0, s * 0.3);
    ctx.fill();
    ctx.restore();
  };

  let last = 0;
  function tick(t) {
    ctx.clearRect(0, 0, w, h);
    if (hearts.length < 26 && t - last > 550) {
      spawn();
      last = t;
    }
    hearts = hearts.filter(p => p.y > -60);
    for (const p of hearts) {
      p.y -= p.speed;
      p.x += p.drift;
      drawHeart(p.x, p.y, p.size, p.rot, p.alpha);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

(function init() {
  const theme = localStorage.getItem(THEME_KEY) || 'light';
  document.body.dataset.theme = theme;
  el('themeBtn').textContent = theme === 'dark' ? '☀️' : '🌙';

  el('nickInput').value = localStorage.getItem(LOCAL_NAME) || '';
  renderTagChips();
  renderFilterTabs();
  renderPreview();
  updateCounter();
  bind();
  loadPosts(true);
  updateStats();
  startHearts();
})();
