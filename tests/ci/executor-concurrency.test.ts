// 由现有 tests/ci glob 纳入 portable/CI，无需修改 root manifest 或锁文件。
import '../worker-concurrency/concurrency.test.ts';
import '../worker-concurrency/business.test.ts';
import '../worker-concurrency/lifecycle.test.ts';
import '../service-agent/concurrency.test.ts';
import '../service-agent/concurrency-guards.test.ts';
