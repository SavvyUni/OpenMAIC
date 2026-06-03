'use client';

import { useEffect, useState, ReactNode } from 'react';
import { AccessCodeModal } from '@/components/access-code-modal';

export function AccessCodeGuard({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<{
    enabled: boolean;
    authenticated: boolean;
    loading: boolean;
    mode: 'none' | 'access_code' | 'erp';
    redirectUrl?: string;
  }>({ enabled: false, authenticated: false, loading: true, mode: 'none' });

  useEffect(() => {
    let cancelled = false;

    const loadStatus = async () => {
      try {
        const response = await fetch('/api/access-code/status', { cache: 'no-store' });
        const data = await response.json();

        if (cancelled) {
          return;
        }

        if (data.mode === 'erp' && !data.authenticated) {
          const currentUrl = new URL(window.location.href);
          const erpToken = currentUrl.searchParams.get('erp_token');

          if (erpToken) {
            const bootstrapResponse = await fetch('/api/erp-auth/session', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: erpToken }),
            });
            const bootstrapResult = await bootstrapResponse.json().catch(() => ({}));

            if (bootstrapResponse.ok && bootstrapResult?.success) {
              currentUrl.searchParams.delete('erp_token');
              currentUrl.searchParams.delete('erp_ip');
              window.history.replaceState({}, '', currentUrl.toString());

              setStatus({
                enabled: true,
                authenticated: true,
                loading: false,
                mode: 'erp',
                redirectUrl: data.redirectUrl,
              });
              return;
            }
          }
        }

        setStatus({
          enabled: !!data.enabled,
          authenticated: !!data.authenticated,
          loading: false,
          mode: data.mode || 'none',
          redirectUrl: data.redirectUrl,
        });
      } catch {
        if (!cancelled) {
          // Default to requiring auth on error — safer than silently disabling
          setStatus({
            enabled: true,
            authenticated: false,
            loading: false,
            mode: 'erp',
          });
        }
      }
    };

    void loadStatus();

    return () => {
      cancelled = true;
    };
  }, []);

  const needsAccessCodeAuth =
    !status.loading && status.enabled && status.mode === 'access_code' && !status.authenticated;
  const needsErpAuth =
    !status.loading && status.enabled && status.mode === 'erp' && !status.authenticated;
  const canRenderChildren = !status.loading && !needsAccessCodeAuth && !needsErpAuth;

  return (
    <>
      {status.loading && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-white">
          <div className="text-sm text-slate-500">正在校验 ERP 登录状态...</div>
        </div>
      )}
      {needsAccessCodeAuth && (
        <AccessCodeModal
          open={true}
          onSuccess={() => setStatus((s) => ({ ...s, authenticated: true }))}
        />
      )}
      {needsErpAuth && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 px-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 text-center shadow-xl">
            <h2 className="text-lg font-semibold text-slate-900">ERP 登录已失效</h2>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              请从 ERP 课节页面重新进入 OpenMAIC，系统需要先校验你的 ERP 登录状态后才能使用。
            </p>
            {status.redirectUrl ? (
              <a
                href={status.redirectUrl}
                className="mt-5 inline-flex rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white"
              >
                返回 ERP
              </a>
            ) : null}
          </div>
        </div>
      )}
      {canRenderChildren ? children : null}
    </>
  );
}
