// Portable CI runs the new studio contract, HTTP/domain and UI state checks without native calls.
import '../image-studio/adapters.test.ts';
import '../image-studio/domain.test.ts';
import '../image-studio/ui-state.test.ts';
import '../image-studio/bounded-runner.test.ts';
import '../image-studio/native-brief.test.ts';
import '../image-studio/revision-r2.test.ts';
import '../image-studio/long-description-r2.test.ts';
import '../image-studio/prompt.test.ts';
import '../image-studio/runtime-capture.test.ts';
import '../image-studio/runtime-setup.test.ts';
import '../image-studio/path-output.test.ts';
import '../image-studio/audit-native-reads.test.ts';
// 关闭链、分析生命周期、审计组合护栏、应用层关闭顺序、生产预算闸门与执行器槽位共享。
import '../image-studio/brief-close-r3.test.ts';
import '../image-studio/analysis-lifecycle.test.ts';
import '../image-studio/audit-combination-r3.test.ts';
import '../image-studio/application-close.test.ts';
import '../image-studio/generation-budget.test.ts';
import '../image-studio/analysis-slots.test.ts';
import '../image-studio/brief-retry.test.ts';
// 网络找图：公网 URL 守卫逐项拒绝、原文抓取缓存、候选来源与导入/幂等/去重/采用/终稿。
import '../image-studio/web-guard.test.ts';
import '../image-studio/web-import.test.ts';
import '../image-studio/web-ui.test.ts';
// 网络找图缓存优先与后台抓取（同主题去重、7 天过期、失败可重试、关闭时中止）；配图弹窗归属与操作锁。
import '../image-studio/web-capture-background.test.ts';
import '../image-studio/web-import-feedback.test.ts';
import '../image-studio/dialog-ownership.test.ts';
// 生图真实进度：阶段映射、无历史保守默认、同渠道历史均值、不写回持久状态。
import '../image-studio/progress.test.ts';
