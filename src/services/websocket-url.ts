const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const isLoopback = (hostname: string) => LOOPBACK_HOSTS.has(hostname.replace(/^\[|\]$/g, ""));

const stripBrackets = (hostname: string) => hostname.replace(/^\[|\]$/g, "");

export function resolveWebSocketUrl(configured: string | undefined, pageProtocol: string, pageHostname: string): string {
  const pageHost = stripBrackets(pageHostname);
  const formattedHost = pageHost.includes(":") ? `[${pageHost}]` : pageHost;
  if (!configured) {
    return `${pageProtocol === "https:" ? "wss:" : "ws:"}//${formattedHost}:8080/ws`;
  }
  const url = new URL(configured);
  const configuredHost = stripBrackets(url.hostname);
  if (isLoopback(configuredHost) && isLoopback(pageHost) && configuredHost !== pageHost) {
    url.hostname = formattedHost;
  }
  return url.toString();
}