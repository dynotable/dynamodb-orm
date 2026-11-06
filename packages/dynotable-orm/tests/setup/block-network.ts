import net from 'node:net';

// http, https, tls and fetch all open their connection through net.Socket#connect.
net.Socket.prototype.connect = function blockedConnect(): never {
  throw new Error(
    'Network access is blocked in unit tests; use a stub client or tests/integration.'
  );
};
