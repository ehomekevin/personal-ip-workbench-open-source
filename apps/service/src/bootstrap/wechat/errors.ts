export class WechatMpError extends Error {
  readonly kind: 'proxy_invalid' | 'network' | 'invalid_response' | 'authentication' | 'ip_whitelist' | 'rate_limited';
  constructor(kind: WechatMpError['kind']) {
    super('公众号连接未完成：' + kind);
    this.kind = kind;
    this.name = 'WechatMpError';
  }
}
