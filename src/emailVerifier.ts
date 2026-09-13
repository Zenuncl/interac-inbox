export function verifyInteracSender(
  message: ForwardableEmailMessage,
  allowlist: string[],
): boolean {
  const fromDomain = message.from.split("@")[1]?.toLowerCase();
  if (!fromDomain || !allowlist.includes(fromDomain)) {
    return false;
  }

  const authResults = message.headers.get("authentication-results") ?? "";
  const hasDkim = authResults.includes("dkim=pass");
  const hasSpf = authResults.includes("spf=pass");

  return hasDkim && hasSpf;
}
