const IPV4_REGEX =
    /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_REGEX = /^[0-9a-fA-F:]+$/;

function sanitizeClientIp(raw: string | null | undefined): string | null {
    if (!raw) return null;
    let candidate = raw.trim();
    if (!candidate || candidate.length > 128) return null;
    if (candidate.toLowerCase().startsWith('::ffff:')) {
        candidate = candidate.slice(7);
    }
    if (IPV4_REGEX.test(candidate)) {
        return candidate;
    }
    if (candidate.includes(':') && IPV6_REGEX.test(candidate)) {
        return candidate.toLowerCase();
    }
    return null;
}

export function buildBffForwardedHeaders(
    request: Request,
    extraHeaders?: Record<string, string>,
): Record<string, string> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...extraHeaders,
    };

    const rawXff = request.headers.get('x-forwarded-for');
    let clientIp: string | null = null;
    if (rawXff) {
        const hops = rawXff
            .split(',')
            .map((part) => sanitizeClientIp(part))
            .filter((ip): ip is string => ip !== null);
        if (hops.length > 0) {
            clientIp = hops[hops.length - 1];
        }
    }

    if (!clientIp) {
        clientIp = sanitizeClientIp(request.headers.get('x-real-ip'));
    }

    if (clientIp) {
        headers['X-Forwarded-For'] = clientIp;
    }

    const userAgent = request.headers.get('user-agent');
    if (userAgent) {
        headers['User-Agent'] = userAgent.slice(0, 512);
    }

    return headers;
}

export function extractRetryAfterHeaders(
    backendResponse: Response,
): HeadersInit | undefined {
    const retryAfter = backendResponse.headers.get('retry-after');
    if (!retryAfter) {
        return undefined;
    }
    return { 'Retry-After': retryAfter };
}

export async function parseBackendJson<T = Record<string, unknown>>(
    backendResponse: Response,
    fallbackMessage: string,
): Promise<T> {
    const text = await backendResponse.text();
    if (!text) {
        return {} as T;
    }
    try {
        return JSON.parse(text) as T;
    } catch {
        return { message: fallbackMessage } as unknown as T;
    }
}
