// Reused from personal-ip-content-os @ 6a15834; adapted for the local workbench.
import { lookup } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import type { LookupAddress } from 'node:dns';
import { WechatMpError } from './errors.ts';

const deniedV4 = new BlockList(), publicV6 = new BlockList(), deniedV6 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.0.0', 24], ['192.0.2.0', 24], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) deniedV4.addSubnet(address, prefix, 'ipv4');
// 仅全球单播地址；排除 IPv4 映射/兼容、ULA、链路本地、未指定及组播。
publicV6.addSubnet('2000::', 3, 'ipv6');
deniedV6.addSubnet('2002::', 16, 'ipv6'); // 6to4 内嵌 IPv4 不作为代理入口。
deniedV6.addSubnet('2001::', 32, 'ipv6'); // Teredo 隧道不作为代理入口。
deniedV6.addSubnet('2001:db8::', 32, 'ipv6');

export interface ProxyNetworkOptions {
  /** 仅内部测试显式注入；生产调用不传入，也不读取环境变量绕过。只允许回环测试服务器。 */
  testOnlyAllowLoopback?: boolean;
  resolveProxy?: (hostname: string) => Promise<LookupAddress[]>;
}
export function proxyHostname(hostname: string) { return hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase(); }

export function assertPublicProxyIp(address: string, testOnlyAllowLoopback = false): void {
  const family = isIP(address);
  if (testOnlyAllowLoopback && (address === '::1' || (family === 4 && address.startsWith('127.')))) return;
  if (family === 4 ? !deniedV4.check(address, 'ipv4') : family === 6
    && publicV6.check(address, 'ipv6') && !deniedV6.check(address, 'ipv6')) return;
  throw new WechatMpError('proxy_invalid');
}
export function assertPublicProxyHost(hostname: string, testOnlyAllowLoopback = false): void {
  const host = proxyHostname(hostname);
  if (isIP(host)) { assertPublicProxyIp(host, testOnlyAllowLoopback); return; }
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new WechatMpError('proxy_invalid');
}

/** 在真正 connect 的 lookup 钩子校验并交回同一组 IP，没有检查后再次解析的窗口。 */
export function checkedProxyLookup(options: ProxyNetworkOptions = {}): LookupFunction {
  const resolve = options.resolveProxy ?? ((hostname) => lookup(hostname, { all: true, verbatim: true }));
  return (hostname, lookupOptions, callback) => {
    void (async () => {
      try {
        assertPublicProxyHost(hostname, options.testOnlyAllowLoopback);
        const addresses = await resolve(hostname);
        if (!addresses.length) throw new WechatMpError('proxy_invalid');
        for (const entry of addresses) {
          if (isIP(entry.address) !== entry.family) throw new WechatMpError('proxy_invalid');
          assertPublicProxyIp(entry.address, options.testOnlyAllowLoopback);
        }
        const selected = lookupOptions.family ? addresses.filter((entry) => entry.family === lookupOptions.family) : addresses;
        if (!selected.length) throw new WechatMpError('proxy_invalid');
        if (lookupOptions.all) callback(null, selected);
        else callback(null, selected[0]!.address, selected[0]!.family);
      } catch { callback(new WechatMpError('proxy_invalid'), '', 0); }
    })();
  };
}
