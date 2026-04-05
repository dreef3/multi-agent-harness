export const webFetchTool = {
  name: "web_fetch",
  description: "Fetch a URL (HTTP GET/POST). Blocks private IPs.",
  inputSchema: {
    type: "object" as const,
    properties: {
      url: { type: "string" },
      method: { type: "string", enum: ["GET", "POST", "PUT"] },
      body: { type: "string" },
      headers: { type: "object" },
    },
    required: ["url"],
  },
  async execute(args: Record<string, unknown>, _context?: { projectId: string; sessionId?: string; role?: string }) {
    const { url, method, body, headers } = args as { url: string; method?: string; body?: string; headers?: Record<string, string> };
    const urlObj = new URL(url);
    const host = urlObj.hostname;
    // Block IPv4 private/loopback ranges
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|0\.|169\.254\.|localhost)/i.test(host)) {
      return { isError: true, content: [{ type: "text" as const, text: "Error: private/internal URLs are blocked" }] };
    }
    // Block IPv6 loopback (::1), IPv4-mapped IPv6 (::ffff:), bracketed IPv6 loopback ([::1])
    // and ULA (unique local addresses, fd prefix)
    if (
      host === "::1" ||
      host === "[::1]" ||
      /^::ffff:/i.test(host) ||
      /^\[::ffff:/i.test(host) ||
      /^fd[0-9a-f]{2}:/i.test(host) ||
      /^\[fd[0-9a-f]{2}:/i.test(host)
    ) {
      return { isError: true, content: [{ type: "text" as const, text: "Error: private/internal URLs are blocked" }] };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(url, {
        method: method ?? "GET",
        body: body,
        headers: headers as HeadersInit | undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      return { content: [{ type: "text" as const, text: text.slice(0, 200_000) }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Fetch error: ${(err as Error).message}` }] };
    } finally {
      clearTimeout(timer);
    }
  },
};
