const net = require('net');

const isValidIpv4 = (ip) => /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(ip);
const isValidIpv6 = (ip) => net.isIP(ip) === 6;
const isValidIp = (ip) => net.isIP(ip) !== 0;

const normalizeIp = (ip) => {
  if (!ip) return '';
  if (ip.startsWith('::ffff:')) return ip.substring(7);
  return ip;
};

const IP_HEADERS = [
  'cf-connecting-ip',
  'true-client-ip',
  'tencent-client-ip',
  'ali-cdn-real-ip',
  'eo-connecting-ip',
  'x-real-ip'
];

const getHeader = (headers, name) => {
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()];
};

const getClientIp = (req) => {
  const headers = req.headers || {};
  
  for (const header of IP_HEADERS) {
    const value = getHeader(headers, header);
    if (value) {
      const normalized = normalizeIp(value.trim());
      if (isValidIp(normalized)) return normalized;
    }
  }

  const xff = getHeader(headers, 'x-forwarded-for');
  if (xff) {
    const firstIp = xff.split(',')[0];
    if (firstIp) {
      const normalized = normalizeIp(firstIp.trim());
      if (isValidIp(normalized)) return normalized;
    }
  }

  const remoteIp = req.connection?.remoteAddress || req.socket?.remoteAddress;
  if (remoteIp) {
    const normalized = normalizeIp(remoteIp);
    if (isValidIp(normalized)) return normalized;
  }

  return null;
};

const expandIpv6 = (address) => {
  if (!isValidIpv6(address)) return null;
  if (address.includes('::')) {
    const parts = address.split('::');
    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts[1] ? parts[1].split(':') : [];
    const missing = 8 - (left.length + right.length);
    const middle = new Array(missing).fill('0');
    const full = [...left, ...middle, ...right].map(h => h || '0');
    return full.map(h => h.padStart(4, '0')).join(':');
  }
  return address.split(':').map(h => h.padStart(4, '0')).join(':');
};

const ipToSubnet = (ip) => {
  ip = normalizeIp(ip);
  if (!isValidIp(ip)) return null;
  if (isValidIpv4(ip)) {
    const parts = ip.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  if (isValidIpv6(ip)) {
    const full = expandIpv6(ip);
    if (!full) return null;
    const hextets = full.split(':');
    return `${hextets.slice(0, 4).join(':')}:0000:0000:0000:0000/64`;
  }
  return null;
};

const getAggregatedIdentity = (ip) => {
  ip = normalizeIp(ip);
  if (isValidIpv6(ip)) {
    const subnet = ipToSubnet(ip);
    return subnet || ip;
  }
  return ip;
};

module.exports = {
  isValidIpv4,
  isValidIpv6,
  isValidIp,
  normalizeIp,
  getClientIp,
  expandIpv6,
  ipToSubnet,
  getAggregatedIdentity
};
