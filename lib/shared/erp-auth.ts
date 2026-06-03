export function isErpAuthEnabled(
  env: Record<string, string | undefined> = process.env,
) {
  return Boolean(env.ERP_API_BASE_URL?.trim());
}
