import {checkReleaseUpdate, dismissReleaseUpdate} from './release-update.ts';
import '../styles/release-notice.css';

// Keep the notice outside the editor's render tree so a late check preserves unsaved input.
export function mountReleaseNotice(shell: HTMLElement, currentVersion: string) {
  const notice = document.createElement('aside');
  let disposed = false;
  void checkReleaseUpdate(currentVersion).then(update => {
    if (!update || disposed) return;
    notice.className = 'release-notice';
    notice.setAttribute('aria-label', '版本更新');
    const text = document.createElement('span');
    text.textContent = `新版本 v${update.version} 已发布（当前 v${currentVersion}）`;
    const link = document.createElement('a');
    link.href = update.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = '查看更新说明';
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = '关闭';
    dismiss.setAttribute('aria-label', '关闭此版本提醒');
    dismiss.onclick = () => { dismissReleaseUpdate(update.version); notice.remove(); };
    notice.append(text, link, dismiss);
    shell.querySelector('.topbar')?.after(notice);
  });
  return () => { disposed = true; notice.remove(); };
}
