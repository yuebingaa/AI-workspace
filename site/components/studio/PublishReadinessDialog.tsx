"use client";

import { useEffect, useRef } from "react";

interface PublishReadinessDialogProps {
  onDownloadBackup: () => void;
  onClose: () => void;
}

export function PublishReadinessDialog({ onDownloadBackup, onClose }: PublishReadinessDialogProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);
  return (
    <div className="publish-readiness-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="publish-readiness-dialog" role="dialog" aria-modal="true" aria-labelledby="publish-readiness-title">
        <header>
          <div><small>PUBLICATION READINESS</small><h2 id="publish-readiness-title">发布准备</h2></div>
          <button ref={closeButtonRef} type="button" aria-label="关闭发布准备说明" onClick={onClose}>×</button>
        </header>
        <p className="publish-readiness-intro">当前按钮不会直接提交代码或部署网站。正式公网版本由 GitHub / EdgeOne 发布流程完成，页面只负责说明边界并帮助你保存工作区。</p>
        <div className="publish-readiness-grid">
          <article><span>当前工作区</span><b>浏览器本地草稿</b><small>刷新可恢复；换浏览器前请下载备份。</small></article>
          <article><span>数据文件</span><b>不会随页面发布</b><small>原始 EDS 工作簿与临时 CSV 行数据不进入备份或静态站点。</small></article>
          <article><span>AI 密钥</span><b>仅服务端配置</b><small>DeepSeek API Key 不得写入浏览器变量、页面或工作区备份。</small></article>
          <article><span>域名与备案</span><b>由云平台生效</b><small>域名绑定、备案审核与真实备案号展示需要在部署环境完成。</small></article>
        </div>
        <aside>本地“已保存”不等于公网“已发布”。发布前还需独立完成生产构建、服务端环境变量、域名绑定与线上验收。</aside>
        <footer>
          <button type="button" onClick={onDownloadBackup}>先下载工作区备份</button>
          <button type="button" onClick={onClose}>我知道了</button>
        </footer>
      </section>
    </div>
  );
}
