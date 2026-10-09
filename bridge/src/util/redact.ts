// Defence in depth for text relayd forwards from Hermes (log lines, doctor output, CLI errors).
// Hermes already redacts its own logs; this catches the obvious shapes if something slips through.
const PATTERNS: [RegExp, string][] = [
  // Consume quoted values before line-based rules, including escaped delimiters and incomplete tails.
  [/\b((?:proxy[-_])?authorization|(?:set[-_])?cookie|x[-_]api[-_]key|[a-z][a-z0-9_-]*[_-](?:key|token|secret|password|passwd)(?:[_-][a-z0-9]+)*|api[_-]?key|accessToken|refreshToken|clientSecret|token|secret|password|passwd)(["']?\s*[:=]\s*)(?:"(?:\\(?:[\s\S]|$)|[^"\\])*(?:"|$)|'(?:\\(?:[\s\S]|$)|[^'\\])*(?:'|$))/gi, '$1$2***'],
  [/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*)(["']?\s*[:=]\s*)(?:"(?:\\(?:[\s\S]|$)|[^"\\])*(?:"|$)|'(?:\\(?:[\s\S]|$)|[^'\\])*(?:'|$))/g, '$1$2***'],
  // Header values can contain multiple credentials, schemes, cookies and folded lines.
  [/\b((?:proxy[-_])?authorization|(?:set[-_])?cookie|x[-_]api[-_]key)(["']?\s*[:=]\s*)[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/gi, '$1$2***'],
  [/\b([a-z][a-z0-9_-]*[_-](?:key|token|secret|password|passwd)(?:[_-][a-z0-9]+)*|api[_-]?key|accessToken|refreshToken|clientSecret|token|secret|password|passwd)(["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'&,;}]+)/gi, '$1$2***'],
  [/([?&](?:access_token|refresh_token|api_key|apikey|key|token|secret|password|code|signature|sig)=)[^&#\s"']*/gi, '$1***'],
  [/\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1***@'],
  // Webhook URLs carry their credential in the path.
  [/(\/api(?:\/v\d+)?\/webhooks\/)[^\s/]+\/[A-Za-z0-9_-]+/g, '$1***'],
  [/(hooks\.slack\.com\/(?:services|workflows|triggers)\/)[A-Za-z0-9/_-]+/g, '$1***'],
  [/\b(?:rly1_[A-Za-z0-9_-]+|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|ya29\.[A-Za-z0-9_-]{20,}|\d{6,}:[A-Za-z0-9_-]{20,})\b/g, '***'],
  // JWTs and Discord bot tokens carry no prefix; match their three-segment shape. Base64url may end in `-`.
  [/\b(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*|[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,})/g, '***'],
  // Discord channel and user IDs are personal data. ponytail: masks any 17-20 digit number (also ns timestamps).
  [/\b\d{17,20}\b/g, '***'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)/g, '***'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***'],
  [/\b(sk|pk|rk|ghp|gho|ghu|ghs|github_pat|xox[abprs]|tskey|glpat|AKIA)[-_][A-Za-z0-9_-]{16,}/g, '$1-***'],
  // Hugging Face and npm tokens: underscore then 34/36 alphanumerics; `npm-some-package` stays readable.
  [/\b(hf|npm)_[A-Za-z0-9]{30,}/g, '$1_***'],
  [
    /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*)\s*([=:])\s*["']?[^\s"']{6,}["']?/g,
    '$1$2***',
  ],
  [/\b(api[_-]?key|token|secret|password)(["']?\s*[=:]\s*["']?)[^\s"',}]{6,}/gi, '$1$2***'],
];

export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  // Encoded query parameter names still identify credentials; preserve unrelated URL text.
  out = out.replace(/([?&])([^=&#\s]+)=([^&#\s"']*)/g, (whole, separator, key) => {
    let decoded: string;
    try { decoded = decodeURIComponent(key); } catch { return whole; }
    return /^(?:.*[_-])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|key|token|secret|password|code|signature|sig)$/i.test(decoded) ? `${separator}${key}=***` : whole;
  });
  return out;
}
