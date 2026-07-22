// pairing.mjs — one-time ECDH pairing between the bridge and the extension.
// After the user clicks "Link" in the popup, both sides derive a shared HMAC
// key; the bridge then signs every command frame it relays, and the extension
// only executes frames carrying a valid signature. This replaces the shared
// access code for the bridge↔extension trust (Phase 3 of the auth rework).

import { createECDH, createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { state, save } from './state.mjs';

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
function canon(frame) { return frame.id + '\n' + frame.method + '\n' + stableStringify(frame.params || {}); }

export function isPaired() { return !!(state.pairing && state.pairing.key); }
export function pairingStatus() { return { paired: isPaired(), created: (state.pairing && state.pairing.created) || 0 }; }

// Complete a pairing: given the extension's raw ECDH public key (hex), derive
// the shared secret and persist the HMAC key. Returns the bridge's public key.
export function pairInit(extPubHex) {
  const ecdh = createECDH('prime256v1');
  const pub = ecdh.generateKeys();
  const shared = ecdh.computeSecret(Buffer.from(extPubHex, 'hex'));
  const key = createHash('sha256').update(shared).digest('hex');
  state.pairing = { key, paired: true, created: Date.now() };
  save();
  return pub.toString('hex');
}

export function unpair() { state.pairing = null; save(); }

// Sign a command frame the bridge is about to relay to the extension.
export function signFrame(frame) {
  if (!isPaired()) return frame;
  frame.mac = createHmac('sha256', Buffer.from(state.pairing.key, 'hex')).update(canon(frame)).digest('hex');
  return frame;
}

// Verify a mac the extension attached (e.g. on replies) — currently unused on
// the bridge side but exported for symmetry / future hardening.
export function verifyMac(frame) {
  if (!isPaired() || !frame.mac) return false;
  const expect = createHmac('sha256', Buffer.from(state.pairing.key, 'hex')).update(canon(frame)).digest('hex');
  try { return timingSafeEqual(Buffer.from(frame.mac), Buffer.from(expect)); } catch { return false; }
}
