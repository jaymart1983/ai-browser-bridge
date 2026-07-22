// common-passwords.js
//
// A small blocklist of the most common / most-breached passwords. Used by
// validatePasswordPolicy() in crypto.js to reject predictable passwords, per
// NIST SP 800-63B guidance to screen candidate passwords against known-common
// values.
//
// This is intentionally a compact (~200 entry) list — a real deployment would
// screen against a much larger corpus (e.g. the HaveIBeenPwned k-anonymity
// range API or a multi-million-entry list). Entries are lowercased; the
// consumer lowercases + trims the candidate before checking membership.
//
// Exported as a Set for O(1) lookups.

const LIST = [
  '123456', 'password', '123456789', '12345678', '12345', '1234567',
  '1234567890', 'qwerty', 'abc123', 'password1', '111111', '123123',
  'admin', 'letmein', 'welcome', 'monkey', '1234', 'sunshine', 'iloveyou',
  'princess', 'dragon', 'passw0rd', 'football', 'baseball', 'superman',
  'trustno1', 'shadow', 'master', 'michael', 'jennifer', 'jordan',
  'hunter', 'harley', 'ranger', 'buster', 'thomas', 'robert', 'soccer',
  'batman', 'test', 'pass', 'killer', 'hockey', 'george', 'charlie',
  'andrew', 'michelle', 'love', 'jesus', 'ninja', 'mustang', 'password123',
  'starwars', 'computer', 'internet', 'freedom', 'whatever', 'qazwsx',
  'zxcvbn', 'asdfgh', 'asdfghjkl', 'qwertyuiop', 'qwerty123', '1q2w3e4r',
  '1qaz2wsx', 'zaq12wsx', 'q1w2e3r4', 'aaaaaa', 'aaaaaaaa', '000000',
  '654321', '666666', '696969', '121212', '112233', '123321', '789456',
  '987654321', '11111111', '00000000', 'abcd1234', 'abcdef', 'abcdefg',
  'iloveu', 'letmein1', 'admin123', 'root', 'toor', 'guest', 'default',
  'changeme', 'secret', 'access', 'money', 'lovely', 'flower', 'hello',
  'hello123', 'welcome1', 'welcome123', 'login', 'passwort', 'motdepasse',
  'football1', 'baseball1', 'starwars1', 'superman1', 'batman1', 'summer',
  'winter', 'spring', 'autumn', 'january', 'february', 'december',
  'monday', 'friday', 'nicole', 'daniel', 'babygirl', 'lovers', 'iloveyou1',
  'chocolate', 'cookie', 'maggie', 'ginger', 'samantha', 'ashley', 'bailey',
  'joshua', 'amanda', 'jessica', 'matthew', 'anthony', 'hannah', 'taylor',
  'tigger', 'pepper', 'snoopy', 'cheese', 'banana', 'orange', 'apple',
  'purple', 'yellow', 'orange1', 'silver', 'golden', 'diamond', 'crystal',
  'angel', 'angels', 'heaven', 'pokemon', 'gamer', 'minecraft', 'fortnite',
  'nintendo', 'playstation', 'xbox', 'google', 'facebook', 'twitter',
  'instagram', 'snapchat', 'youtube', 'linkedin', 'amazon', 'netflix',
  'spotify', 'yankees', 'cowboys', 'lakers', 'chelsea', 'arsenal',
  'liverpool', 'barcelona', 'realmadrid', 'juventus', 'pizza', 'coffee',
  'beer', 'whiskey', 'vodka', 'party', 'summer1', 'winter1', 'password12',
  'passw0rd1', 'p@ssw0rd', 'p@ssword', 'passw0rd!', 'admin1', 'test123',
  'test1234', 'user', 'user123', 'demo', 'sample', 'temp', 'temporary',
  'system', 'oracle', 'mysql', 'postgres', 'redhat', 'ubuntu', 'linux',
  'windows', 'microsoft', 'apple123', 'iphone', 'android', 'samsung',
  'nokia', 'blahblah', 'asdf', 'asdf1234', 'qwer1234', '1234qwer',
  'zaq1zaq1', 'q1w2e3', 'a1b2c3', 'a1b2c3d4', 'abc12345', 'password!',
  'letmein!', 'welcome!', 'money123', 'love123', 'iloveyou123',
];

export const COMMON_PASSWORDS = new Set(LIST.map((p) => p.toLowerCase()));
