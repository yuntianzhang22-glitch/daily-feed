// 抓取计划：每周哪几天 + 几点。纯函数，主进程调度、配置清洗和费用估算共用。
// days 用 Date#getDay() 的编号：0=周日，1=周一 … 6=周六。

const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
// 界面和文案里按周一到周日排
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DEFAULT_DAYS = [1, 4];
const DEFAULT_TIME = '09:00';

const pad = (n) => String(n).padStart(2, '0');

function cleanDays(days) {
  const set = new Set();
  for (const d of Array.isArray(days) ? days : []) {
    const n = Number(d);
    if (Number.isInteger(n) && n >= 0 && n <= 6) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

function cleanTime(t, fallback = DEFAULT_TIME) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(t ?? '').trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return fallback;
  return `${pad(h)}:${pad(mi)}`;
}

// 旧版「每 N 小时」换算成每周几天：≤24 小时为每天，其余按每周次数从周一起均匀分布
function daysFromInterval(hours) {
  if (hours === undefined || hours === null || hours === '') return [...DEFAULT_DAYS];
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) return [];
  if (h <= 24) return [0, 1, 2, 3, 4, 5, 6];
  const n = Math.max(1, Math.min(7, Math.round(168 / h)));
  return cleanDays(Array.from({ length: n }, (_, i) => (1 + Math.floor((i * 7) / n)) % 7));
}

function slotOn(date, time) {
  const [h, m] = cleanTime(time).split(':').map(Number);
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d;
}

// from 之后（不含）最近的一个抓取时间点
function nextSlot(days, time, from = new Date()) {
  days = cleanDays(days);
  if (!days.length) return null;
  for (let i = 0; i <= 7; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    const s = slotOn(d, time);
    if (days.includes(s.getDay()) && s > from) return s;
  }
  return null;
}

// from 之前（含）最近的一个抓取时间点，用来判断是否错过了
function prevSlot(days, time, from = new Date()) {
  days = cleanDays(days);
  if (!days.length) return null;
  for (let i = 0; i <= 7; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() - i);
    const s = slotOn(d, time);
    if (days.includes(s.getDay()) && s <= from) return s;
  }
  return null;
}

// 一周内相邻两次抓取之间隔多少小时，如周一、周四 → [72, 96]
function weeklyGapsHours(days) {
  days = cleanDays(days);
  return days.map((d, i) => {
    const next = days[(i + 1) % days.length];
    return (((next - d + 7) % 7) || 7) * 24;
  });
}

function describeDays(days) {
  days = cleanDays(days);
  if (!days.length) return '不自动抓取';
  if (days.length === 7) return '每天';
  const key = days.join(',');
  if (key === '1,2,3,4,5') return '工作日';
  if (key === '0,6') return '周末';
  return DAY_ORDER.filter((d) => days.includes(d)).map((d) => DAY_NAMES[d]).join('、');
}

module.exports = {
  DAY_NAMES, DAY_ORDER, DEFAULT_DAYS, DEFAULT_TIME,
  cleanDays, cleanTime, daysFromInterval, nextSlot, prevSlot, weeklyGapsHours, describeDays,
};
