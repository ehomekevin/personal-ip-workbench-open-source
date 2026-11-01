// 本组合CI仅使用自有SQLite/HTTP与受控stdio；默认执行也拒绝真实CLI/外发。
import '../platform-layout-integration/guard-runtime.mjs';
import '../platform-layout-integration/consumer-intent.test.ts';
import '../platform-layout-integration/native-close-publication.test.ts';
import '../platform-layout-integration/native-repeat-query.test.ts';
