// Gate UID accounts: members sign in with their Gate.io UID. Supabase Auth still needs an
// email, so a UID maps to a synthetic, never-mailed address on a reserved domain. The
// administrator (and any legacy account) keeps signing in with a real email.
export const UID_LOGIN_DOMAIN = 'uid.maetajak.trading';
const GATE_UID_PATTERN = /^\d{4,15}$/;
const SYNTHETIC_EMAIL_PATTERN = /^(\d{4,15})@uid\.maetajak\.trading$/i;

export function isValidGateUid(value) {
  return GATE_UID_PATTERN.test(String(value ?? '').trim());
}

// "아이디" field: a value containing '@' is an email, anything else is a Gate UID.
export function loginIdToEmail(value) {
  const id = String(value ?? '').trim();
  if (!id) return '';
  return id.includes('@') ? id : `${id}@${UID_LOGIN_DOMAIN}`;
}

export function uidFromEmail(email) {
  const match = SYNTHETIC_EMAIL_PATTERN.exec(String(email ?? '').trim());
  return match ? match[1] : '';
}

// What the admin UI shows instead of an email: the Gate UID when the account has one
// (profile column or synthetic auth email), otherwise the real email (admin / legacy).
export function accountDisplayId(gateUid, email) {
  const uid = String(gateUid ?? '').trim() || uidFromEmail(email);
  if (uid) return `UID ${uid}`;
  return String(email ?? '').trim();
}
