// Generic alert profile for the public build: a typical small home setup with
// Suricata and an OpenCanary honeypot. All addresses are made up and the rule
// list is a common starting point, not anybody's real configuration.
const CONFIG = {
  minSeverity: 2,
  ignoreSignatures: ['ET INFO', 'ET POLICY', 'GPL POLICY', 'SURICATA STREAM'],
  ignoreIps: ['10.0.0.10', '10.0.0.51'],
  rateLimit: { maxPerIp: 5, windowSeconds: 300 },
};
const NAS = '10.0.0.10';

const CANARY = { // OpenCanary's standard log types
  2000: ['FTP Login Attempt', 21], 3001: ['HTTP Login Attempt', 80], 4002: ['SSH Login Attempt', 22],
  6001: ['Telnet Login Attempt', 23], 8001: ['MySQL Login Attempt', 3306], 9001: ['MSSQL Login Attempt', 1433],
  12001: ['VNC Connection', 5900], 14001: ['RDP Connection', 3389], 17001: ['Redis Command', 6379],
};

const SURICATA = [ // [signature, severity, category, dest_port, src ('ext' | ip), dest]
  ['ET SCAN Potential SSH Scan', 2, 'Attempted Information Leak', 22, 'ext'],
  ['ET SCAN Suspicious inbound to mySQL port 3306', 2, 'Potentially Bad Traffic', 3306, 'ext'],
  ['ET EXPLOIT Possible CVE-2014-6271 Attempt in Headers', 1, 'Attempted Administrator Privilege Gain', 80, 'ext'],
  ['ET COMPROMISED Known Compromised or Hostile Host Traffic', 2, 'Misc Attack', 443, 'ext'],
  ['GPL SNMP public access udp', 2, 'Attempted Information Leak', 161, 'ext'],
  ['ET INFO Outgoing Basic Auth Base64 HTTP Password detected unencrypted', 1, 'Potential Corporate Privacy Violation', 80, '10.0.0.50', '10.0.0.20'],
  ['ET POLICY curl User-Agent Outbound', 3, 'Attempted Information Leak', 80, '10.0.0.50', '198.51.100.80'],
  ['ET INFO Observed DNS Query to .cloud TLD', 2, 'Potentially Bad Traffic', 53, '10.0.0.50', '10.0.0.10'],
  ['SURICATA STREAM excessive retransmissions', 3, 'Generic Protocol Command Decode', 443, 'ext'],
  ['ET USER_AGENTS Go HTTP Client User-Agent', 3, 'Misc activity', 80, 'ext'],
  ['ET SCAN Potential SSH Scan', 2, 'Attempted Information Leak', 22, '10.0.0.51'],
];

export default {
  CONFIG, NAS, CANARY, SURICATA,
  lanClient: '10.0.0.50', ownDevice: '10.0.0.51',
  street: 'the street', muter: 'the family', alerter: 'a typical home alerter',
};
