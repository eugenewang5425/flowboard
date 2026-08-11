import net from "node:net";

import { appError } from "./database.mjs";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function assertLocalRequest(request) {
  const remote = normalizeRemote(request.socket?.remoteAddress);
  if (remote && !isLoopback(remote)) throw appError(403, "只允许本机访问", "LOCAL_ONLY");

  const hostHeader = String(request.headers.host || "").trim();
  if (!hostHeader) throw appError(400, "缺少 Host 请求头", "INVALID_HOST");
  const host = parseHost(hostHeader);
  if (!isLoopback(host.hostname)) throw appError(403, "Host 必须是本机回环地址", "INVALID_HOST");

  const originHeader = request.headers.origin;
  if (originHeader) {
    let origin;
    try { origin = new URL(originHeader); } catch { throw appError(403, "Origin 无效", "INVALID_ORIGIN"); }
    if (!isLoopback(origin.hostname) || origin.host.toLowerCase() !== hostHeader.toLowerCase()) {
      throw appError(403, "不允许跨来源访问本地服务", "INVALID_ORIGIN");
    }
  }
}

export function assertAllowedKeys(value, allowed, label = "请求") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw appError(400, `${label}必须是 JSON 对象`, "INVALID_BODY");
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw appError(400, `${label}包含未知字段：${unknown.join("、")}`, "UNKNOWN_FIELDS", { unknown });
  return value;
}

export function assertAllowedQuery(searchParams, allowed) {
  const unknown = [...new Set([...searchParams.keys()].filter((key) => !allowed.includes(key)))];
  if (unknown.length) throw appError(400, `查询包含未知参数：${unknown.join("、")}`, "UNKNOWN_QUERY", { unknown });
}

export async function readJson(request, { maxBytes = 1_048_576 } = {}) {
  const contentType = String(request.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType && contentType !== "application/json") {
    throw appError(415, "请求必须使用 application/json", "UNSUPPORTED_MEDIA_TYPE");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw appError(413, "请求内容过大", "PAYLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw appError(400, "JSON 格式无效", "INVALID_JSON");
  }
}

export function decodeRouteSegment(value) {
  try { return decodeURIComponent(value); } catch { throw appError(400, "URL 编码无效", "INVALID_URL"); }
}

function parseHost(host) {
  try { return new URL(`http://${host}`); } catch { throw appError(400, "Host 无效", "INVALID_HOST"); }
}

function normalizeRemote(value) {
  const remote = String(value || "").split("%", 1)[0];
  return remote.startsWith("::ffff:") ? remote.slice(7) : remote;
}

function isLoopback(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (LOOPBACK_HOSTS.has(host)) return true;
  return net.isIP(host) === 4 && host.startsWith("127.");
}
