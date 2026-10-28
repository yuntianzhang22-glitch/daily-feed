// Shared DOM component: source text remains readable during loading/failure.
(function (root) {
  function translationControl({ document, texts, translate, isCurrent = () => true }) {
    const box = document.createElement('div'); box.className = 'translation-control';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'icon-btn translation-button';
    button.textContent = '翻译成中文'; button.setAttribute('aria-expanded', 'false');
    const output = document.createElement('div'); output.className = 'translation-output'; output.hidden = true;
    const status = document.createElement('p'); status.className = 'translation-status'; status.setAttribute('role', 'status');
    let ready = false;
    button.addEventListener('click', async () => {
      if (ready) {
        output.hidden = !output.hidden;
        button.textContent = output.hidden ? '显示译文' : '收起译文';
        button.setAttribute('aria-expanded', String(!output.hidden)); return;
      }
      button.disabled = true; button.textContent = '正在翻译…'; status.textContent = '';
      try {
        const result = await translate(texts);
        if (!isCurrent()) return;
        if (!Array.isArray(result?.texts) || result.texts.length !== texts.length || result.texts.some((s) => typeof s !== 'string')) throw new Error('译文格式无效，请重试');
        const note = document.createElement('p'); note.className = 'translation-status'; note.textContent = '中文译文 · 机器翻译，仅供参考'; output.append(note);
        result.texts.forEach((text, i) => {
          if (!text.trim()) return;
          if (i > 0) { const label = document.createElement('p'); label.textContent = '引用内容'; label.className = 'translation-status'; output.append(label); }
          const paragraph = document.createElement('p'); paragraph.className = 'translation-text'; paragraph.textContent = text; output.append(paragraph);
        });
        ready = true; output.hidden = false; button.textContent = '收起译文'; button.setAttribute('aria-expanded', 'true');
      } catch (e) {
        if (isCurrent()) { status.textContent = String(e.message || e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); button.textContent = '重试翻译'; }
      } finally { button.disabled = false; }
    });
    box.append(button, status, output);
    return box;
  }
  if (typeof module !== 'undefined') module.exports = { translationControl };
  else root.translationControl = translationControl;
})(globalThis);
