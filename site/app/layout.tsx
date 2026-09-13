import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { normalizeIcpLicense, SiteComplianceFooter } from '@/components/site/SiteComplianceFooter';
import './globals.css';
import './semantic-models.css';
// Shared studio palette follows the feature styles so chrome stays consistent.
import './studio-theme.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'DataCanvas AI｜AI 数据产品工作室',
  description: '通过自然语言、可视化画布与结构化变更集，把原始数据转化为可信、可发布的数据产品。',
  icons: {
    icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }],
    shortcut: '/favicon.svg',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const icpLicense = normalizeIcpLicense(process.env.NEXT_PUBLIC_ICP_LICENSE);
  return (
    <html lang="zh-CN">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased${icpLicense ? ' has-site-compliance-footer' : ''}`}
      >
        {children}
        <SiteComplianceFooter license={icpLicense ?? undefined} />
      </body>
    </html>
  );
}
