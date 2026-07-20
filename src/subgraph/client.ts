export const DEFAULT_SUBGRAPH_BASE_URL = 'https://hub.orbs.network';

const SUBGRAPH_PATHS: {[chainId: string]: string} = {
    1: 'delegationsSubgraphEth',
    137: 'delegationsSubgraphPolygon'
};

export function normalizeSubgraphBaseUrl(baseUrl?: string): string {
    const value = String(baseUrl || DEFAULT_SUBGRAPH_BASE_URL).trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^/]+(?:\/.*)?$/i.test(value)) {
        throw new Error('Subgraph base URL must be an absolute HTTP(S) URL');
    }
    return value;
}

export function getSubgraphUrl(chainId: number, baseUrl?: string): string {
    const path = SUBGRAPH_PATHS[String(chainId)];
    if (!path) throw new Error(`Unsupported Subgraph chain id ${chainId}`);
    return `${normalizeSubgraphBaseUrl(baseUrl)}/${path}`;
}

function abortError(): Error {
    const error = new Error('Subgraph query aborted');
    error.name = 'AbortError';
    return error;
}

function assertNotAborted(signal?: AbortSignal): void {
    if (signal && signal.aborted) throw abortError();
}

export async function fetchSubgraphGraphQl(
    url: string,
    query: string,
    variables: any,
    signal?: AbortSignal
): Promise<any> {
    assertNotAborted(signal);
    const response = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({query, variables}),
        signal
    });
    assertNotAborted(signal);
    if (!response.ok) throw new Error(`Subgraph HTTP error ${response.status}`);
    const payload: any = await response.json();
    assertNotAborted(signal);
    if (payload.errors && payload.errors.length > 0) {
        throw new Error(`Subgraph GraphQL error: ${JSON.stringify(payload.errors)}`);
    }
    if (!payload.data) throw new Error('Subgraph response is missing data');
    return payload.data;
}
