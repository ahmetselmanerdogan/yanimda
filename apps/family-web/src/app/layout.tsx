import './globals.css';

import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { t } from '@/lib/i18n';

import { themeCss } from './theme';

export const metadata: Metadata = { title: t('F-WEB-TITLE') };
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="tr">
      <head>
        <style>{themeCss()}</style>
      </head>
      <body>
        <header className="top">
          <Link href="/kayit">{t('F-WEB-TITLE')}</Link>
          <Link href="/hesap">{t('F-WEB-ACCOUNT-PAGE')}</Link>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
