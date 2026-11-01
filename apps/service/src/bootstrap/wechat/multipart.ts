// Reused from personal-ip-content-os @ 6a15834; adapted for the local workbench.
import { randomBytes } from 'node:crypto';

export type WechatImageMime = 'image/png' | 'image/jpeg';

/** 非 ASCII 文件名换成 image.png / image.jpg：微信按文件名后缀判断类型，非 ASCII 文件名有被误判的先例。 */
export function wechatUploadFilename(filename: string, mime: WechatImageMime): string {
  return /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(filename) && !/["\\]/.test(filename)
    ? filename : `image.${mime === 'image/png' ? 'png' : 'jpg'}`;
}

/**
 * 自己拼 multipart/form-data，只有一个文件字段 media（uploadimg 与 add_material 共用）。
 * 请求体是普通字节，Content-Type 显式带 boundary，不依赖发请求的是哪个 fetch：
 * undici 包的 fetch 只认它自己的 FormData 类，全局 FormData 会被转成 17 字节的 "[object FormData]"。
 */
export function wechatImageMultipart(bytes: Buffer, filename: string, mime: WechatImageMime) {
  let boundary: string;
  do boundary = `----ipos-wechat-${randomBytes(16).toString('hex')}`; while (bytes.includes(boundary));
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${wechatUploadFilename(filename, mime)}"\r\n`
    + `Content-Type: ${mime}\r\n\r\n`, 'ascii');
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'ascii');
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0); body.set(bytes, head.length); body.set(tail, head.length + bytes.length);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
