import { Component, type ReactNode } from 'react';
// 子树渲染失败（如按需 chunk 加载失败、库内抛错）时换成 fallback，不让错误冒泡清空整个进度根。
export class FallbackBoundary extends Component<{ fallback: ReactNode; onError?(): void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError?.(); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
