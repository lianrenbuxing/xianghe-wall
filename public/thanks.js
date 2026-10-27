const el = id => document.getElementById(id);
const THEME_KEY = 'xh_wall_theme_v1';
const COLORS = ['#ff5f8d', '#7b6cff', '#4f9dff', '#33c58e', '#ffab4f', '#ff6b6b', '#2bb6d6', '#e0b840'];

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function hostOf(link) {
  try {
    return new URL(link).hostname.replace(/^www\./, '');
  } catch {
    return '链接';
  }
}

function render(list) {
  const box = el('thanksList');
  if (!list.length) {
    box.innerHTML =
      '<div class="card empty"><div class="empty-emoji">💝</div><p>名单还空着，等第一个人被记下来～</p></div>';
    return;
  }

  box.innerHTML = list.map((t, i) => {
    const color = COLORS[i % COLORS.length];
    return '<article class="card thanks-card">' +
      '<div class="thanks-avatar" style="background:' + color + '">' +
        escapeHtml(String(t.name).slice(0, 1)) +
      '</div>' +
      '<div class="thanks-body">' +
        '<h3>' + escapeHtml(t.name) + '</h3>' +
        (t.note ? '<p>' + escapeHtml(t.note) + '</p>' : '') +
        (t.link
          ? '<a href="' + escapeHtml(t.link) + '" target="_blank" rel="noopener noreferrer">🔗 ' +
            escapeHtml(hostOf(t.link)) + '</a>'
          : '') +
      '</div>' +
    '</article>';
  }).join('');
}

async function load() {
  try {
    const res = await fetch('/api/thanks');
    if (!res.ok) throw new Error('bad status');
    const data = await res.json();
    render(Array.isArray(data.thanks) ? data.thanks : []);
  } catch (e) {
    el('thanksList').innerHTML =
      '<div class="card empty"><div class="empty-emoji">😢</div><p>名单加载失败，刷新试试～</p></div>';
  }
}

function initTheme() {
  const theme = localStorage.getItem(THEME_KEY) || 'light';
  document.body.dataset.theme = theme;
  el('themeBtn').textContent = theme === 'dark' ? '☀️' : '🌙';

  el('themeBtn').addEventListener('click', () => {
    const next = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
    document.body.dataset.theme = next;
    el('themeBtn').textContent = next === 'dark' ? '☀️' : '🌙';
    localStorage.setItem(THEME_KEY, next);
  });
}

initTheme();
load();
