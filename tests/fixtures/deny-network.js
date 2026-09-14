// Local synthetic regression preload. Never use this for a production runner.
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
const deny = () => { throw new Error('QA_REAL_NETWORK_DISABLED'); };
globalThis.fetch = deny;
net.Socket.prototype.connect = deny;
http.request = http.get = https.request = https.get = deny;
