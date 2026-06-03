export function getErpApiConfig() {
  const baseUrl = process.env.ERP_API_BASE_URL?.trim();

  if (!baseUrl) {
    throw new Error('ERP_API_BASE_URL is not configured');
  }

  return {
    baseUrl: baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`,
  };
}

export function buildErpApiUrl(pathname: string) {
  const { baseUrl } = getErpApiConfig();
  const normalizedPathname = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  return new URL(normalizedPathname, baseUrl).toString();
}

export function buildErpApiHeaders(
  headers: Record<string, string> = {},
  bearerToken?: string | null,
) {
  const result = { ...headers };
  const normalizedToken = bearerToken?.trim();
  const serviceApiKey = process.env.ERP_SERVICE_API_KEY?.trim();

  if (normalizedToken) {
    result.Authorization = `Bearer ${normalizedToken}`;
    return result;
  }

  if (serviceApiKey) {
    result['x-api-key'] = serviceApiKey;
  }

  return result;
}
