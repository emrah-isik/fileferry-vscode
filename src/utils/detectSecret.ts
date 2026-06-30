// Heuristic scan for a hard-coded secret inside a hook command string.
//
// This is DELIBERATELY advisory: it has false positives and false negatives and
// must never block a save. Its only job is to turn a silent footgun (a raw
// secret committed to fileferry.json) into a visible warning at authoring time,
// nudging the user toward $ENV_VAR / ${secret:…} references or the git-ignored
// fileferry.local.json. It is NOT a security boundary.

// A value that is purely an environment-variable or keychain reference is the
// SAFE path — never flag it. Matches $NAME, ${NAME}, ${secret:NAME}, and the
// same wrapped in one opening quote ("$NAME, '${...}).
function isVariableReference(value: string): boolean {
  return /^["']?\$\{?[A-Za-z_]/.test(value.trim());
}

// A captured value counts as a literal secret only when it's present and isn't
// a variable reference.
function isLiteralValue(value: string | undefined): value is string {
  return !!value && value.length > 0 && !isVariableReference(value);
}

export function detectSecret(command: string): boolean {
  if (!command || !command.trim()) {
    return false;
  }

  // 1. mysql/curl-style password flag with the value attached: -psecret.
  //    Require a credential-length value (>= 5 chars) so we don't flag combined
  //    short flags that merely start with p — `cp -pr`, `tar -pcf`, `rsync -prtv`
  //    all capture 1-4 trailing flag letters, not a secret.
  const attachedPassword = command.match(/(?:^|\s)-p(\S+)/);
  if (attachedPassword && attachedPassword[1].length >= 5 && isLiteralValue(attachedPassword[1])) {
    return true;
  }

  // 2. --password= / --password <value> / --pass= (long-form password flags).
  const longPassword = command.match(/--pass(?:word)?[=\s]+(\S+)/i);
  if (longPassword && isLiteralValue(longPassword[1])) {
    return true;
  }

  // 3. token=<value> / token:<value> (query-string or env-style assignment).
  const tokenAssignment = command.match(/\btoken[=:]\s*(\S+)/i);
  if (tokenAssignment && isLiteralValue(tokenAssignment[1])) {
    return true;
  }

  // 4. HTTP bearer header.
  const bearer = command.match(/Authorization:\s*Bearer\s+(\S+)/i);
  if (bearer && isLiteralValue(bearer[1])) {
    return true;
  }

  // 5. AWS access key id.
  if (/\bAKIA[0-9A-Z]{16}\b/.test(command)) {
    return true;
  }

  // 6. A standalone high-entropy blob — long, mixed upper/lower/digit. Requiring
  //    an uppercase letter deliberately excludes lowercase-hex git SHAs, which
  //    are common in deploy commands and aren't secrets.
  for (const word of command.split(/\s+/)) {
    const stripped = word.replace(/^["']|["']$/g, '');
    if (isVariableReference(stripped)) {
      continue;
    }
    if (
      /^[A-Za-z0-9+/_-]{24,}$/.test(stripped) &&
      /[A-Z]/.test(stripped) &&
      /[a-z]/.test(stripped) &&
      /[0-9]/.test(stripped)
    ) {
      return true;
    }
  }

  return false;
}
