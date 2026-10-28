(function (root) {
  async function refreshFeedbackControls(document) {
    await Promise.all([...document.querySelectorAll('.feedback-control')].map((box) => box.refreshFeedback?.()));
  }
  function feedbackControl({ document, getState, setValue, retry, isCurrent = () => true }) {
    const box = document.createElement('div'); box.className = 'feedback-control';
    const buttons = document.createElement('div'); buttons.className = 'feedback-buttons'; buttons.setAttribute('role', 'group'); buttons.setAttribute('aria-label', '评价这条帖子');
    const up = document.createElement('button'), down = document.createElement('button'), again = document.createElement('button');
    for (const button of [up, down, again]) { button.type = 'button'; button.className = 'icon-btn feedback-button'; }
    up.textContent = '👍 有用'; down.textContent = '👎 没帮助'; again.textContent = '重试同步'; again.hidden = true;
    up.title = '标记为有用，再点一次取消；会提交帖子内容用于改进 Daily Feed 筛选';
    down.title = '标记为没帮助，再点一次取消；会提交帖子内容用于改进筛选，不会在 X 上操作';
    const status = document.createElement('span'); status.className = 'feedback-status'; status.setAttribute('role', 'status');
    let value = 0, busy = false;
    box.refreshFeedback = async () => {
      try {
        const state = await getState(); if (!isCurrent()) return;
        value = state.value;
        up.setAttribute('aria-pressed', String(value === 1)); down.setAttribute('aria-pressed', String(value === -1));
        up.disabled = down.disabled = busy || state.pending;
        again.hidden = !state.pending; again.disabled = busy;
        status.textContent = state.pending ? '待同步 · 标记已保存在本机' : value ? '已同步 · 仅用于内容反馈' : '';
      } catch { if (isCurrent()) { status.textContent = '登录后可反馈'; up.disabled = down.disabled = true; } }
    };
    const act = async (fn) => {
      if (busy) return;
      busy = true; up.disabled = down.disabled = again.disabled = true; status.textContent = '正在保存…';
      let error = '', result;
      try { result = await fn(); } catch (e) { error = String(e.message || e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); }
      finally {
        busy = false;
        if (isCurrent()) {
          await box.refreshFeedback();
          await refreshFeedbackControls(document);
          if (error) status.textContent = error;
          else if (result?.conflict) status.textContent = result.message;
        }
      }
    };
    up.addEventListener('click', () => act(() => setValue(value === 1 ? 0 : 1)));
    down.addEventListener('click', () => act(() => setValue(value === -1 ? 0 : -1)));
    again.addEventListener('click', () => act(retry));
    buttons.append(up, down, again); box.append(buttons, status);
    queueMicrotask(() => box.refreshFeedback());
    return box;
  }
  const exports = { feedbackControl, refreshFeedbackControls };
  if (typeof module !== 'undefined') module.exports = exports;
  else Object.assign(root, exports);
})(globalThis);
