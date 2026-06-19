/* @docusaurus/ExecutionEnvironment 的 Node 替身：Node 無 DOM，全部 false。
   供 esbuild 打包 sync-entry 時 alias 使用（GitHub Actions 與本地皆同）。 */
export default {
  canUseDOM: false,
  canUseEventListeners: false,
  canUseIntersectionObserver: false,
  canUseViewport: false,
};
